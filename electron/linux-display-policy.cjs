function resolveLinuxDisplayBackend(options = {}) {
  if (options.platform !== "linux" || options.hasExplicitSwitch) {
    return null;
  }

  const requested = String(options.requested ?? "")
    .trim()
    .toLowerCase();

  if (requested === "auto") {
    return null;
  }

  if (requested === "wayland") {
    return "wayland";
  }

  return "x11";
}

module.exports = {
  resolveLinuxDisplayBackend
};
