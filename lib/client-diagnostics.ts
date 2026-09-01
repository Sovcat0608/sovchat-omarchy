"use client";

import { getDesktopBridge } from "@/lib/desktop";

export type ClientDiagnosticCategory = "audio" | "performance";

export type ClientDiagnosticEntry = {
  timestamp: string;
  category: ClientDiagnosticCategory;
  name: string;
  details?: Record<string, unknown>;
};

declare global {
  interface Window {
    __sovchatClientDiagnostics?: ClientDiagnosticEntry[];
  }
}

const CLIENT_DIAGNOSTIC_HISTORY_LIMIT = 240;
const CLIENT_DIAGNOSTIC_BATCH_LIMIT = 20;
const CLIENT_DIAGNOSTIC_FLUSH_DELAY_MS = 250;
const MAX_DIAGNOSTIC_DEPTH = 5;
const MAX_DIAGNOSTIC_ARRAY_LENGTH = 24;
const MAX_DIAGNOSTIC_OBJECT_KEYS = 40;
const MAX_DIAGNOSTIC_STRING_LENGTH = 512;
const MAX_DIAGNOSTIC_ENTRY_JSON_LENGTH = 12_000;
const REDACTED_VALUE = "[redacted]";
const TRUNCATED_VALUE = "[truncated]";
const SAFE_CORRELATION_KEYS = new Set(["attemptid", "joinattemptid"]);
const SAFE_LABEL_KEYS = new Set([
  "code",
  "deployment",
  "errorcode",
  "errorname",
  "host",
  "level",
  "protocol",
  "reason",
  "stage",
  "state",
  "status"
]);
const ERROR_MESSAGE_KEYS = new Set([
  "error",
  "message",
  "errormessage",
  "lastaudioerror",
  "lastprocessorfailure",
  "lastdeviceswitchresult"
]);
const ESSENTIAL_DETAIL_KEYS = new Set([
  "attemptId",
  "joinAttemptId",
  "stage",
  "status",
  "reason",
  "error",
  "errorName",
  "durationMs",
  "timeoutMs"
]);

let pendingDesktopEntries: ClientDiagnosticEntry[] = [];
let desktopFlushTimer: number | null = null;
let desktopFlushPromise: Promise<boolean> = Promise.resolve(true);
let lifecycleFlushRegistered = false;

