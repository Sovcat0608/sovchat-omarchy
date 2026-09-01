"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Dock,
  Headphones,
  HeadphoneOff,
  Maximize2,
  Minimize2,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  X
} from "lucide-react";
import {
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  type RemoteAudioTrack,
  type RemoteVideoTrack
} from "livekit-client";
import { apiFetch } from "@/lib/api-client";
import {
  getDesktopBridge,
  type DesktopStreamPopoutCommand,
  type DesktopStreamPopoutVoiceState
} from "@/lib/desktop";
import { resolveLiveKitServerUrl } from "@/lib/livekit-client-endpoint";
import { installLiveKitClientDiagnostics } from "@/lib/livekit-client-diagnostics";
import { getLiveKitErrorMessage } from "@/lib/livekit-client-error-details";
import type { LiveKitTokenResponse } from "@/types";

type PopoutStatus = "connecting" | "waiting" | "watching" | "error";

const fallbackLiveKitUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL ?? "";

function clampVolume(value: number) {
  if (!Number.isFinite(value)) {
    return 100;
  }

  return Math.max(0, Math.min(200, Math.round(value)));
}

function isTargetScreenPublication(publication: RemoteTrackPublication) {
  return (
    publication.source === Track.Source.ScreenShare ||
    publication.source === Track.Source.ScreenShareAudio
  );
}

