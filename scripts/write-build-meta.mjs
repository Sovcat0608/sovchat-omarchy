import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(rootDir, "package.json");
const outputPath = path.join(rootDir, "lib", "generated", "build-meta.ts");

function resolveGitDir() {
  const dotGitPath = path.join(rootDir, ".git");

  try {
    const stats = fs.statSync(dotGitPath);
    if (stats.isDirectory()) {
      return dotGitPath;
    }

    const pointer = fs.readFileSync(dotGitPath, "utf8").trim();
    if (pointer.startsWith("gitdir:")) {
      return path.resolve(rootDir, pointer.slice("gitdir:".length).trim());
    }
  } catch {
    // Fall through to the normal dev label.
  }

  return null;
}

function readGitShortSha() {
  const gitDir = resolveGitDir();
  if (!gitDir) {
    return "dev";
  }

  try {
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    if (/^[a-f0-9]{40}$/iu.test(head)) {
      return head.slice(0, 7);
    }

    if (!head.startsWith("ref:")) {
      return "dev";
    }

    const refName = head.slice("ref:".length).trim();
    const looseRefPath = path.join(gitDir, ...refName.split("/"));
    if (fs.existsSync(looseRefPath)) {
      return fs.readFileSync(looseRefPath, "utf8").trim().slice(0, 7);
    }

    const packedRefs = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8");
    const packedRef = packedRefs
      .split(/\r?\n/u)
      .find((line) => !line.startsWith("#") && !line.startsWith("^") && line.endsWith(` ${refName}`));
    return packedRef ? packedRef.split(" ", 1)[0].slice(0, 7) : "dev";
  } catch {
    return "dev";
  }
}

function getGitShortSha() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return readGitShortSha();
  }
}

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const version = typeof packageJson.version === "string" ? packageJson.version : "0.0.0";
const variant = typeof packageJson.sovchatVariant === "string"
  ? packageJson.sovchatVariant.trim().toLowerCase()
  : "";

if (variant !== "omarchy") {
  throw new Error(`This project only builds the Omarchy variant, received: ${variant || "(empty)"}`);
}

const commit = getGitShortSha();
const versionLabel = `v${version} (${commit})`;
const prereleaseLabel = version.includes("-")
  ? version.slice(version.indexOf("-") + 1)
  : "";
const requestedChannel = process.env.SOVCHAT_BUILD_CHANNEL?.trim().toLowerCase() ?? "";
const buildChannel = requestedChannel || (prereleaseLabel ? "wip" : "stable");

if (!/^[a-z][a-z0-9-]*$/u.test(buildChannel)) {
  throw new Error(`Invalid SOVCHAT_BUILD_CHANNEL: ${buildChannel}`);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(
  outputPath,
  [
    `export const APP_BUILD_VERSION = ${JSON.stringify(versionLabel)};`,
    `export const APP_BUILD_COMMIT = ${JSON.stringify(commit)};`,
    `export const APP_BUILD_SEMVER = ${JSON.stringify(version)};`,
    `export const APP_BUILD_CHANNEL = ${JSON.stringify(buildChannel)};`,
    `export const APP_BUILD_VARIANT = ${JSON.stringify(variant)};`,
    ""
  ].join("\n"),
  "utf8"
);