function normalizeDiagnosticKey(key: string) {
  return key.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function isSensitiveDiagnosticKey(key: string) {
  const normalized = normalizeDiagnosticKey(key);

  if (SAFE_CORRELATION_KEYS.has(normalized)) {
    return false;
  }

  return (
    normalized.endsWith("id") ||
    normalized.endsWith("identity") ||
    normalized.includes("token") ||
    normalized.includes("authorization") ||
    normalized.includes("cookie") ||
    normalized.includes("password") ||
    normalized.includes("secret") ||
    normalized.includes("credential") ||
    normalized.includes("nickname") ||
    normalized === "roomname" ||
    normalized.includes("label")
  );
}

function isErrorMessageDiagnosticKey(key: string) {
  const normalized = normalizeDiagnosticKey(key);
  return ERROR_MESSAGE_KEYS.has(normalized) || normalized.endsWith("errormessage");
}

function stripDiagnosticControls(value: string) {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .slice(0, MAX_DIAGNOSTIC_STRING_LENGTH);
}

function looksLikeOpaqueIdentifier(value: string) {
  if (value.length >= 32 && /^[A-Za-z0-9_-]+$/u.test(value)) {
    return true;
  }

  if (value.length >= 10 && /[A-Za-z]/u.test(value) && /\d/u.test(value)) {
    return true;
  }

  return /^[0-9a-f]{12,}$/iu.test(value);
}

function redactOpaqueIdentifierTokens(value: string) {
  return value.replace(/\b[A-Za-z0-9][A-Za-z0-9_.:@-]{8,}\b/gu, (token) =>
    looksLikeOpaqueIdentifier(token) ? "[id]" : token
  );
}

export function sanitizeClientDiagnosticErrorMessage(value: string) {
  const sanitized = stripDiagnosticControls(String(value))
    .replace(/Bearer\s+[^\s,;]+/giu, "Bearer [redacted]")
    .replace(/Basic\s+[A-Za-z0-9+/=]+/giu, "Basic [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, REDACTED_VALUE)
    .replace(
      /\b((?:access|refresh|session)[_-]?token|token|api[_-]?key|secret|signature|authorization|password|credential)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/giu,
      "$1=[redacted]"
    )
    .replace(/([?&](?:access_token|refresh_token|token|api[_-]?key|key|secret|signature|authorization)=)[^&#\s]+/giu, "$1[redacted]")
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/giu, "[url]")
    .replace(/\b[^\s@"'<>]+@[^\s@"'<>]+\.[A-Za-z]{2,}\b/gu, "[credential]")
    .replace(
      /(^|[\s("'])(?:(?:[A-Za-z]:[\\/]|\\\\|\.{1,2}[\\/]|\/)(?:[^\r\n,;)"'<>]+))/gmu,
      "$1[path]"
    )
    .replace(
      /\b((?:audio[_ -]?)?(?:device|microphone|track|room|participant|peer|user|identity|session)(?:[_ -]?(?:id|sid|name|label))?\s*(?:=|:|#)\s*)(?:"[^"]*"|'[^']*'|[^\s,;)\]}]+)/giu,
      "$1[id]"
    )
    .replace(/"[^"\r\n]{2,}"/gu, '"[redacted]"')
    .replace(/`[^`\r\n]{2,}`/gu, "`[redacted]`")
    .replace(/\b(?:TR|RM|PA|AT|VE|VT)_[A-Za-z0-9_-]+\b/gu, "[id]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu, "[id]")
    .replace(/\b[0-9a-f]{12,}\b/giu, "[id]");

  return redactOpaqueIdentifierTokens(sanitized).slice(0, MAX_DIAGNOSTIC_STRING_LENGTH);
}

function sanitizeDiagnosticEventName(value: unknown) {
  const sanitized = stripDiagnosticControls(String(value ?? "unknown")).trim().slice(0, 120);
  return /^[A-Za-z0-9]+(?:[._:-][A-Za-z0-9]+)*$/u.test(sanitized)
    ? sanitized
    : "unknown";
}

function sanitizeDiagnosticLabel(value: unknown) {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    return REDACTED_VALUE;
  }

  const sanitized = stripDiagnosticControls(value).trim();
  return sanitized.length <= 120 && /^[A-Za-z0-9]+(?:[._:-][A-Za-z0-9]+)*$/u.test(sanitized)
    ? sanitized
    : REDACTED_VALUE;
}

function sanitizeCorrelationValue(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string" && /^\d{1,12}$/u.test(value)) {
    return value;
  }

  return REDACTED_VALUE;
}

function sanitizeDiagnosticObjectKey(key: string, index: number) {
  const sanitized = stripDiagnosticControls(key).trim();
  if (
    sanitized.length > 0 &&
    sanitized.length <= 64 &&
    /^[A-Za-z][A-Za-z0-9_.-]*$/u.test(sanitized) &&
    !looksLikeOpaqueIdentifier(sanitized) &&
    sanitized !== "__proto__" &&
    sanitized !== "constructor" &&
    sanitized !== "prototype"
  ) {
    return sanitized;
  }

  return `field${index + 1}`;
}

function sanitizeDiagnosticValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>
): unknown {
  if (value === null || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === "string") {
    // Strings need field context before they can be considered safe. Unknown
    // free-form values are excluded instead of relying on a best-effort regex.
    return REDACTED_VALUE;
  }

  if (typeof value === "bigint") {
    return REDACTED_VALUE;
  }

  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }

  if (depth >= MAX_DIAGNOSTIC_DEPTH) {
    return TRUNCATED_VALUE;
  }

  if (value instanceof Error) {
    return {
      name: sanitizeDiagnosticLabel(value.name),
      message: sanitizeClientDiagnosticErrorMessage(value.message)
    };
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_DIAGNOSTIC_ARRAY_LENGTH)
      .map((item) => sanitizeDiagnosticValue(item, depth + 1, seen))
      .filter((item) => item !== undefined);
  }

  const sanitized: Record<string, unknown> = {};
  for (const [index, [key, nestedValue]] of Object.entries(value)
    .slice(0, MAX_DIAGNOSTIC_OBJECT_KEYS)
    .entries()) {
    const sanitizedKey = sanitizeDiagnosticObjectKey(key, index);
    const normalizedKey = normalizeDiagnosticKey(key);

    if (SAFE_CORRELATION_KEYS.has(normalizedKey)) {
      sanitized[sanitizedKey] = sanitizeCorrelationValue(nestedValue);
      continue;
    }

    if (isSensitiveDiagnosticKey(key)) {
      sanitized[sanitizedKey] = REDACTED_VALUE;
      continue;
    }

    if (isErrorMessageDiagnosticKey(key)) {
      sanitized[sanitizedKey] =
        typeof nestedValue === "string"
          ? sanitizeClientDiagnosticErrorMessage(nestedValue)
          : REDACTED_VALUE;
      continue;
    }

    if (SAFE_LABEL_KEYS.has(normalizedKey)) {
      sanitized[sanitizedKey] = sanitizeDiagnosticLabel(nestedValue);
      continue;
    }

    const sanitizedValue = sanitizeDiagnosticValue(nestedValue, depth + 1, seen);
    if (sanitizedValue !== undefined) {
      sanitized[sanitizedKey] = sanitizedValue;
    }
  }

  return sanitized;
}

export function sanitizeClientDiagnosticDetails(details: unknown): Record<string, unknown> {
  const sanitized = sanitizeDiagnosticValue(details, 0, new WeakSet());
  const result =
    sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
      ? (sanitized as Record<string, unknown>)
      : { value: sanitized };

  try {
    if (JSON.stringify(result).length <= MAX_DIAGNOSTIC_ENTRY_JSON_LENGTH) {
      return result;
    }
  } catch {
    return { truncated: true, reason: "details-could-not-be-serialized" };
  }

  const compact: Record<string, unknown> = {
    truncated: true,
    reason: "details-exceeded-size-limit"
  };
  for (const key of ESSENTIAL_DETAIL_KEYS) {
    if (key in result) {
      compact[key] = result[key];
    }
  }
  return compact;
}

function getClientDiagnosticHistory() {
  if (typeof window === "undefined") {
    return [];
  }

  window.__sovchatClientDiagnostics ??= [];
  return window.__sovchatClientDiagnostics;
}

function retainClientDiagnostic(entry: ClientDiagnosticEntry) {
  const history = getClientDiagnosticHistory();
  history.push(entry);
  window.__sovchatClientDiagnostics = history.slice(-CLIENT_DIAGNOSTIC_HISTORY_LIMIT);
}

function registerLifecycleFlush() {
  if (lifecycleFlushRegistered || typeof window === "undefined") {
    return;
  }

  lifecycleFlushRegistered = true;
  window.addEventListener("pagehide", () => {
    void flushClientDiagnostics();
  });
}

function queueDesktopDiagnostic(entry: ClientDiagnosticEntry) {
  const bridge = getDesktopBridge();
  if (!bridge?.isDesktop || !bridge.appendClientDiagnostics) {
    return;
  }

  registerLifecycleFlush();
  pendingDesktopEntries.push(entry);

  if (pendingDesktopEntries.length >= CLIENT_DIAGNOSTIC_BATCH_LIMIT) {
    void flushClientDiagnostics();
    return;
  }

  if (desktopFlushTimer === null) {
    desktopFlushTimer = window.setTimeout(() => {
      desktopFlushTimer = null;
      void flushClientDiagnostics();
    }, CLIENT_DIAGNOSTIC_FLUSH_DELAY_MS);
  }
}

export function recordClientDiagnostic(
  category: ClientDiagnosticCategory,
  name: string,
  details: unknown = {}
) {
  if (typeof window === "undefined") {
    return null;
  }

  const entry: ClientDiagnosticEntry = {
    timestamp: new Date().toISOString(),
    category,
    name: sanitizeDiagnosticEventName(name),
    details: sanitizeClientDiagnosticDetails(details)
  };

  retainClientDiagnostic(entry);
  queueDesktopDiagnostic(entry);
  return entry;
}

export function getClientDiagnosticsSnapshot() {
  return getClientDiagnosticHistory().map((entry) => ({
    ...entry,
    details: entry.details ? { ...entry.details } : undefined
  }));
}

export function flushClientDiagnostics() {
  if (desktopFlushTimer !== null && typeof window !== "undefined") {
    window.clearTimeout(desktopFlushTimer);
    desktopFlushTimer = null;
  }

  const bridge = getDesktopBridge();
  if (!bridge?.isDesktop || !bridge.appendClientDiagnostics || pendingDesktopEntries.length === 0) {
    return desktopFlushPromise;
  }

  const batch = pendingDesktopEntries.splice(0, pendingDesktopEntries.length);
  desktopFlushPromise = desktopFlushPromise
    .catch(() => false)
    .then(async () => {
      try {
        return await bridge.appendClientDiagnostics!(batch);
      } catch {
        pendingDesktopEntries = [...batch, ...pendingDesktopEntries].slice(
          -CLIENT_DIAGNOSTIC_HISTORY_LIMIT
        );
        return false;
      }
    });

  return desktopFlushPromise;
}
