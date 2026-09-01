const packageJson = require("./package.json");

const packageVersion = typeof packageJson.version === "string" ? packageJson.version.trim() : "";
const prereleaseLabel = packageVersion.includes("-")
  ? packageVersion.slice(packageVersion.indexOf("-") + 1)
  : "";
const buildChannel =
  process.env.SOVCHAT_BUILD_CHANNEL?.trim().toLowerCase() || (prereleaseLabel ? "wip" : "stable");
const desktopRuntimeDependencies = [
  "argparse",
  "builder-util-runtime",
  "debug",
  "electron-updater",
  "fs-extra",
  "graceful-fs",
  "js-yaml",
  "jsonfile",
  "lazy-val",
  "lodash.escaperegexp",
  "lodash.isequal",
  "ms",
  "sax",
  "semver",
  "tiny-typed-emitter",
  "universalify"
];

module.exports = {
  appId: "com.sovchat.omarchy",
  productName: "SovChat Omarchy",
  executableName: "SovChatOmarchy",
  asar: true,
  icon: "images/icon-512.png",
  publish: [
    {
      provider: "generic",
      url: process.env.SOVCHAT_UPDATE_FEED_URL || "https://sovchat.com/desktop-updates/omarchy"
    }
  ],
  directories: {
    output: process.env.SOVCHAT_ELECTRON_OUTPUT_DIR || "release/omarchy"
  },
  files: [
    "electron/**/*",
    "package.json",
    "!node_modules/**/*",
    ...desktopRuntimeDependencies.map((dependency) => `node_modules/${dependency}/**/*`)
  ],
  extraResources: [
    {
      from: "images/icon-512.png",
      to: "images/icon-512.png"
    }
  ],
  extraMetadata: {
    main: "electron/main.cjs",
    sovchatBuildChannel: buildChannel,
    sovchatVariant: "omarchy"
  },
  linux: {
    icon: "images/icon-512.png",
    category: "Network;Chat",
    target: [
      {
        target: "AppImage",
        arch: ["x64"]
      },
      {
        target: "tar.gz",
        arch: ["x64"]
      }
    ]
  },
  appImage: {
    artifactName: "SovChat-Omarchy-${version}-${arch}.${ext}",
    executableArgs: ["--enable-sandbox"]
  }
};
