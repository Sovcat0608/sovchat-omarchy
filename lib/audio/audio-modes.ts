"use client";

import type { SovChatAudioMode, SovChatAudioProfile } from "@/lib/audio/audio-types";

export const STABLE_MAX_INPUT_GAIN = 1;
export const STABLE_MAX_OUTPUT_VOLUME = 1;
export const STABLE_MAX_STREAM_VOLUME = 1;
export const STABLE_MAX_PARTICIPANT_VOLUME = 6;

export type ResolveAudioModeOptions = {
  diagnosticFallback: boolean;
  audioProfile: SovChatAudioProfile;
  noiseFilterEnabled: boolean;
  krispSupported: boolean;
  krispFailed: boolean;
};

export function resolveAudioMode(options: ResolveAudioModeOptions): SovChatAudioMode {
  void options;
  return "safe";
}

export function getConcreteAudioDeviceId(deviceId: string) {
  return deviceId === "default" ? "" : deviceId;
}

export function clampStableVolume(value: number) {
  return Math.max(0, Math.min(STABLE_MAX_OUTPUT_VOLUME, value));
}

export function isNoiseFilterProfile(profile: SovChatAudioProfile) {
  void profile;
  return false;
}

export function coerceAudioProfile(value: unknown): SovChatAudioProfile | null {
  return value === "standard" ? value : null;
}

export function audioProfileFromNoiseFilter(value: boolean): SovChatAudioProfile {
  void value;
  return "standard";
}
