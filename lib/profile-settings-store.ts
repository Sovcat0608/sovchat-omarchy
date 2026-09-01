"use client";

const STORAGE_KEY = "sovchat.profile-settings";

type ProfileSettingsState = {
  nickname: string | null;
  avatarId: string;
  avatarDataUrl: string | null;
};

const listeners = new Set<() => void>();

const DEFAULT_STATE: ProfileSettingsState = {
  nickname: null,
  avatarId: "avatar-1",
  avatarDataUrl: null
};

let hydrated = false;
let state: ProfileSettingsState = DEFAULT_STATE;

function emit() {
  for (const listener of listeners) {
    listener();
  }
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

    const parsed = JSON.parse(raw) as Partial<ProfileSettingsState>;
    state = {
      nickname:
        typeof parsed.nickname === "string" && parsed.nickname.trim() ? parsed.nickname.trim() : null,
      avatarId:
        typeof parsed.avatarId === "string" && parsed.avatarId.trim()
          ? parsed.avatarId
          : DEFAULT_STATE.avatarId,
      avatarDataUrl:
        typeof parsed.avatarDataUrl === "string" && parsed.avatarDataUrl.trim()
          ? parsed.avatarDataUrl
          : null
    };
  } catch {
    state = DEFAULT_STATE;
  }
}

export const profileSettingsStore = {
  getState() {
    hydrate();
    return state;
  },
  subscribe(listener: () => void) {
    hydrate();
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  patch(nextState: Partial<ProfileSettingsState>) {
    state = { ...state, ...nextState };
    persist();
    emit();
  },
  syncNickname(nickname: string) {
    hydrate();
    const normalized = nickname.trim();
    if (!normalized || state.nickname === normalized) {
      return;
    }

    state = { ...state, nickname: normalized };
    persist();
    emit();
  }
};

export type { ProfileSettingsState };
