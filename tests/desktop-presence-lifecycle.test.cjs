const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");

test("desktop exit keeps an authenticated offline path alive in the main process", async () => {
  const [main, preload, desktopAuth, appShell] = await Promise.all([
    readFile(path.join(__dirname, "..", "electron", "main.cjs"), "utf8"),
    readFile(path.join(__dirname, "..", "electron", "preload.cjs"), "utf8"),
    readFile(path.join(__dirname, "..", "lib", "desktop-auth.ts"), "utf8"),
    readFile(path.join(__dirname, "..", "components", "app-shell.tsx"), "utf8")
  ]);

  assert.match(preload, /desktop:presence-token-sync/);
  assert.match(desktopAuth, /syncPresenceSessionToken\(token\)/);
  assert.match(desktopAuth, /syncPresenceSessionToken\(null\)/);
  assert.match(main, /markDesktopPresenceOffline\("app-quit"\)/);
  assert.match(main, /event\.preventDefault\(\)/);
  assert.match(main, /PRESENCE_OFFLINE_TIMEOUT_MS/);
  assert.match(appShell, /!isDesktopShell[\s\S]*navigator\.sendBeacon/);
  assert.match(appShell, /apiFetch\("\/api\/presence\/offline"[\s\S]*keepalive:\s*true/);
});
