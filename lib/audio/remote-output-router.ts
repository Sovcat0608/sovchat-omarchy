"use client";

import { Track, type RemoteAudioTrack } from "livekit-client";
import {
  STABLE_MAX_OUTPUT_VOLUME,
  STABLE_MAX_PARTICIPANT_VOLUME,
  STABLE_MAX_STREAM_VOLUME,
  getConcreteAudioDeviceId
} from "@/lib/audio/audio-modes";
import type { RemoteOutputPreferences } from "@/lib/audio/audio-types";

type ManagedAudioElement = HTMLAudioElement & {
  sinkId?: string;
  setSinkId?: (deviceId: string) => Promise<void>;
};

type OutputAudioContext = AudioContext & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

type BoostedAudioRecord = {
  track: RemoteAudioTrack;
  gainNode: GainNode;
  limiterNode: DynamicsCompressorNode;
};

type ElementOutputState = {
  sinkId: string;
  pendingSinkId: string | null;
  volume: number;
  muted: boolean;
};

type AudioContextWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};

const BOOST_GAIN_SMOOTHING_SECONDS = 0.03;
const LIMITER_THRESHOLD_DB = -3;
const LIMITER_KNEE_DB = 2;
const LIMITER_RATIO = 20;
const LIMITER_ATTACK_SECONDS = 0.003;
const LIMITER_RELEASE_SECONDS = 0.12;
const OUTPUT_VOLUME_EPSILON = 0.001;

function clampUnit(value: number) {
  return Math.max(0, Math.min(1, value));
}

function getStableFactor(value: number, max: number) {
  return Math.max(0, Math.min(max, value));
}

function getElementSinkId(audioElement: ManagedAudioElement) {
  return typeof audioElement.sinkId === "string" ? audioElement.sinkId : "";
}

export class RemoteOutputRouter {
  private records = new Map<HTMLAudioElement, RemoteAudioTrack>();
  private boostedRecords = new Map<HTMLAudioElement, BoostedAudioRecord>();
  private elementOutputStates = new Map<HTMLAudioElement, ElementOutputState>();
  private audioContext: OutputAudioContext | null = null;
  private boostedContextSinkId = "";
  private boostedContextPendingSinkId: string | null = null;

  constructor(private readonly getContainer: () => HTMLDivElement | null) {}

  get elementCount() {
    return this.records.size;
  }

