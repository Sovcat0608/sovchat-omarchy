const STABLE_UPDATE_MANIFEST_CHANNEL = "latest";
const STABLE_LINUX_X64_UPDATE_MANIFEST_FILE = "latest-linux.yml";

function resolveDesktopUpdatePolicy({
  isPackaged = false,
  enableDevUpdates = false
} = {}) {
  return {
    enabled: Boolean(isPackaged || enableDevUpdates),
    manifestChannel: STABLE_UPDATE_MANIFEST_CHANNEL,
    allowDowngrade: false
  };
}

module.exports = {
  STABLE_LINUX_X64_UPDATE_MANIFEST_FILE,
  STABLE_UPDATE_MANIFEST_CHANNEL,
  resolveDesktopUpdatePolicy
};
