const assert = require("node:assert/strict");
const test = require("node:test");
const semver = require("semver");

const {
  STABLE_LINUX_X64_UPDATE_MANIFEST_FILE,
  STABLE_UPDATE_MANIFEST_CHANNEL,
  resolveDesktopUpdatePolicy
} = require("../electron/update-policy.cjs");

test("packaged WIP variants use the published stable update manifest", () => {
  const policy = resolveDesktopUpdatePolicy({ isPackaged: true });

  assert.equal(policy.enabled, true);
  assert.equal(policy.manifestChannel, "latest");
  assert.equal(policy.manifestChannel, STABLE_UPDATE_MANIFEST_CHANNEL);
  assert.equal(STABLE_LINUX_X64_UPDATE_MANIFEST_FILE, "latest-linux.yml");
  assert.equal(policy.allowDowngrade, false);
});

test("source builds only enable update checks through the explicit development override", () => {
  assert.equal(resolveDesktopUpdatePolicy().enabled, false);
  assert.equal(
    resolveDesktopUpdatePolicy({ enableDevUpdates: true }).enabled,
    true
  );
});

test("stable 0.3.52 supersedes its prerelease while 0.3.51 remains a downgrade", () => {
  const currentVersion = "0.3.52-preview.3";
  const policy = resolveDesktopUpdatePolicy({ isPackaged: true });

  assert.equal(semver.gt("0.3.52", currentVersion), true);
  assert.equal(semver.lt("0.3.51", currentVersion), true);
  assert.equal(policy.allowDowngrade, false);
});
