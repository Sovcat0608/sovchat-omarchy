import assert from "node:assert/strict";
import test from "node:test";

import {
  getLiveKitServiceErrorCode,
  isTransientLiveKitServiceError
} from "../lib/livekit-service-errors.ts";

test("nested network failures are treated as transient LiveKit service outages", () => {
  const error = new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect EHOSTUNREACH 149.40.3.69:443"), {
      code: "EHOSTUNREACH"
    })
  });

  assert.equal(isTransientLiveKitServiceError(error), true);
  assert.equal(getLiveKitServiceErrorCode(error), "EHOSTUNREACH");
});

test("common undici and proxy availability failures fail open", () => {
  for (const error of [
    Object.assign(new Error("connection timed out"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
    new Error("503 Service Unavailable"),
    new Error("Bad Gateway"),
    new Error("socket hang up")
  ]) {
    assert.equal(isTransientLiveKitServiceError(error), true);
  }
});

test("configuration and authorization failures are not hidden as outages", () => {
  for (const error of [
    new Error("invalid API secret"),
    new Error("permission denied"),
    Object.assign(new Error("unexpected response"), { code: "EINVAL" })
  ]) {
    assert.equal(isTransientLiveKitServiceError(error), false);
  }
});
