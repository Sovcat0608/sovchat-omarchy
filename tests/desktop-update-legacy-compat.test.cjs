const assert = require("node:assert/strict");
const test = require("node:test");
const semver = require("semver");
const { AppUpdater } = require("electron-updater/out/AppUpdater.js");

const {
  STABLE_UPDATE_MANIFEST_CHANNEL,
  resolveDesktopUpdatePolicy
} = require("../electron/update-policy.cjs");

const PRERELEASE_VERSION = "0.3.52-preview.3";

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

test("a latest-channel prerelease manifest pings legacy 0.3.50 and 0.3.51 clients", () => {
  for (const currentVersion of ["0.3.50", "0.3.51"]) {
    assert.equal(
      shouldReceiveLatestManifestPing(currentVersion, PRERELEASE_VERSION),
      true,
      `${currentVersion} should accept ${PRERELEASE_VERSION} from latest.yml`
    );
  }
});

test("an installed prerelease client does not ping itself", () => {
  assert.equal(
    shouldReceiveLatestManifestPing(PRERELEASE_VERSION, PRERELEASE_VERSION),
    false
  );
});

test("electron-updater's generic feed accepts a newer prerelease for 0.3.50+", async () => {
  for (const currentVersion of ["0.3.50", "0.3.51", "0.3.52-preview.2"]) {
    assert.equal(
      await actualUpdaterAccepts(currentVersion, PRERELEASE_VERSION),
      true,
      `${currentVersion} should accept ${PRERELEASE_VERSION}`
    );
  }

  assert.equal(await actualUpdaterAccepts(PRERELEASE_VERSION, PRERELEASE_VERSION), false);
  assert.equal(await actualUpdaterAccepts("0.3.52", PRERELEASE_VERSION), false);
});
