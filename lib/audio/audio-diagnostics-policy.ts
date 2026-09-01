export const AUDIO_DIAGNOSTICS_SNAPSHOT_MIN_INTERVAL_MS = 10_000;

type SnapshotPersistenceDecision = {
  now: number;
  fingerprint: string;
  lastPersistedAt: number | null;
  lastFingerprint: string | null;
  minimumIntervalMs?: number;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Captures lifecycle and user-visible audio state while deliberately excluding
 * fast-changing meter values such as RMS, gate-open, and noise-floor samples.
 */
export function getAudioDiagnosticsSnapshotFingerprint(snapshot: unknown) {
  const root = asRecord(snapshot);
  const noiseFilter = asRecord(root.noiseFilter);
  const voiceGate = asRecord(root.voiceGate);
  const noiseFloor = asRecord(root.noiseFloor);

  return JSON.stringify({
    connectionStatus: root.connectionStatus ?? null,
    mode: root.mode ?? null,
    profile: root.profile ?? null,
    inputMuted: root.inputMuted ?? null,
    outputMuted: root.outputMuted ?? null,
    enhancedNoiseSuppressionEnabled: root.enhancedNoiseSuppressionEnabled ?? null,
    krispSupported: root.krispSupported ?? null,
    krispPrewarmState: root.krispPrewarmState ?? null,
    krispLifecycle: root.krispLifecycle ?? null,
    krispProcessorAttached: root.krispProcessorAttached ?? null,
    processorAttached: root.processorAttached ?? null,
    customProcessorActive: root.customProcessorActive ?? null,
    localMicTrackCount: root.localMicTrackCount ?? null,
    lastAudioError: root.lastAudioError ?? null,
    lastDeviceSwitchResult: root.lastDeviceSwitchResult ?? null,
    lastProcessorFailure: root.lastProcessorFailure ?? null,
    noiseFilter: {
      expected: noiseFilter.expected ?? null,
      enabled: noiseFilter.enabled ?? null,
      failed: noiseFilter.failed ?? null,
      fallbackActive: noiseFilter.fallbackActive ?? null,
      lifecycle: noiseFilter.lifecycle ?? null,
      processorExists: noiseFilter.processorExists ?? null,
      attachedToActiveTrack: noiseFilter.attachedToActiveTrack ?? null,
      processorEnabled: noiseFilter.processorEnabled ?? null,
      fallbackReason: noiseFilter.fallbackReason ?? null
    },
    voiceGate: {
      profile: voiceGate.profile ?? null,
      enabled: voiceGate.enabled ?? null,
      processorActive: voiceGate.processorActive ?? null,
      source: voiceGate.source ?? null
    },
    noiseFloor: {
      warningActive: noiseFloor.warningActive ?? null,
      recommendedProfile: noiseFloor.recommendedProfile ?? null
    }
  });
}

export function shouldPersistAudioDiagnosticsSnapshot({
  now,
  fingerprint,
  lastPersistedAt,
  lastFingerprint,
  minimumIntervalMs = AUDIO_DIAGNOSTICS_SNAPSHOT_MIN_INTERVAL_MS
}: SnapshotPersistenceDecision) {
  if (lastPersistedAt === null || lastFingerprint === null) {
    return true;
  }

  if (fingerprint !== lastFingerprint) {
    return true;
  }

  if (now < lastPersistedAt) {
    return true;
  }

  return now - lastPersistedAt >= Math.max(0, minimumIntervalMs);
}
