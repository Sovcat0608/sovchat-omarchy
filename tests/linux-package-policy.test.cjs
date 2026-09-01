const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const builderConfig = require("../electron-builder.config.cjs");
const packageJson = require("../package.json");
const electronMainSource = readFileSync(path.resolve(__dirname, "../electron/main.cjs"), "utf8");

test("Omarchy packaging produces its own x64 AppImage and portable archive", () => {
  assert.equal(builderConfig.appId, "com.sovchat.omarchy");
  assert.equal(builderConfig.executableName, "SovChatOmarchy");
  assert.deepEqual(builderConfig.linux.target, [
    { target: "AppImage", arch: ["x64"] },
    { target: "tar.gz", arch: ["x64"] }
  ]);
  assert.equal(builderConfig.publish[0]?.url, "https://sovchat.com/desktop-updates/omarchy");
  assert.equal(packageJson.sovchatVariant, "omarchy");
});

test("Omarchy retains native Hyprland scratchpad controls", () => {
  assert.match(electronMainSource, /app\.setDesktopName\("com\.sovchat\.omarchy"\)/u);
  assert.match(electronMainSource, /tryMinimizeOnHyprland/u);
  assert.match(electronMainSource, /tryRestoreOnHyprland/u);
  assert.match(electronMainSource, /Omarchy scratchpad/u);
});
