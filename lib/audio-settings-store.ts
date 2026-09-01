"use client";

import type { SovChatAudioProfile } from "@/lib/audio/audio-types";

type DeviceOption = {
  deviceId: string;
  label: string;
};

type AudioSettingsController = {
  setInputDevice: (id: string) => void;
  setOutputDevice: (id: string) => void;
  setInputMuted: (value: boolean) => void;
  setOutputMuted: (value: boolean) => void;
  setNoiseFilterEnabled: (value: boolean) => void;
  setAudioProfile: (value: SovChatAudioProfile) => void;
  setInputGain: (value: number) => void;
  setOutputVolume: (value: number) => void;
};

type AudioSettingsState = {
  inputDevices: DeviceOption[];
  outputDevices: DeviceOption[];
  selectedInputId: string;
  selectedOutputId: string;
  inputMuted: boolean;
  outputMuted: boolean;
  noiseFilterEnabled: boolean;
  audioProfile: SovChatAudioProfile;
  inputGain: number;
  outputVolume: number;
  streamMuted: boolean;
  streamVolume: number;
  outputSwitchSupported: boolean;
  performanceMode: boolean;
  noiseFloorWarning: string | null;
};

type PersistedAudioSettings = Partial<AudioSettingsState> & {
  noiseFilterDefaultRevision?: number;
};

const listeners = new Set<() => void>();
const STORAGE_KEY = "sovchat.audio-settings";
const MAX_OUTPUT_VOLUME = 1;
const NOISE_FILTER_DEFAULT_REVISION = 1;

let controller: AudioSettingsController = {
  setInputDevice: () => undefined,
  setOutputDevice: () => undefined,
  setInputMuted: () => undefined,
  setOutputMuted: () => undefined,
  setNoiseFilterEnabled: () => undefined,
  setAudioProfile: () => undefined,
  setInputGain: () => undefined,
  setOutputVolume: () => undefined
};

let state: AudioSettingsState = {
  inputDevices: [],
  outputDevices: [],
  selectedInputId: "",
  selectedOutputId: "",
  inputMuted: false,
  outputMuted: false,
  noiseFilterEnabled: true,
  audioProfile: "standard",
  inputGain: 1,
  outputVolume: 1,
  streamMuted: false,
  streamVolume: 1,
  outputSwitchSupported: false,
  performanceMode: false,
  noiseFloorWarning: null
};

let hydrated = false;

function clampVolume(value: unknown, fallback: number, max = MAX_OUTPUT_VOLUME) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(max, value))
    : fallback;
}

function persist() {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      selectedInputId: state.selectedInputId,
      selectedOutputId: state.selectedOutputId,
      inputMuted: state.inputMuted,
      outputMuted: state.outputMuted,
      noiseFilterEnabled: state.noiseFilterEnabled,
      noiseFilterDefaultRevision: NOISE_FILTER_DEFAULT_REVISION,
      outputVolume: state.outputVolume,
      streamMuted: state.streamMuted,
      streamVolume: state.streamVolume,
      performanceMode: state.performanceMode
    })
  );
}

function hydrate() {
  if (hydrated || typeof window === "undefined") {
    return;
  }

  hydrated = true;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return;
    }

    const parsed = JSON.parse(raw) as PersistedAudioSettings;
    const shouldForceEnableNoiseFilter =
      typeof parsed.noiseFilterDefaultRevision !== "number" ||
      parsed.noiseFilterDefaultRevision < NOISE_FILTER_DEFAULT_REVISION;
    state = {
      ...state,
      selectedInputId:
        typeof parsed.selectedInputId === "string" ? parsed.selectedInputId : state.selectedInputId,
      selectedOutputId:
        typeof parsed.selectedOutputId === "string"
          ? parsed.selectedOutputId
          : state.selectedOutputId,
      inputMuted:
        typeof parsed.inputMuted === "boolean" ? parsed.inputMuted : state.inputMuted,
      outputMuted:
        typeof parsed.outputMuted === "boolean" ? parsed.outputMuted : state.outputMuted,
      audioProfile: "standard",
      noiseFilterEnabled:
        shouldForceEnableNoiseFilter
          ? true
          : typeof parsed.noiseFilterEnabled === "boolean"
          ? parsed.noiseFilterEnabled
          : state.noiseFilterEnabled,
      inputGain: 1,
      outputVolume: clampVolume(parsed.outputVolume, state.outputVolume, MAX_OUTPUT_VOLUME),
      streamMuted:
        typeof parsed.streamMuted === "boolean" ? parsed.streamMuted : state.streamMuted,
      streamVolume: clampVolume(parsed.streamVolume, state.streamVolume, 1),
      performanceMode:
        typeof parsed.performanceMode === "boolean"
          ? parsed.performanceMode
          : state.performanceMode,
      noiseFloorWarning: null
    };

    if (shouldForceEnableNoiseFilter) {
      persist();
    }
  } catch {
    // Ignore malformed persisted settings.
  }
}

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

export const audioSettingsStore = {
  getState() {
    hydrate();
    return state;
  },
  subscribe(listener: () => void) {
    hydrate();
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  patch(nextState: Partial<AudioSettingsState>) {
    state = {
      ...state,
      ...nextState,
      audioProfile: "standard",
      noiseFilterEnabled:
        "noiseFilterEnabled" in nextState
          ? Boolean(nextState.noiseFilterEnabled)
          : state.noiseFilterEnabled,
      inputGain: 1,
      outputVolume:
        "outputVolume" in nextState
          ? clampVolume(nextState.outputVolume, state.outputVolume, MAX_OUTPUT_VOLUME)
          : state.outputVolume,
      streamVolume:
        "streamVolume" in nextState
          ? clampVolume(nextState.streamVolume, state.streamVolume, 1)
          : state.streamVolume
    };
    persist();
    emit();
  },
  registerController(nextController: AudioSettingsController) {
    controller = nextController;
    emit();

    return () => {
      controller = {
        setInputDevice: () => undefined,
        setOutputDevice: () => undefined,
        setInputMuted: () => undefined,
        setOutputMuted: () => undefined,
        setNoiseFilterEnabled: () => undefined,
        setAudioProfile: () => undefined,
        setInputGain: () => undefined,
        setOutputVolume: () => undefined
      };
      emit();
    };
  },
  getController() {
    return controller;
  }
};

export type { DeviceOption, AudioSettingsState };
