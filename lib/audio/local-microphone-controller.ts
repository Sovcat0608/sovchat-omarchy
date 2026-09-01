"use client";

import type { SovChatAudioMode, SovChatAudioProfile } from "@/lib/audio/audio-types";
import { getConcreteAudioDeviceId } from "@/lib/audio/audio-modes";

export type BuildMicrophoneCaptureOptions = {
  selectedInputId: string;
  mode: SovChatAudioMode;
  profile: SovChatAudioProfile;
  noiseFilterEnabled: boolean;
  krispActive: boolean;
};

type VoiceProcessingMediaTrackConstraints = MediaTrackConstraints & {
  voiceIsolation?: ConstrainBoolean;
};

type VoiceProcessingSupportedConstraints = MediaTrackSupportedConstraints & {
  voiceIsolation?: boolean;
};

function maybeSupportedConstraint(
  supported: VoiceProcessingSupportedConstraints,
  key: keyof VoiceProcessingSupportedConstraints
) {
  return Boolean(supported[key]);
}

export function buildMicrophoneCaptureOptions(
  options: BuildMicrophoneCaptureOptions
): MediaTrackConstraints {
  const { selectedInputId } = options;
  const captureSettings = options.krispActive
    ? {
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: false,
        voiceIsolation: false
      }
    : {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false
      };
  const supported =
    typeof navigator !== "undefined" && navigator.mediaDevices?.getSupportedConstraints
      ? (navigator.mediaDevices.getSupportedConstraints() as VoiceProcessingSupportedConstraints)
      : {};
  const deviceId = getConcreteAudioDeviceId(selectedInputId) || undefined;
  const constraints: VoiceProcessingMediaTrackConstraints = {};

  if (deviceId) {
    constraints.deviceId = { exact: deviceId };
  }

  if (maybeSupportedConstraint(supported, "channelCount")) {
    constraints.channelCount = { ideal: 1 };
  }

  if (maybeSupportedConstraint(supported, "echoCancellation")) {
    constraints.echoCancellation = captureSettings.echoCancellation;
  }

  if (maybeSupportedConstraint(supported, "noiseSuppression")) {
    constraints.noiseSuppression = captureSettings.noiseSuppression;
  }

  if (maybeSupportedConstraint(supported, "autoGainControl")) {
    constraints.autoGainControl = captureSettings.autoGainControl;
  }

  if (maybeSupportedConstraint(supported, "voiceIsolation") && "voiceIsolation" in captureSettings) {
    constraints.voiceIsolation = captureSettings.voiceIsolation;
  }

  return constraints;
}

export function getMediaTrackSettings(track: MediaStreamTrack | null | undefined) {
  if (!track || typeof track.getSettings !== "function") {
    return null;
  }

  return track.getSettings();
}
