const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MANAGED_APPIMAGE_RELATIVE_PATH = [
  ".local",
  "opt",
  "sovchat-omarchy",
  "SovChat-Omarchy.AppImage"
];

function normalizeAppVersion(value) {
  const version = typeof value === "string" ? value.trim() : "";
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version) ? version : null;
}

function resolveLinuxAppImagePath({
  platform = process.platform,
  isPackaged = false,
  appImagePath = process.env.APPIMAGE,
  pathModule = path
} = {}) {
  const candidate = typeof appImagePath === "string" ? appImagePath.trim() : "";
  if (platform !== "linux" || !isPackaged || !candidate || !pathModule.isAbsolute(candidate)) {
    return null;
  }

  return pathModule.resolve(candidate);
}

function resolveManagedAppImagePath({
  homeDirectory,
  pathModule = path,
  ...options
} = {}) {
  const appImagePath = resolveLinuxAppImagePath({ ...options, pathModule });
  const home = typeof homeDirectory === "string" ? homeDirectory.trim() : "";
  if (!appImagePath || !home || !pathModule.isAbsolute(home)) {
    return null;
  }

  const managedPath = pathModule.resolve(home, ...MANAGED_APPIMAGE_RELATIVE_PATH);
  return appImagePath === managedPath ? managedPath : null;
}

function syncManagedAppImageVersion({
  version,
  homeDirectory,
  fsModule = fs,
  pathModule = path,
  randomBytes = crypto.randomBytes,
  ...options
} = {}) {
  const normalizedVersion = normalizeAppVersion(version);
  const appImagePath = resolveManagedAppImagePath({
    ...options,
    homeDirectory,
    pathModule
  });

  if (!normalizedVersion || !appImagePath) {
    return { status: "skipped", reason: "unmanaged-or-invalid" };
  }

  const installDirectory = pathModule.dirname(appImagePath);
  const versionPath = pathModule.join(installDirectory, "VERSION");
  const temporaryPath = pathModule.join(
    installDirectory,
    `.VERSION.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  );

  try {
    const installStats = fsModule.lstatSync(installDirectory);
    const appImageStats = fsModule.lstatSync(appImagePath);
    if (!installStats.isDirectory() || installStats.isSymbolicLink()) {
      throw new Error("managed install directory is not a real directory");
    }
    if (!appImageStats.isFile() || appImageStats.isSymbolicLink()) {
      throw new Error("managed AppImage is not a regular file");
    }
    if (fsModule.realpathSync(installDirectory) !== installDirectory) {
      throw new Error("managed install directory is redirected");
    }
    if (fsModule.existsSync(versionPath)) {
      const versionStats = fsModule.lstatSync(versionPath);
      if (!versionStats.isFile() || versionStats.isSymbolicLink()) {
        throw new Error("managed version sidecar is not a regular file");
      }
    }

    fsModule.writeFileSync(temporaryPath, `${normalizedVersion}\n`, {
      encoding: "ascii",
      flag: "wx",
      mode: 0o600
    });
    fsModule.chmodSync(temporaryPath, 0o644);
    fsModule.renameSync(temporaryPath, versionPath);
    return { status: "synced", path: versionPath, version: normalizedVersion };
  } catch (error) {
    try {
      fsModule.unlinkSync(temporaryPath);
    } catch (_cleanupError) {
      // The temporary file may not have been created.
    }
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

module.exports = {
  MANAGED_APPIMAGE_RELATIVE_PATH,
  normalizeAppVersion,
  resolveLinuxAppImagePath,
  resolveManagedAppImagePath,
  syncManagedAppImageVersion
};
