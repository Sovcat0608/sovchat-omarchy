const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  resolveLinuxAppImagePath,
  resolveManagedAppImagePath,
  syncManagedAppImageVersion
} = require("../electron/appimage-install.cjs");

test("packaged Linux updates target the APPIMAGE file instead of the temporary mount", () => {
  const appImagePath = path.resolve("test-home", "SovChat-Omarchy.AppImage");
  assert.equal(
    resolveLinuxAppImagePath({ platform: "linux", isPackaged: true, appImagePath }),
    appImagePath
  );
  assert.equal(
    resolveLinuxAppImagePath({ platform: "win32", isPackaged: true, appImagePath }),
    null
  );
});

test("only the plugin-managed AppImage receives a version sidecar", () => {
  const homeDirectory = path.resolve("test-home");
  const managedPath = path.join(
    homeDirectory,
    ".local",
    "opt",
    "sovchat-omarchy",
    "SovChat-Omarchy.AppImage"
  );

  assert.equal(
    resolveManagedAppImagePath({
      platform: "linux",
      isPackaged: true,
      appImagePath: managedPath,
      homeDirectory
    }),
    managedPath
  );
  assert.equal(
    resolveManagedAppImagePath({
      platform: "linux",
      isPackaged: true,
      appImagePath: path.join(homeDirectory, "Downloads", "SovChat.AppImage"),
      homeDirectory
    }),
    null
  );
});

test("startup atomically synchronizes the managed AppImage version", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sovchat-appimage-version-"));
  const homeDirectory = path.join(root, "home");
  const installDirectory = path.join(homeDirectory, ".local", "opt", "sovchat-omarchy");
  const appImagePath = path.join(installDirectory, "SovChat-Omarchy.AppImage");

  try {
    fs.mkdirSync(installDirectory, { recursive: true });
    fs.writeFileSync(appImagePath, "appimage", "utf8");
    fs.writeFileSync(path.join(installDirectory, "VERSION"), "0.4.5\n", "ascii");

    const result = syncManagedAppImageVersion({
      platform: "linux",
      isPackaged: true,
      appImagePath,
      homeDirectory,
      version: "0.4.6",
      randomBytes: () => Buffer.from("123456789abc", "hex")
    });

    assert.equal(result.status, "synced");
    assert.equal(fs.readFileSync(path.join(installDirectory, "VERSION"), "ascii"), "0.4.6\n");
    assert.deepEqual(
      fs.readdirSync(installDirectory).sort(),
      ["SovChat-Omarchy.AppImage", "VERSION"]
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("startup refuses a redirected version sidecar", { skip: process.platform === "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sovchat-appimage-version-link-"));
  const homeDirectory = path.join(root, "home");
  const installDirectory = path.join(homeDirectory, ".local", "opt", "sovchat-omarchy");
  const appImagePath = path.join(installDirectory, "SovChat-Omarchy.AppImage");
  const outsidePath = path.join(root, "outside-version");

  try {
    fs.mkdirSync(installDirectory, { recursive: true });
    fs.writeFileSync(appImagePath, "appimage", "utf8");
    fs.writeFileSync(outsidePath, "unchanged\n", "ascii");
    fs.symlinkSync(outsidePath, path.join(installDirectory, "VERSION"));

    const result = syncManagedAppImageVersion({
      platform: "linux",
      isPackaged: true,
      appImagePath,
      homeDirectory,
      version: "0.4.6"
    });

    assert.equal(result.status, "failed");
    assert.equal(fs.readFileSync(outsidePath, "ascii"), "unchanged\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
