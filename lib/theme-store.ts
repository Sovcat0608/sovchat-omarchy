"use client";

export const APP_THEMES = [
  {
    id: "solar-flare",
    name: "Solar Flare",
    primary: "#FFCA2A",
    secondary: "#71DCE1"
  },
  {
    id: "neon-current",
    name: "Neon Current",
    primary: "#5CE7EE",
    secondary: "#FF6E91"
  },
  {
    id: "rose-circuit",
    name: "Rose Circuit",
    primary: "#FF6FB5",
    secondary: "#6FE7D7"
  },
  {
    id: "glacier-signal",
    name: "Glacier Signal",
    primary: "#8BD5FF",
    secondary: "#B9F36C"
  },
  {
    id: "ember-shift",
    name: "Ember Shift",
    primary: "#FF795E",
    secondary: "#65C7FF"
  },
  {
    id: "night-bloom",
    name: "Night Bloom",
    primary: "#B58CFF",
    secondary: "#73E6B1"
  }
] as const;

export type AppThemeId = (typeof APP_THEMES)[number]["id"];

const DEFAULT_THEME_ID: AppThemeId = "solar-flare";
const STORAGE_KEY = "sovchat.theme";
const THEME_IDS = new Set<AppThemeId>(APP_THEMES.map((theme) => theme.id));
const listeners = new Set<() => void>();

let hydrated = false;
let themeId: AppThemeId = DEFAULT_THEME_ID;

function isAppThemeId(value: unknown): value is AppThemeId {
  return typeof value === "string" && THEME_IDS.has(value as AppThemeId);
}

function applyTheme(nextThemeId: AppThemeId) {
  if (typeof document !== "undefined") {
    document.body.dataset.theme = nextThemeId;
  }
}

function hydrate() {
  if (hydrated || typeof window === "undefined") {
    return;
  }

  hydrated = true;
  const storedThemeId = window.localStorage.getItem(STORAGE_KEY);
  if (isAppThemeId(storedThemeId)) {
    themeId = storedThemeId;
  }
  applyTheme(themeId);
}

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

export const themeStore = {
  getState() {
    hydrate();
    return themeId;
  },
  getServerState() {
    return DEFAULT_THEME_ID;
  },
  subscribe(listener: () => void) {
    hydrate();
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  setTheme(nextThemeId: AppThemeId) {
    hydrate();
    if (!isAppThemeId(nextThemeId) || nextThemeId === themeId) {
      return;
    }

    themeId = nextThemeId;
    window.localStorage.setItem(STORAGE_KEY, themeId);
    applyTheme(themeId);
    emit();
  }
};
