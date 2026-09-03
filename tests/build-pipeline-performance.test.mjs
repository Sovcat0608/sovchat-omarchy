import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanNextBuildOutputPreservingCache } from "../scripts/next-build-output.mjs";

test("desktop cleanup preserves production cache and removes stale outputs", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "sovchat-omarchy-cache-"));
  try {
    const nextDir = path.join(rootDir, ".next");
    fs.mkdirSync(path.join(nextDir, "cache", "webpack", "client-production"), { recursive: true });
    fs.mkdirSync(path.join(nextDir, "cache", "webpack", "client-development"), { recursive: true });
    fs.mkdirSync(path.join(nextDir, "server"), { recursive: true });
    fs.writeFileSync(path.join(nextDir, "cache", "webpack", "client-production", "cache.bin"), "keep");
    fs.writeFileSync(path.join(nextDir, "cache", "webpack", "client-development", "cache.bin"), "drop");

    const result = cleanNextBuildOutputPreservingCache(rootDir);

    assert.equal(result.cachePreserved, true);
    assert.equal(fs.existsSync(path.join(nextDir, "cache", "webpack", "client-production", "cache.bin")), true);
    assert.equal(fs.existsSync(path.join(nextDir, "cache", "webpack", "client-development")), false);
    assert.equal(fs.existsSync(path.join(nextDir, "server")), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Omarchy build is client-only and uses its own update feed", () => {
  const buildSource = fs.readFileSync(new URL("../scripts/build-desktop.mjs", import.meta.url), "utf8");
  const distSource = fs.readFileSync(new URL("../scripts/dist-linux.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(buildSource, /Prisma|prisma/u);
  assert.match(buildSource, /write-release-highlights\.mjs/u);
  const highlightsSource = fs.readFileSync(
    new URL("../scripts/write-release-highlights.mjs", import.meta.url),
    "utf8"
  );
  assert.match(highlightsSource, /tag[\s\S]*--sort=-version:refname/u);
  assert.match(highlightsSource, /Open account registration/u);
  assert.match(distSource, /--use-prepared-renderer/u);
  assert.match(distSource, /assertPreparedDesktopRenderer/u);
  assert.match(distSource, /desktop-updates\/omarchy/u);
});

test("Omarchy project contains the native plugin and no server or Windows package implementation", () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  const envExample = fs.readFileSync(new URL("../.env.example", import.meta.url), "utf8");

  assert.equal(packageJson.name, "sovchat-omarchy");
  assert.equal(packageJson.sovchatVariant, "omarchy");
  assert.equal(packageJson.scripts["dist:omarchy"], "node scripts/dist-linux.mjs");
  assert.equal(manifest.id, "com.sovchat.omarchy");
  assert.equal(fs.existsSync(new URL("../BarWidget.qml", import.meta.url)), true);
  assert.equal(fs.existsSync(new URL("../bin/sovchat-safe-install.py", import.meta.url)), true);
  assert.equal(fs.existsSync(new URL("../prisma", import.meta.url)), false);
  assert.equal(fs.existsSync(new URL("../app/api", import.meta.url)), false);
  assert.equal(fs.existsSync(new URL("../variants", import.meta.url)), false);
  assert.doesNotMatch(envExample, /DATABASE_URL|SESSION_SECRET|SMTP_|LIVEKIT_API_SECRET/u);
});

test("Omarchy security workflow validates the descriptor-safe installer", () => {
  const workflow = fs.readFileSync(
    new URL("../.github/workflows/security-tests.yml", import.meta.url),
    "utf8"
  );

  assert.match(workflow, /sovchat-safe-install\.py/u);
  assert.match(workflow, /unittest discover/u);
});
