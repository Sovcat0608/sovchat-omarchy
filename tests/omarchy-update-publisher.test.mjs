import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";

import {
  buildCleanupScript,
  buildPromotionScript,
  buildRemotePreflightScript,
  hashBoundedResponse,
  readBoundedResponse,
  resolvePublishConfig,
  shellQuote
} from "../scripts/publish-omarchy-update.mjs";

test("publisher configuration is pinned to the Omarchy feed and unprivileged account", () => {
  const homeDirectory = path.resolve("publisher-home");
  const config = resolvePublishConfig({
    homeDirectory,
    runtimeEnv: {},
    fileEnv: {
      SOVCHAT_VPS_HOST: "203.0.113.10",
      SOVCHAT_VPS_USER: "codex",
      SOVCHAT_VPS_PORT: "22",
      SOVCHAT_VPS_KEY: "%USERPROFILE%/.ssh/codex_hostinger_vps",
      SOVCHAT_VPS_APP_DIR: "/opt/sovchat",
      SOVCHAT_VPS_HOST_FINGERPRINT: `SHA256:${"A".repeat(43)}`
    }
  });

  assert.equal(config.target, "codex@203.0.113.10");
  assert.equal(config.updateDir, "/opt/sovchat/static/desktop-updates/omarchy");
  assert.equal(config.publicBaseUrl, "https://sovchat.com/desktop-updates/omarchy");
  assert.equal(config.keyPath, path.resolve(homeDirectory, ".ssh/codex_hostinger_vps"));
});

test("publisher rejects privileged users and unpinned app directories", () => {
  const base = {
    SOVCHAT_VPS_HOST: "203.0.113.10",
    SOVCHAT_VPS_HOST_FINGERPRINT: `SHA256:${"A".repeat(43)}`
  };
  assert.throws(
    () => resolvePublishConfig({ runtimeEnv: {}, fileEnv: { ...base, SOVCHAT_VPS_USER: "root" } }),
    /must be exactly codex/u
  );
  assert.throws(
    () => resolvePublishConfig({ runtimeEnv: {}, fileEnv: { ...base, SOVCHAT_VPS_APP_DIR: "/tmp" } }),
    /must be exactly \/opt\/sovchat/u
  );
});

test("remote preflight is read-only and checks canonical non-symlink directories", () => {
  const config = {
    appDir: "/opt/sovchat",
    updateParent: "/opt/sovchat/static/desktop-updates",
    updateDir: "/opt/sovchat/static/desktop-updates/omarchy"
  };
  const script = buildRemotePreflightScript(config);
  assert.match(script, /id -un/u);
  assert.match(script, /realpath -e/u);
  assert.match(script, /test ! -L/u);
  assert.doesNotMatch(script, /\b(?:mkdir|mv|rm|cp|chmod)\b/u);
  assert.match(script, /stat -c %u/u);
  assert.match(script, /-perm \/022/u);
});

test("shell quoting protects remote values", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test("public response verification rejects declared and streamed oversize bodies", async () => {
  await assert.rejects(
    readBoundedResponse(
      new Response("small", { headers: { "content-length": "100" } }),
      { maxBytes: 10, label: "fixture" }
    ),
    /exceeds the permitted response size/u
  );

  const streamed = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5, 6]));
      controller.close();
    }
  }));
  await assert.rejects(
    readBoundedResponse(streamed, { maxBytes: 5, label: "fixture" }),
    /exceeds the permitted response size/u
  );
});

test("public AppImage verification hashes incrementally and enforces exact bytes", async () => {
  const bytes = Buffer.from("reviewed-appimage");
  const result = await hashBoundedResponse(new Response(bytes), {
    expectedBytes: bytes.length,
    maxBytes: bytes.length,
    label: "fixture"
  });
  assert.equal(result.size, bytes.length);
  assert.equal(result.sha512Hex, createHash("sha512").update(bytes).digest("hex"));
  await assert.rejects(
    hashBoundedResponse(new Response(bytes), {
      expectedBytes: bytes.length + 1,
      maxBytes: bytes.length + 1,
      label: "fixture"
    }),
    /size does not match/u
  );
});

test("promotion orders the immutable AppImage before the mutable manifest", () => {
  const config = { updateDir: "/opt/sovchat/static/desktop-updates/omarchy" };
  const release = {
    appImage: { name: "SovChat-Omarchy-0.4.7-x86_64.AppImage", sha512Hex: "a", size: 1 },
    manifest: { name: "latest-linux.yml", sha512Hex: "b", size: 1 }
  };
  const script = buildPromotionScript(config, "publish-id", release);
  assert.ok(script.indexOf('mv -T -- "$incoming/$app_name" "$final_app"') <
    script.indexOf('mv -fT -- "$incoming/$manifest_name" "$final_manifest"'));
});

test("cleanup only removes a lock owned by the current publish", () => {
  const script = buildCleanupScript(
    { updateDir: "/opt/sovchat/static/desktop-updates/omarchy" },
    "publish-id",
    {
      appImage: { name: "SovChat-Omarchy-0.4.7-x86_64.AppImage" },
      manifest: { name: "latest-linux.yml" }
    }
  );
  assert.match(script, /cat "\$lock_dir\/owner"/u);
  assert.match(script, /= "\$publish_id"/u);
});
