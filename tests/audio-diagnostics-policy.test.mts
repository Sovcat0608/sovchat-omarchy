import assert from "node:assert/strict";
import test from "node:test";

import {
  AUDIO_DIAGNOSTICS_SNAPSHOT_MIN_INTERVAL_MS,
  getAudioDiagnosticsSnapshotFingerprint,
  shouldPersistAudioDiagnosticsSnapshot
} from "../lib/audio/audio-diagnostics-policy.ts";

test("fast meter-only updates are throttled", () => {
  const first = getAudioDiagnosticsSnapshotFingerprint({
    connectionStatus: "connected",
    krispLifecycle: "active",
    voiceGate: { profile: "soft", processorActive: true, gateOpen: false, rms: 0.01 }
  });
  const meterUpdate = getAudioDiagnosticsSnapshotFingerprint({
    connectionStatus: "connected",
    krispLifecycle: "active",
    voiceGate: { profile: "soft", processorActive: true, gateOpen: true, rms: 0.42 }
  });

  assert.equal(first, meterUpdate);
  assert.equal(
    shouldPersistAudioDiagnosticsSnapshot({
      now: AUDIO_DIAGNOSTICS_SNAPSHOT_MIN_INTERVAL_MS - 1,
      fingerprint: meterUpdate,
      lastPersistedAt: 0,
      lastFingerprint: first
    }),
    false
  );
  assert.equal(
    shouldPersistAudioDiagnosticsSnapshot({
      now: AUDIO_DIAGNOSTICS_SNAPSHOT_MIN_INTERVAL_MS,
      fingerprint: meterUpdate,
      lastPersistedAt: 0,
      lastFingerprint: first
    }),
    true
  );
});

test("meaningful connection and processor changes persist immediately", () => {
  const connecting = getAudioDiagnosticsSnapshotFingerprint({
    connectionStatus: "preparing-audio",
    krispLifecycle: "loading",
    voiceGate: { profile: "soft", processorActive: false }
  });
  const connected = getAudioDiagnosticsSnapshotFingerprint({
    connectionStatus: "connected",
    krispLifecycle: "active",
    voiceGate: { profile: "soft", processorActive: true }
  });

  assert.notEqual(connecting, connected);
  assert.equal(
    shouldPersistAudioDiagnosticsSnapshot({
      now: 5,
      fingerprint: connected,
      lastPersistedAt: 0,
      lastFingerprint: connecting
    }),
    true
  );
});

test("the first snapshot and a clock reset are persisted", () => {
  const fingerprint = getAudioDiagnosticsSnapshotFingerprint({ connectionStatus: "idle" });

  assert.equal(
    shouldPersistAudioDiagnosticsSnapshot({
      now: 0,
      fingerprint,
      lastPersistedAt: null,
      lastFingerprint: null
    }),
    true
  );
  assert.equal(
    shouldPersistAudioDiagnosticsSnapshot({
      now: 50,
      fingerprint,
      lastPersistedAt: 100,
      lastFingerprint: fingerprint
    }),
    true
  );
});
