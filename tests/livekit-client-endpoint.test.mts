import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  getLiveKitEndpointDetails,
  normalizeLiveKitServerUrl,
  resolveLiveKitServerUrl
} from "../lib/livekit-client-endpoint.ts";

test("server-provided self-hosted endpoints override stale client fallbacks", () => {
  const resolved = resolveLiveKitServerUrl(
    "wss://livekit.sovchat.com",
    "wss://legacy-project.livekit.cloud"
  );

  assert.equal(resolved, "wss://livekit.sovchat.com");
  assert.deepEqual(getLiveKitEndpointDetails(resolved), {
    host: "livekit.sovchat.com",
    protocol: "wss",
    deployment: "self-hosted"
  });
});

test("endpoint validation allows secure production and loopback development only", () => {
  assert.equal(normalizeLiveKitServerUrl("https://livekit.sovchat.com"), "wss://livekit.sovchat.com");
  assert.equal(normalizeLiveKitServerUrl("ws://127.0.0.1:7880"), "ws://127.0.0.1:7880");
  assert.equal(normalizeLiveKitServerUrl("ws://livekit.sovchat.com"), null);
  assert.equal(normalizeLiveKitServerUrl("wss://user:secret@livekit.sovchat.com"), null);
  assert.equal(normalizeLiveKitServerUrl("wss://livekit.sovchat.com?token=secret"), null);
});

test("cloud endpoints are explicitly classified for diagnostics", () => {
  assert.equal(
    getLiveKitEndpointDetails("wss://legacy-project.livekit.cloud")?.deployment,
    "cloud"
  );
});

test("both client surfaces use the authoritative endpoint from voice tokens", async () => {
  const voice = await readFile(new URL("../components/voice-room.tsx", import.meta.url), "utf8");
  const popout = await readFile(
    new URL("../components/desktop-stream-popout.tsx", import.meta.url),
    "utf8"
  );

  assert.match(voice, /resolveLiveKitServerUrl\(payload\.serverUrl, fallbackLiveKitUrl\)/);
  assert.match(popout, /resolveLiveKitServerUrl\(payload\.serverUrl, fallbackLiveKitUrl\)/);
});
