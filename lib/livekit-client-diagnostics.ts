"use client";

import { LogLevel, setLogExtension } from "livekit-client";
import {
  recordClientDiagnostic,
  sanitizeClientDiagnosticDetails
} from "@/lib/client-diagnostics";
import { summarizeLiveKitLogContext } from "@/lib/livekit-client-error-details";

const INTERESTING_LOG_MESSAGES = [
  "could not fetch region settings",
  "could not prepare connection",
  "websocket closed"
];
const RECENT_LOG_SUPPRESSION_MS = 750;

let diagnosticsInstalled = false;
const recentLogs = new Map<string, number>();


function shouldCaptureLiveKitLog(level: LogLevel, message: string) {
  const normalized = message.toLowerCase();
  return level >= LogLevel.warn || INTERESTING_LOG_MESSAGES.some((entry) => normalized.includes(entry));
}

function isDuplicateLog(key: string) {
  const now = Date.now();
  const previous = recentLogs.get(key) ?? 0;
  recentLogs.set(key, now);

  if (recentLogs.size > 40) {
    for (const [entry, timestamp] of recentLogs) {
      if (now - timestamp > 30_000) {
        recentLogs.delete(entry);
      }
    }
  }

  return now - previous < RECENT_LOG_SUPPRESSION_MS;
}

export function installLiveKitClientDiagnostics() {
  if (diagnosticsInstalled || typeof window === "undefined") {
    return;
  }

  diagnosticsInstalled = true;
  setLogExtension((level, message, context) => {
    if (!shouldCaptureLiveKitLog(level, message)) {
      return;
    }

    const levelName = LogLevel[level] ?? "unknown";
    const details = {
      level: levelName,
      message,
      ...summarizeLiveKitLogContext(context)
    };
    const duplicateKey = `${levelName}:${message}:${JSON.stringify(details)}`;
    if (isDuplicateLog(duplicateKey)) {
      return;
    }

    recordClientDiagnostic("audio", "livekit-sdk-log", details);
    const printable = JSON.stringify(sanitizeClientDiagnosticDetails(details));
    const logLine = `[sovchat:livekit] ${message} ${printable}`;
    if (level >= LogLevel.error) {
      console.error(logLine);
    } else {
      console.warn(logLine);
    }
  });
}
