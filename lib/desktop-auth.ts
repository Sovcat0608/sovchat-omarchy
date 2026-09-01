import { getDesktopBridge } from "@/lib/desktop";

export const DESKTOP_SESSION_TOKEN_KEY = "sovchat.desktop.session-token";

function syncPresenceSessionToken(token: string | null) {
  const result = getDesktopBridge()?.setPresenceSessionToken?.(token);
  void result?.catch(() => undefined);
}

function readStorageToken(storage: Storage | null) {
  try {
    return storage?.getItem(DESKTOP_SESSION_TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

export function getDesktopSessionToken() {
  if (typeof window === "undefined") {
    return null;
  }

  return readStorageToken(window.localStorage) ?? readStorageToken(window.sessionStorage);
}

export function getDesktopSessionPersistence() {
  if (typeof window === "undefined") {
    return "local" as const;
  }

  if (readStorageToken(window.localStorage)) {
    return "local" as const;
  }

  if (readStorageToken(window.sessionStorage)) {
    return "session" as const;
  }

  return "local" as const;
}

export function setDesktopSessionToken(token: string, remember = true) {
  if (typeof window === "undefined") {
    return;
  }

  const targetStorage = remember ? window.localStorage : window.sessionStorage;
  const otherStorage = remember ? window.sessionStorage : window.localStorage;

  targetStorage.setItem(DESKTOP_SESSION_TOKEN_KEY, token);
  otherStorage.removeItem(DESKTOP_SESSION_TOKEN_KEY);
  syncPresenceSessionToken(token);
}

export function clearDesktopSessionToken() {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(DESKTOP_SESSION_TOKEN_KEY);
  window.sessionStorage.removeItem(DESKTOP_SESSION_TOKEN_KEY);
  syncPresenceSessionToken(null);
}
