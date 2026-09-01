import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyVoiceJoinMicrophoneFailure,
  DEFAULT_KRISP_MODEL_QUALITY,
  getVoiceJoinMicrophoneFailureMessage,
  isPublishedMicrophoneLive,
  isVoiceConnectedStatus,
  shouldPrewarmKrispAssets,
  shouldTreatJoinFailureAsCancelled
} from "../lib/audio/voice-join-policy.ts";

test("degraded voice remains a fully joined state", () => {
  assert.equal(isVoiceConnectedStatus("connected"), true);
  assert.equal(isVoiceConnectedStatus("degraded"), true);
  assert.equal(isVoiceConnectedStatus("preparing-audio"), false);
  assert.equal(isVoiceConnectedStatus("connecting"), false);
});

test("Krisp preparation targets the runtime's actual default model", () => {
  assert.equal(DEFAULT_KRISP_MODEL_QUALITY, "medium");
});

test("slow links still prewarm unless the user enabled Save Data", () => {
  assert.equal(shouldPrewarmKrispAssets(undefined), true);
  assert.equal(shouldPrewarmKrispAssets(false), true);
  assert.equal(shouldPrewarmKrispAssets(true), false);
});

test("a microphone is ready only when its publication and media track are both live", () => {
  assert.equal(
    isPublishedMicrophoneLive({
      publicationExists: true,
      publicationMuted: false,
      upstreamPaused: false,
      mediaReadyState: "live",
      mediaEnabled: true
    }),
    true
  );

  for (const unavailableState of [
    { publicationExists: false },
    { publicationMuted: true },
    { upstreamPaused: true },
    { mediaReadyState: "ended" as const },
    { mediaEnabled: false }
  ]) {
    assert.equal(
      isPublishedMicrophoneLive({
        publicationExists: true,
        publicationMuted: false,
        upstreamPaused: false,
        mediaReadyState: "live",
        mediaEnabled: true,
        ...unavailableState
      }),
      false
    );
  }
});

test("a stale join cannot reset a newer active join", () => {
  assert.equal(
    shouldTreatJoinFailureAsCancelled({
      explicitCancellation: false,
      stageTimeout: false,
      signalAborted: true,
      attemptActive: false,
      roomActive: false
    }),
    true
  );
});

test("the active join still reports its own stage timeout", () => {
  assert.equal(
    shouldTreatJoinFailureAsCancelled({
      explicitCancellation: false,
      stageTimeout: true,
      signalAborted: true,
      attemptActive: false,
      roomActive: true
    }),
    false
  );
});

test("Linux microphone failures preserve useful PipeWire guidance", () => {
  const missingDevice = Object.assign(new Error("Requested device not found"), {
    name: "NotFoundError"
  });
  const busyDevice = Object.assign(new Error("Could not start audio source"), {
    name: "NotReadableError"
  });

  assert.equal(classifyVoiceJoinMicrophoneFailure(missingDevice), "missing-device");
  assert.match(getVoiceJoinMicrophoneFailureMessage(missingDevice, true), /Omarchy audio settings/u);
  assert.equal(classifyVoiceJoinMicrophoneFailure(busyDevice), "device-busy");
  assert.match(getVoiceJoinMicrophoneFailureMessage(busyDevice, true), /PipeWire/u);
});

test("permission and publish failures get distinct recovery instructions", () => {
  const denied = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
  const publish = new Error("Microphone publication did not become live");

  assert.equal(classifyVoiceJoinMicrophoneFailure(denied), "permission");
  assert.match(getVoiceJoinMicrophoneFailureMessage(denied, false), /Allow microphone access/u);
  assert.equal(classifyVoiceJoinMicrophoneFailure(publish), "publish");
  assert.match(getVoiceJoinMicrophoneFailureMessage(publish, false), /joined voice/u);
});
