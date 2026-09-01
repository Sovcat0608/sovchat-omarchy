"use client";

import { getDesktopBridge } from "@/lib/desktop";
import { getDesktopSessionToken } from "@/lib/desktop-auth";
import { getDesktopCompatibilityVersion } from "@/lib/desktop-version-compat";
import {
  APP_BUILD_COMMIT,
  APP_BUILD_SEMVER,
  APP_BUILD_VARIANT
} from "@/lib/generated/build-meta";

const DESKTOP_COMPATIBILITY_VERSION = getDesktopCompatibilityVersion(APP_BUILD_SEMVER);

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function getCurrentAppOrigin() {
  if (typeof window === "undefined") {
    return "";
  }

  if (window.location.protocol === "app:" && window.location.host) {
    return `${window.location.protocol}//${window.location.host}`;
  }

  return window.location.origin;
}

export function getRemoteAppBaseUrl() {
  return getHostedAppBaseUrl();
}

export function getHostedAppBaseUrl() {
  if (typeof window === "undefined") {
    return "";
  }

  const desktopBridge = getDesktopBridge();
  const baseUrl = desktopBridge?.publicAppUrl ?? desktopBridge?.apiBaseUrl ?? desktopBridge?.remoteAppUrl;

  if (desktopBridge?.isDesktop && baseUrl) {
    return trimTrailingSlash(baseUrl);
  }

  return "";
}

export function getApiBaseUrl() {
  if (typeof window === "undefined") {
    return "";
  }

  const desktopBridge = getDesktopBridge();
  const baseUrl = desktopBridge?.apiBaseUrl ?? desktopBridge?.remoteAppUrl;

  if (desktopBridge?.isDesktop && baseUrl) {
    return trimTrailingSlash(baseUrl);
  }

  return "";
}

export function resolveApiUrl(path: string) {
  const apiBaseUrl = getApiBaseUrl();

  if (!apiBaseUrl) {
    return path;
  }

  return `${apiBaseUrl}${path}`;
}

export function resolveAbsoluteAppUrl(path: string) {
  if (typeof window !== "undefined") {
    return new URL(path, getCurrentAppOrigin()).toString();
  }

  return path;
}

export function resolveHostedAppUrl(path: string) {
  const hostedAppBaseUrl = getHostedAppBaseUrl();

  if (hostedAppBaseUrl) {
    return `${hostedAppBaseUrl}${path}`;
  }

  return resolveAbsoluteAppUrl(path);
}

export function buildDesktopAuthHeaders(headers?: HeadersInit) {
  const nextHeaders = new Headers(headers);
  const desktopBridge = getDesktopBridge();
  const token = getDesktopSessionToken();

  if (desktopBridge?.isDesktop) {
    nextHeaders.set("X-SovChat-Client", "desktop");
    nextHeaders.set("X-SovChat-Version", DESKTOP_COMPATIBILITY_VERSION);
    nextHeaders.set("X-SovChat-Build-Commit", APP_BUILD_COMMIT);
    nextHeaders.set("X-SovChat-App-Variant", APP_BUILD_VARIANT);
  }

  if (token) {
    nextHeaders.set("Authorization", `Bearer ${token}`);
  }

  return nextHeaders;
}

export async function apiFetch(input: string, init?: RequestInit) {
  const url = resolveApiUrl(input);
  const headers = buildDesktopAuthHeaders(init?.headers);

  return fetch(url, {
    ...init,
    headers,
    credentials: "include"
  });
}

export function createApiEventSource(path: string) {
  const url = resolveApiUrl(path);
  const token = getDesktopSessionToken();
  const nextUrl = new URL(url, typeof window !== "undefined" ? window.location.origin : undefined);

  if (token) {
    nextUrl.searchParams.set("sessionToken", token);
  }

  return new EventSource(nextUrl.toString(), { withCredentials: true });
}

export function createApiAssetUrl(path: string) {
  const url = resolveApiUrl(path);
  const token = getDesktopSessionToken();
  const nextUrl = new URL(url, typeof window !== "undefined" ? window.location.origin : undefined);

  if (token) {
    nextUrl.searchParams.set("sessionToken", token);
  }

  return nextUrl.toString();
}