  attach(
    track: RemoteAudioTrack,
    participantIdentity: string,
    source: Track.Source,
    preferences: RemoteOutputPreferences
  ) {
    this.detachParticipant(participantIdentity, source);

    const audioElement = track.attach() as ManagedAudioElement;
    audioElement.autoplay = true;
    audioElement.dataset.participant = participantIdentity;
    audioElement.dataset.trackSource = source;
    this.records.set(audioElement, track);
    this.getContainer()?.appendChild(audioElement);
    this.apply(preferences);

    void audioElement.play().catch((error) => {
      console.warn("[sovchat:audio] Remote audio playback failed.", {
        participantIdentity,
        source,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  }

  apply(preferences: RemoteOutputPreferences) {
    const concreteOutputId = getConcreteAudioDeviceId(preferences.selectedOutputId);

    for (const [audioElement, track] of this.records.entries()) {
      const participantIdentity = audioElement.dataset.participant ?? "";
      const participantVolumeKey =
        preferences.participantVolumeKeys[participantIdentity] ?? participantIdentity;
      const isStreamTrack = audioElement.dataset.trackSource === Track.Source.ScreenShareAudio;
      const participantMuted =
        preferences.thirdPartyMutedIds.has(participantVolumeKey) ||
        preferences.thirdPartyMutedIds.has(participantIdentity);
      const participantVolume = getStableFactor(
        preferences.participantVolumes[participantVolumeKey] ??
          preferences.participantVolumes[participantIdentity] ??
          1,
        STABLE_MAX_PARTICIPANT_VOLUME
      );
      const baseMuted = isStreamTrack ? preferences.streamMuted : preferences.outputMuted;
      const baseVolume = getStableFactor(
        isStreamTrack ? preferences.streamVolume : preferences.outputVolume,
        isStreamTrack ? STABLE_MAX_STREAM_VOLUME : STABLE_MAX_OUTPUT_VOLUME
      );
      const requestedGain = baseMuted || participantMuted ? 0 : baseVolume * participantVolume;
      this.applyElementOutput(audioElement, track, requestedGain);

      if (preferences.outputSupported && typeof audioElement.setSinkId === "function") {
        this.applyElementSink(audioElement, concreteOutputId, participantIdentity);
      }

      const boostedRecord = this.boostedRecords.get(audioElement);
      if (
        boostedRecord &&
        preferences.outputSupported &&
        this.audioContext?.setSinkId &&
        this.audioContext.state !== "closed"
      ) {
        this.applyBoostedContextSink(concreteOutputId || "", audioElement, participantIdentity);
      }
    }
  }

  private getElementOutputState(audioElement: ManagedAudioElement): ElementOutputState {
    const existing = this.elementOutputStates.get(audioElement);
    if (existing) {
      return existing;
    }

    const state = {
      sinkId: getElementSinkId(audioElement),
      pendingSinkId: null,
      volume: audioElement.volume,
      muted: audioElement.muted
    };
    this.elementOutputStates.set(audioElement, state);
    return state;
  }

  private setElementPlaybackState(
    audioElement: ManagedAudioElement,
    volume: number,
    muted: boolean
  ) {
    const state = this.getElementOutputState(audioElement);

    if (Math.abs(state.volume - volume) > OUTPUT_VOLUME_EPSILON) {
      audioElement.volume = volume;
      state.volume = volume;
    }

    if (state.muted !== muted) {
      audioElement.muted = muted;
      state.muted = muted;
    }
  }

  private applyElementSink(
    audioElement: ManagedAudioElement,
    sinkId: string,
    participantIdentity: string
  ) {
    const state = this.getElementOutputState(audioElement);
    const activeSinkId = state.pendingSinkId ?? state.sinkId;

    if (activeSinkId === sinkId) {
      return;
    }

    state.pendingSinkId = sinkId;
    void audioElement
      .setSinkId?.(sinkId)
      .then(() => {
        if (!this.records.has(audioElement)) {
          return;
        }

        const nextState = this.getElementOutputState(audioElement);
        nextState.sinkId = sinkId;
        nextState.pendingSinkId = null;
      })
      .catch((error) => {
        if (!this.records.has(audioElement)) {
          return;
        }

        const nextState = this.getElementOutputState(audioElement);
        nextState.sinkId = getElementSinkId(audioElement);
        nextState.pendingSinkId = null;
        console.warn("[sovchat:audio] Remote audio output device switch failed.", {
          participantIdentity,
          source: audioElement.dataset.trackSource ?? null,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  private applyBoostedContextSink(
    sinkId: string,
    audioElement: HTMLAudioElement,
    participantIdentity: string
  ) {
    const activeSinkId = this.boostedContextPendingSinkId ?? this.boostedContextSinkId;

    if (activeSinkId === sinkId) {
      return;
    }

    const audioContext = this.audioContext;
    if (!audioContext?.setSinkId || audioContext.state === "closed") {
      return;
    }

    this.boostedContextPendingSinkId = sinkId;
    void audioContext
      .setSinkId(sinkId)
      .then(() => {
        if (this.audioContext !== audioContext || audioContext.state === "closed") {
          if (this.audioContext === audioContext) {
            this.boostedContextPendingSinkId = null;
          }
          return;
        }

        this.boostedContextSinkId = sinkId;
        this.boostedContextPendingSinkId = null;
      })
      .catch((error) => {
        if (this.audioContext !== audioContext) {
          return;
        }

        this.boostedContextPendingSinkId = null;
        console.warn("[sovchat:audio] Boosted remote audio output device switch failed.", {
          participantIdentity,
          source: audioElement.dataset.trackSource ?? null,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  private applyElementOutput(
    audioElement: HTMLAudioElement,
    track: RemoteAudioTrack,
    gain: number
  ) {
    const needsBoost = gain > 1;
    if (needsBoost) {
      const boostedRecord = this.ensureBoostedRecord(audioElement, track);

      if (boostedRecord) {
        this.setElementPlaybackState(audioElement, 0, true);
        this.applyBoostedGain(boostedRecord, gain);
        void this.audioContext?.resume().catch(() => undefined);
        return;
      }
    } else {
      this.releaseBoostedRecord(audioElement);
    }

    const finalVolume = clampUnit(gain);
    this.setElementPlaybackState(audioElement, finalVolume, finalVolume <= 0);
  }

  private ensureBoostedRecord(audioElement: HTMLAudioElement, track: RemoteAudioTrack) {
    const existing = this.boostedRecords.get(audioElement);
    if (existing) {
      return existing;
    }

    const AudioContextConstructor =
      typeof window !== "undefined"
        ? window.AudioContext ?? (window as AudioContextWindow).webkitAudioContext
        : undefined;
    if (!AudioContextConstructor) {
      return null;
    }

    const audioContext =
      this.audioContext && this.audioContext.state !== "closed"
        ? this.audioContext
        : new AudioContextConstructor();
    this.audioContext = audioContext as OutputAudioContext;

    try {
      const gainNode = audioContext.createGain();
      const limiterNode = audioContext.createDynamicsCompressor();

      gainNode.gain.value = 1;
      limiterNode.threshold.value = LIMITER_THRESHOLD_DB;
      limiterNode.knee.value = LIMITER_KNEE_DB;
      limiterNode.ratio.value = LIMITER_RATIO;
      limiterNode.attack.value = LIMITER_ATTACK_SECONDS;
      limiterNode.release.value = LIMITER_RELEASE_SECONDS;

      track.setWebAudioPlugins([gainNode, limiterNode]);
      track.setAudioContext(audioContext);
      track.setVolume(1);
      this.setElementPlaybackState(audioElement, 0, true);
      const record = { track, gainNode, limiterNode };
      this.boostedRecords.set(audioElement, record);
      return record;
    } catch (error) {
      console.warn("[sovchat:audio] Remote audio boost path unavailable.", {
        participantIdentity: audioElement.dataset.participant ?? null,
        source: audioElement.dataset.trackSource ?? null,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  private applyBoostedGain(record: BoostedAudioRecord, gain: number) {
    const audioContext = this.audioContext;
    if (!audioContext || audioContext.state === "closed") {
      record.gainNode.gain.value = gain;
      return;
    }

    record.gainNode.gain.setTargetAtTime(
      gain,
      audioContext.currentTime,
      BOOST_GAIN_SMOOTHING_SECONDS
    );
  }

  private releaseBoostedRecord(audioElement: HTMLAudioElement) {
    const record = this.boostedRecords.get(audioElement);
    if (!record) {
      return;
    }

    record.track.setVolume(1);
    record.track.setWebAudioPlugins([]);
    record.track.setAudioContext(undefined);
    this.boostedRecords.delete(audioElement);
  }

  detachTrack(track: RemoteAudioTrack) {
    track.detach().forEach((element) => {
      const audioElement = element as HTMLAudioElement;
      this.releaseBoostedRecord(audioElement);
      this.records.delete(audioElement);
      this.elementOutputStates.delete(audioElement);
      audioElement.remove();
    });
  }

  detachParticipant(participantIdentity: string, source?: Track.Source) {
    for (const audioElement of Array.from(this.records.keys())) {
      if (audioElement.dataset.participant !== participantIdentity) {
        continue;
      }

      if (source && audioElement.dataset.trackSource !== source) {
        continue;
      }

      const track = this.records.get(audioElement);
      track?.detach(audioElement);
      this.releaseBoostedRecord(audioElement);
      this.records.delete(audioElement);
      this.elementOutputStates.delete(audioElement);
      audioElement.remove();
    }
  }

  clear() {
    for (const [audioElement, track] of this.records.entries()) {
      track.detach(audioElement);
      this.releaseBoostedRecord(audioElement);
      this.elementOutputStates.delete(audioElement);
      audioElement.remove();
    }
    this.records.clear();
    this.elementOutputStates.clear();
    void this.audioContext?.close().catch(() => undefined);
    this.audioContext = null;
    this.boostedContextSinkId = "";
    this.boostedContextPendingSinkId = null;
  }
}
