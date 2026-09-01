import assert from "node:assert/strict";
import test from "node:test";

import {
  getLiveKitErrorDetails,
  getLiveKitErrorMessage,
  summarizeLiveKitLogContext
} from "../lib/livekit-client-error-details.ts";

test("plain LiveKit error objects retain useful fields instead of becoming object Object", () => {
  const details = getLiveKitErrorDetails({
    name: "ConnectionError",
    message: "signal websocket closed during connection",
    code: "SIGNAL_CONNECTION_FAILED",
    statusCode: 502,
    closeCode: 1006
  });

  assert.deepEqual(details, {
    error: "signal websocket closed during connection",
    errorName: "ConnectionError",
    errorCode: "SIGNAL_CONNECTION_FAILED",
    status: 502,
    closeCode: 1006
  });
  assert.doesNotMatch(getLiveKitErrorMessage(details), /\[object Object\]/);
});

test("SDK log contexts expose close and nested fetch details", () => {
  const details = summarizeLiveKitLogContext({
    state: "connecting",
    closeCode: 1006,
    error: {
      name: "TypeError",
      message: "Failed to fetch region settings",
      status: 403
    }
  });

  assert.equal(details.status, "connecting");
  assert.equal(details.closeCode, 1006);
  assert.equal(details.errorName, "TypeError");
  assert.equal(details.error, "Failed to fetch region settings");
});
