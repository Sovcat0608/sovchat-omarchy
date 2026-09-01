"use client";

type AdvancedSettingsState = {
  startWithWindows: boolean;
  closeToTray: boolean;
  trayIconEnabled: boolean;
  afkLeaveMinutes: number;
};

const STORAGE_KEY = "sovchat.advanced-settings";
const listeners = new Set<() => void>();

let state: AdvancedSettingsState = {
  startWithWindows: false,
  closeToTray: false,
  trayIconEnabled: false,
  afkLeaveMinutes: 0
};

let hydrated = false;

function sanitizeAfkMinutes(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1440, Math.round(value)));
}

function normalizeState(nextState: Partial<AdvancedSettingsState>) {
  return {
    startWithWindows:
      typeof nextState.startWithWindows === "boolean"
        ? nextState.startWithWindows
        : state.startWithWindows,
    closeToTray:
      typeof nextState.closeToTray === "boolean" ? nextState.closeToTray : state.closeToTray,
    trayIconEnabled:
      typeof nextState.trayIconEnabled === "boolean"
        ? nextState.trayIconEnabled
        : state.trayIconEnabled,
    afkLeaveMinutes:
      nextState.afkLeaveMinutes === undefined
        ? state.afkLeaveMinutes
        : sanitizeAfkMinutes(nextState.afkLeaveMinutes)
  };
}

function persist() {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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

    const parsed = JSON.parse(raw) as Partial<AdvancedSettingsState>;
    state = normalizeState(parsed);
  } catch {
    // Ignore malformed persisted settings.
  }
}

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

export const advancedSettingsStore = {
  getState() {
    hydrate();
    return state;
  },
  subscribe(listener: () => void) {
    hydrate();
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  patch(nextState: Partial<AdvancedSettingsState>) {
    hydrate();
    state = normalizeState(nextState);
    persist();
    emit();
  },
  replace(nextState: Partial<AdvancedSettingsState>) {
    hydrate();
    state = normalizeState(nextState);
    persist();
    emit();
  }
};

export type { AdvancedSettingsState };
