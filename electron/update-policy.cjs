const STABLE_UPDATE_MANIFEST_CHANNEL = "latest";

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
  STABLE_UPDATE_MANIFEST_CHANNEL,
  resolveDesktopUpdatePolicy
};
