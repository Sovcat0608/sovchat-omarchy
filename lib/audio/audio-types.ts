"use client";

import type { Track } from "livekit-client";

export type SovChatAudioMode = "safe" | "enhanced" | "diagnostic";
export type SovChatAudioProfile = "standard" | "noisy-room" | "speaker" | "diagnostic";
export type KrispLifecycleState =
  | "unavailable"
  | "supported"
  | "loading"
  | "active"
  | "disabled"
  | "failed"
  | "fallback-standard";

export type NoiseFilterRuntimeState = {
  supported: boolean;
  expected: boolean;
  enabled: boolean;
  failed: boolean;
  fallbackActive: boolean;
  lastError: string | null;
  lifecycle: KrispLifecycleState;
  processorExists: boolean;
  attachedToActiveTrack: boolean;
  processorEnabled: boolean | null;
  localTrackId: string | null;
  localTrackReadyState: MediaStreamTrackState | null;
  fallbackReason: string | null;
};

export type VoiceGateRuntimeState = {
  profile: "off" | "soft" | "strong";
  enabled: boolean;
  processorActive: boolean;
  source: "none" | "voice-gate" | "krisp-voice-gate";
  gateOpen: boolean | null;
  rms: number | null;
  noiseFloor: number | null;
  openThreshold: number | null;
  closeThreshold: number | null;
  gain: number | null;
  closedGain: number | null;
  updatedAt: string | null;
};

export type RemoteOutputPreferences = {
  selectedOutputId: string;
  outputMuted: boolean;
  outputVolume: number;
  streamMuted: boolean;
  streamVolume: number;
  thirdPartyMutedIds: Set<string>;
  participantVolumes: Record<string, number>;
  participantVolumeKeys: Record<string, string>;
  outputSupported: boolean;
};

export type RemoteAudioElementRecord = {
  participantIdentity: string;
  source: Track.Source;
};

export type AudioDiagnosticsSnapshot = {
  mode: SovChatAudioMode;
  profile: SovChatAudioProfile;
  selectedInputId: string;
  selectedOutputId: string;
  captureConstraints: MediaTrackConstraints | null;
  requestedCaptureConstraints: MediaTrackConstraints | null;
  requestedEchoCancellation: ConstrainBoolean | null;
  requestedNoiseSuppression: ConstrainBoolean | null;
  requestedAutoGainControl: ConstrainBoolean | null;
  requestedVoiceIsolation: ConstrainBoolean | null;
  localTrackSettings: MediaTrackSettings | null;
  currentLocalTrackId: string | null;
  currentLocalTrackReadyState: MediaStreamTrackState | null;
  actualEchoCancellation: boolean | null;
  actualNoiseSuppression: boolean | null;
  actualAutoGainControl: boolean | null;
  actualVoiceIsolation: boolean | null;
  noiseFilter: NoiseFilterRuntimeState;
  voicePublishProfile: string;
  voiceGate: VoiceGateRuntimeState;
  noiseFloor: {
    warningActive: boolean;
    rms: number | null;
    durationMs: number | null;
    recommendedProfile: SovChatAudioProfile | null;
  };
  customProcessorActive: boolean;
  localMicTrackCount: number;
  remoteAudioElementCount: number;
  inputMuted: boolean;
  outputMuted: boolean;
  outputVolume: number;
  streamMuted: boolean;
  streamVolume: number;
  lastAudioError: string | null;
  lastDeviceSwitchResult: string | null;
  lastProcessorFailure: string | null;
  updatedAt: string;
};
