import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseEnv } from "dotenv";
import { assertPreparedDesktopRenderer } from "./prepared-desktop-renderer.mjs";

function run(command, args, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: false,
      env: {
        ...process.env,
        ...envOverrides
      }
    });

    child.once("exit", (code) => {
      const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (code === 0) {
        console.log(`[sovchat:build] ${path.basename(command)}: ${elapsedSeconds}s`);
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}.`));
    });
  });
}

const packageJson = JSON.parse(readFileSync(path.resolve("package.json"), "utf8"));
const version = typeof packageJson.version === "string" ? packageJson.version.trim() : "";

if (!version) {
  throw new Error("package.json is missing a version.");
}

const outputDir = path.resolve("release", "omarchy");
const updateFeedUrl = "https://sovchat.com/desktop-updates/omarchy";
const args = new Set(process.argv.slice(2));
const usePreparedRenderer = args.has("--use-prepared-renderer");
rmSync(outputDir, { recursive: true, force: true });

const buildEnv = [".env.example", ".env.local"].reduce((values, fileName) => {
  const filePath = path.resolve(fileName);
  return existsSync(filePath)
    ? { ...values, ...parseEnv(readFileSync(filePath, "utf8")) }
    : values;
}, {});

if (usePreparedRenderer) {
  const prepared = assertPreparedDesktopRenderer();
  console.log(
    `Using prepared desktop renderer v${prepared.version} (${prepared.commit}), ` +
      `${prepared.fileCount} files verified.`
  );
} else {
  await run(process.execPath, [path.resolve("scripts", "build-desktop.mjs")], buildEnv);
}
await run(
  process.execPath,
  [
    path.resolve("node_modules", "electron-builder", "cli.js"),
    "--config",
    "electron-builder.config.cjs",
    "--linux",
    "AppImage",
    "tar.gz",
    "--x64"
  ],
  {
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    SOVCHAT_ELECTRON_OUTPUT_DIR: outputDir,
    SOVCHAT_UPDATE_FEED_URL: updateFeedUrl
  }
);

const outputEntries = existsSync(outputDir) ? readdirSync(outputDir) : [];
const appImages = outputEntries
  .filter((entry) => entry.endsWith(".AppImage"))
  .map((entry) => path.join(outputDir, entry));
const portableArchives = outputEntries
  .filter((entry) => entry.endsWith(".tar.gz"))
  .map((entry) => path.join(outputDir, entry));

if (appImages.length !== 1 || portableArchives.length !== 1) {
  throw new Error(
    `Expected one SovChat Omarchy AppImage and one portable archive for version ${version}; found ${appImages.length} AppImage(s) and ${portableArchives.length} archive(s) in ${outputDir}.`
  );
}

for (const [label, artifactPath] of [
  ["SovChat Omarchy AppImage", appImages[0]],
  ["SovChat Omarchy portable archive", portableArchives[0]]
]) {
  console.log(`${label}: ${artifactPath}`);
  console.log(`Size: ${statSync(artifactPath).size} bytes`);
}