export function DesktopStreamPopout() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const roomRef = useRef<Room | null>(null);
  const videoTrackRef = useRef<RemoteVideoTrack | null>(null);
  const audioTrackRef = useRef<RemoteAudioTrack | null>(null);
  const hideDockTimeoutRef = useRef(0);
  const [status, setStatus] = useState<PopoutStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [dockVisible, setDockVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [voiceState, setVoiceState] = useState<DesktopStreamPopoutVoiceState | null>(null);
  const [webStreamMuted, setWebStreamMuted] = useState(false);
  const [webStreamVolume, setWebStreamVolume] = useState(100);
  const isDesktopPopout = Boolean(getDesktopBridge()?.isDesktop);

  const searchParams = useMemo(() => {
    if (typeof window === "undefined") {
      return new URLSearchParams();
    }

    return new URLSearchParams(window.location.search);
  }, []);
  const streamIdentity = searchParams.get("streamIdentity")?.trim() ?? "";
  const streamLabel = searchParams.get("streamLabel")?.trim() || "Stream";

  const showDockSoon = useCallback(() => {
    setDockVisible(true);

    if (hideDockTimeoutRef.current) {
      window.clearTimeout(hideDockTimeoutRef.current);
    }

    hideDockTimeoutRef.current = window.setTimeout(() => setDockVisible(false), 3000);
  }, []);

  const sendCommand = useCallback((command: DesktopStreamPopoutCommand) => {
    const desktopBridge = getDesktopBridge();
    void desktopBridge?.sendStreamPopoutCommand?.(command);
  }, []);

  const effectiveVolume = isDesktopPopout
    ? clampVolume((voiceState?.streamVolume ?? 1) * 100)
    : webStreamVolume;
  const isStreamMuted = isDesktopPopout
    ? Boolean(voiceState?.streamMuted) || effectiveVolume <= 0
    : webStreamMuted || effectiveVolume <= 0;

  const attachVideoTrack = useCallback((track: RemoteVideoTrack) => {
    const videoElement = videoRef.current;
    if (!videoElement) {
      return;
    }

    videoTrackRef.current?.detach(videoElement);
    videoTrackRef.current = track;
    track.attach(videoElement);
    videoElement.play().catch(() => undefined);
    setStatus("watching");
  }, []);

  const attachAudioTrack = useCallback((track: RemoteAudioTrack) => {
    const audioElement = audioRef.current;
    if (!audioElement) {
      return;
    }

    audioTrackRef.current?.detach(audioElement);
    audioTrackRef.current = track;
    track.attach(audioElement);
    audioElement.play().catch(() => undefined);
  }, []);

  const syncPublicationSubscriptions = useCallback(
    (participant: RemoteParticipant) => {
      const isTarget = participant.identity === streamIdentity;

      for (const publication of participant.trackPublications.values()) {
        const shouldSubscribe = isTarget && isTargetScreenPublication(publication);
        if (publication.isDesired !== shouldSubscribe) {
          publication.setSubscribed(shouldSubscribe);
        }
        if (publication.isEnabled !== shouldSubscribe) {
          publication.setEnabled(shouldSubscribe);
        }
      }
    },
    [streamIdentity]
  );

  useEffect(() => {
    const audioElement = audioRef.current;
    if (!audioElement) {
      return;
    }

    audioElement.muted = isStreamMuted;
    audioElement.volume = isStreamMuted ? 0 : Math.min(1, effectiveVolume / 100);
  }, [effectiveVolume, isStreamMuted]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
      showDockSoon();
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    showDockSoon();

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      if (hideDockTimeoutRef.current) {
        window.clearTimeout(hideDockTimeoutRef.current);
      }
    };
  }, [showDockSoon]);

  useEffect(() => {
    const desktopBridge = getDesktopBridge();
    if (!desktopBridge?.subscribeStreamPopoutVoiceState) {
      return;
    }

    return desktopBridge.subscribeStreamPopoutVoiceState((state) => {
      setVoiceState(state);
    });
  }, []);

  useEffect(() => {
    installLiveKitClientDiagnostics();

    let active = true;
    let nextRoom: Room | null = null;

    async function connectPopout() {
      if (!streamIdentity) {
        throw new Error("No stream was selected.");
      }

      const response = await apiFetch("/api/livekit/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "stream-popout" })
      });
      const payload = (await response.json().catch(() => null)) as
        | (LiveKitTokenResponse & { error?: string })
        | null;

      if (!response.ok) {
        throw new Error(payload?.error ?? "Unable to open stream popout.");
      }

      if (!payload) {
        throw new Error("Stream popout token response was empty.");
      }

      const serverUrl = resolveLiveKitServerUrl(payload.serverUrl, fallbackLiveKitUrl);

      nextRoom = new Room({
        adaptiveStream: false,
        dynacast: false
      });
      roomRef.current = nextRoom;
      nextRoom.on(RoomEvent.Disconnected, () => {
        setStatus("error");
        setError("The popout disconnected from the voice room.");
      });
      nextRoom.on(RoomEvent.ParticipantConnected, syncPublicationSubscriptions);
      nextRoom.on(RoomEvent.TrackPublished, (publication, participant) => {
        if (participant instanceof RemoteParticipant) {
          syncPublicationSubscriptions(participant);
        }
      });
      nextRoom.on(
        RoomEvent.TrackSubscribed,
        (track: RemoteTrack, _publication, participant: RemoteParticipant) => {
          if (participant.identity !== streamIdentity) {
            return;
          }

          if (track.kind === Track.Kind.Video) {
            attachVideoTrack(track as RemoteVideoTrack);
            return;
          }

          if (track.kind === Track.Kind.Audio) {
            attachAudioTrack(track as RemoteAudioTrack);
          }
        }
      );
      nextRoom.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
        if (track.kind === Track.Kind.Video && videoRef.current) {
          (track as RemoteVideoTrack).detach(videoRef.current);
          videoTrackRef.current = null;
          setStatus("waiting");
        }

        if (track.kind === Track.Kind.Audio && audioRef.current) {
          (track as RemoteAudioTrack).detach(audioRef.current);
          audioTrackRef.current = null;
        }
      });
      nextRoom.on(RoomEvent.ParticipantDisconnected, (participant) => {
        if (participant.identity === streamIdentity) {
          setStatus("waiting");
        }
      });

      await nextRoom.connect(serverUrl, payload.token, { autoSubscribe: false });

      if (!active) {
        nextRoom.disconnect();
        return;
      }

      const targetParticipant = nextRoom.remoteParticipants.get(streamIdentity);
      if (targetParticipant) {
        syncPublicationSubscriptions(targetParticipant);
      }

      setStatus("waiting");
    }

    connectPopout().catch((caughtError) => {
      setStatus("error");
      setError(getLiveKitErrorMessage(caughtError, "Unable to open stream popout."));
    });

    return () => {
      active = false;
      if (videoRef.current && videoTrackRef.current) {
        videoTrackRef.current.detach(videoRef.current);
      }
      if (audioRef.current && audioTrackRef.current) {
        audioTrackRef.current.detach(audioRef.current);
      }
      nextRoom?.disconnect();
      roomRef.current = null;
      videoTrackRef.current = null;
      audioTrackRef.current = null;
    };
  }, [attachAudioTrack, attachVideoTrack, streamIdentity, syncPublicationSubscriptions]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }

    void document.documentElement.requestFullscreen().catch(() => undefined);
  };

  return (
    <main
      className="relative h-screen w-screen overflow-hidden bg-[#05090a] text-white"
      onMouseMove={showDockSoon}
    >
      <video
        ref={videoRef}
        className="h-full w-full bg-[#05090a] object-contain"
        playsInline
        autoPlay
      />
      <audio ref={audioRef} autoPlay />

      {status !== "watching" ? (
        <div className="absolute inset-0 flex items-center justify-center bg-[rgba(5,9,10,0.74)] px-6 text-center">
          <div className="max-w-md rounded-lg border border-white/10 bg-[rgba(19,35,39,0.88)] p-5 shadow-[0_24px_80px_rgba(0,0,0,0.34)]">
            <p className="text-sm uppercase tracking-[0.24em] text-[#ffca2a]">{streamLabel}</p>
            <h1 className="mt-2 text-xl font-semibold">
              {status === "error" ? "Popout failed" : "Waiting for stream"}
            </h1>
            <p className="mt-3 text-sm leading-6 text-white/72">
              {status === "error"
                ? error
                : status === "connecting"
                  ? "Connecting to the room..."
                  : "The stream will appear here when the video track is ready."}
            </p>
          </div>
        </div>
      ) : null}

      <div
        className={[
          "absolute bottom-4 left-1/2 flex w-[min(calc(100vw-32px),680px)] -translate-x-1/2 items-center gap-3 rounded-lg border border-white/10 bg-[rgba(12,20,23,0.84)] px-3 py-2.5 shadow-[0_18px_42px_rgba(0,0,0,0.34),inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-xl transition duration-200",
          dockVisible ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
        ].join(" ")}
      >
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-white/88">
          {voiceState?.streamLabel ?? streamLabel}
        </span>
        {isDesktopPopout ? (
          <>
            <button
              type="button"
              className={[
                "inline-flex h-9 w-9 items-center justify-center rounded-full border transition",
                voiceState?.inputMuted
                  ? "border-[rgba(255,123,123,0.34)] bg-[rgba(255,123,123,0.16)] text-[#ff7b7b] hover:bg-[rgba(255,123,123,0.22)]"
                  : "border-white/10 bg-white/5 text-white hover:bg-white/10"
              ].join(" ")}
              onClick={() => sendCommand("toggle-input-muted")}
              aria-label={voiceState?.inputMuted ? "Unmute microphone" : "Mute microphone"}
              title={voiceState?.inputMuted ? "Unmute microphone" : "Mute microphone"}
            >
              {voiceState?.inputMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </button>
            <button
              type="button"
              className={[
                "inline-flex h-9 w-9 items-center justify-center rounded-full border transition",
                voiceState?.outputMuted
                  ? "border-[rgba(255,123,123,0.34)] bg-[rgba(255,123,123,0.16)] text-[#ff7b7b] hover:bg-[rgba(255,123,123,0.22)]"
                  : "border-white/10 bg-white/5 text-white hover:bg-white/10"
              ].join(" ")}
              onClick={() => sendCommand("toggle-output-muted")}
              aria-label={voiceState?.outputMuted ? "Undeafen" : "Deafen"}
              title={voiceState?.outputMuted ? "Undeafen" : "Deafen"}
            >
              {voiceState?.outputMuted ? (
                <HeadphoneOff className="h-4 w-4" />
              ) : (
                <Headphones className="h-4 w-4" />
              )}
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white transition hover:bg-white/10"
          onClick={() => {
            if (isDesktopPopout) {
              sendCommand({ type: "set-stream-muted", value: !isStreamMuted });
            } else {
              setWebStreamMuted((current) => !current);
            }
          }}
          aria-label={isStreamMuted ? "Unmute stream" : "Mute stream"}
        >
          {isStreamMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </button>
        <input
          className="w-[120px] accent-[#ffca2a]"
          type="range"
          min={0}
          max={200}
          step={1}
          value={effectiveVolume}
          aria-label="Stream volume"
          onChange={(event) => {
            const nextVolume = clampVolume(Number(event.target.value));
            if (isDesktopPopout) {
              sendCommand({
                type: "set-stream-volume",
                value: nextVolume / 100
              });
            } else {
              setWebStreamVolume(nextVolume);
            }
          }}
        />
        {isDesktopPopout ? (
          <button
            type="button"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white transition hover:bg-white/10"
            onClick={() => sendCommand("pop-back-in")}
            aria-label="Pop back in"
            title="Pop back in"
          >
            <Dock className="h-4 w-4" />
          </button>
        ) : null}
        <button
          type="button"
          className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white transition hover:bg-white/10"
          onClick={toggleFullscreen}
          aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
        >
          {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
        <button
          type="button"
          className="inline-flex h-9 w-9 items-center justify-center rounded-full border border-[rgba(255,123,123,0.28)] bg-[rgba(255,123,123,0.12)] text-[#ff8b8b] transition hover:bg-[rgba(255,123,123,0.2)]"
          onClick={() => {
            if (isDesktopPopout) {
              sendCommand("stop-watching");
            } else {
              window.close();
            }
          }}
          aria-label="Stop watching"
          title="Stop watching"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </main>
  );
}
