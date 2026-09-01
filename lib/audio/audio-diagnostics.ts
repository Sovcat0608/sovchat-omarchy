"use client";

import {
  getClientDiagnosticsSnapshot,
  recordClientDiagnostic
} from "@/lib/client-diagnostics";
import {
  getAudioDiagnosticsSnapshotFingerprint,
  shouldPersistAudioDiagnosticsSnapshot
} from "@/lib/audio/audio-diagnostics-policy";
import { shouldLogVerboseDiagnostics } from "@/lib/performance-diagnostics";

export type AudioDiagnosticEvent = {
  timestamp: string;
  event: string;
  details?: Record<string, unknown>;
};

let lastPersistedSnapshotAt: number | null = null;
let lastPersistedSnapshotFingerprint: string | null = null;

export function areAudioDiagnosticsExposed() {
  return typeof window !== "undefined";
}

export function getAudioDiagnosticEvents() {
  return getClientDiagnosticsSnapshot().filter((entry) => entry.category === "audio");
}

export function recordAudioDiagnosticEvent(
  event: string,
  details: Record<string, unknown> = {}
) {
  recordClientDiagnostic("audio", event, details);

  if (shouldLogVerboseDiagnostics()) {
    console.info("[sovchat:audio]", event, details);
  }
}

export function publishAudioDiagnosticsSnapshot(snapshot: unknown) {
  const now = Date.now();
  const fingerprint = getAudioDiagnosticsSnapshotFingerprint(snapshot);
  if (
    !shouldPersistAudioDiagnosticsSnapshot({
      now,
      fingerprint,
      lastPersistedAt: lastPersistedSnapshotAt,
      lastFingerprint: lastPersistedSnapshotFingerprint
    })
  ) {
    return false;
  }

  lastPersistedSnapshotAt = now;
  lastPersistedSnapshotFingerprint = fingerprint;
  recordClientDiagnostic("audio", "snapshot", { snapshot });

  if (shouldLogVerboseDiagnostics()) {
    console.info("[sovchat:audio:snapshot]", snapshot);
  }

  return true;
}
