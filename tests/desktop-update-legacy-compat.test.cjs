const assert = require("node:assert/strict");
const test = require("node:test");
const semver = require("semver");
const { AppUpdater } = require("electron-updater/out/AppUpdater.js");

const {
  STABLE_UPDATE_MANIFEST_CHANNEL,
  resolveDesktopUpdatePolicy
} = require("../electron/update-policy.cjs");

const RELEASE_VERSION = "0.4.8";

function shouldReceiveLatestManifestPing(currentVersion, manifestVersion) {
  const policy = resolveDesktopUpdatePolicy({ isPackaged: true });

  return (
    policy.enabled &&
    policy.manifestChannel === STABLE_UPDATE_MANIFEST_CHANNEL &&
    policy.manifestChannel === "latest" &&
    semver.valid(currentVersion) !== null &&
    semver.valid(manifestVersion) !== null &&
    semver.gt(manifestVersion, currentVersion)
  );
}

async function actualUpdaterAccepts(currentVersion, manifestVersion) {
  const updater = new AppUpdater(null, {
    version: currentVersion,
    isPackaged: true,
    appUpdateConfigPath: "unused-app-update.yml",
    userDataPath: "."
  });
  updater.isUpdateSupported = () => true;
  updater.isUserWithinRollout = () => true;
  return updater.isUpdateAvailable({ version: manifestVersion });
}

test("the latest-linux manifest pings older clients already configured for the Omarchy feed", () => {
  for (const currentVersion of ["0.4.4", "0.4.5", "0.4.6", "0.4.7"]) {
    assert.equal(
      shouldReceiveLatestManifestPing(currentVersion, RELEASE_VERSION),
      true,
      `${currentVersion} should accept ${RELEASE_VERSION} from latest-linux.yml`
    );
  }
});

test("an installed 0.4.8 client does not ping itself", () => {
  assert.equal(
    shouldReceiveLatestManifestPing(RELEASE_VERSION, RELEASE_VERSION),
    false
  );
});

test("electron-updater accepts 0.4.8 for every older client on the Omarchy feed", async () => {
  for (const currentVersion of ["0.4.4", "0.4.5", "0.4.6", "0.4.7", "0.4.8-preview.1"]) {
    assert.equal(
      await actualUpdaterAccepts(currentVersion, RELEASE_VERSION),
      true,
      `${currentVersion} should accept ${RELEASE_VERSION}`
    );
  }

  assert.equal(await actualUpdaterAccepts(RELEASE_VERSION, RELEASE_VERSION), false);
  assert.equal(await actualUpdaterAccepts("0.4.9", RELEASE_VERSION), false);
});
