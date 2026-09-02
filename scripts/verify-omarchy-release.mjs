import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSON_SCHEMA, load as loadYaml } from "js-yaml";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const UPDATE_MANIFEST_NAME = "latest-linux.yml";
const CHECKSUMS_NAME = "SHA512SUMS";

function hashFile(filePath, encoding) {
  const hash = createHash("sha512");
  hash.update(readFileSync(filePath));
  return hash.digest(encoding);
}

function releaseFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Required Omarchy release file is missing: ${filePath}`);
  }
  const stats = lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Omarchy release files must be regular non-symlink files: ${filePath}`);
  }
  if (stats.size <= 0) {
    throw new Error(`Omarchy release files must not be empty: ${filePath}`);
  }

  return {
    path: filePath,
    name: path.basename(filePath),
    size: stats.size,
    sha512: hashFile(filePath, "base64"),
    sha512Hex: hashFile(filePath, "hex")
  };
}

function assertArtifactMagic(appImage, archive) {
  const appHeader = readFileSync(appImage.path).subarray(0, 20);
  if (appHeader.length < 20 || !appHeader.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
      appHeader[4] !== 2 || appHeader[5] !== 1 || appHeader.readUInt16LE(18) !== 62) {
    throw new Error("The Omarchy AppImage is not a 64-bit little-endian x86-64 ELF executable.");
  }
  const archiveHeader = readFileSync(archive.path).subarray(0, 2);
  if (!archiveHeader.equals(Buffer.from([0x1f, 0x8b]))) {
    throw new Error("The Omarchy portable archive is not gzip data.");
  }
}

export function parseOmarchyUpdateManifest(rawText) {
  const text = String(rawText).replace(/\r\n/gu, "\n");
  if (/(?:^|[\s:[{,?-])[&*][^\s\]}:,]+/mu.test(text) ||
      /^[ \t]*(?:<<[ \t]*:|\?[ \t])/mu.test(text) ||
      /^(?:---|\.\.\.)[ \t]*$/mu.test(text)) {
    throw new Error("latest-linux.yml aliases, merge keys, complex keys, and extra documents are forbidden.");
  }

  const manifest = loadYaml(text, { schema: JSON_SCHEMA, json: false });
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("latest-linux.yml must contain one plain mapping.");
  }
  return manifest;
}

export function resolveOmarchyRelease({
  releaseDir = path.join(REPO_ROOT, "release", "omarchy"),
  packagePath = path.join(REPO_ROOT, "package.json")
} = {}) {
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  const version = typeof packageJson.version === "string" ? packageJson.version.trim() : "";
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error("package.json contains an invalid release version.");
  }

  const artifactName = `SovChat-Omarchy-${version}-x86_64.AppImage`;
  const appImage = releaseFile(path.join(releaseDir, artifactName));
  const manifest = releaseFile(path.join(releaseDir, UPDATE_MANIFEST_NAME));
  const archives = existsSync(releaseDir)
    ? readdirSync(releaseDir).filter((name) => name.endsWith(".tar.gz"))
    : [];
  if (archives.length !== 1) {
    throw new Error(`Expected exactly one Omarchy portable archive; found ${archives.length}.`);
  }
  const archive = releaseFile(path.join(releaseDir, archives[0]));
  const checksums = releaseFile(path.join(releaseDir, CHECKSUMS_NAME));
  assertArtifactMagic(appImage, archive);
  const manifestDocument = parseOmarchyUpdateManifest(readFileSync(manifest.path, "utf8"));

  if (manifestDocument.version !== version) {
    throw new Error(`latest-linux.yml version ${manifestDocument.version ?? "(missing)"} does not match ${version}.`);
  }
  if (!Array.isArray(manifestDocument.files) || manifestDocument.files.length !== 1) {
    throw new Error("latest-linux.yml must describe exactly one AppImage file.");
  }
  const manifestFile = manifestDocument.files[0];
  if (!manifestFile || typeof manifestFile !== "object" || Array.isArray(manifestFile)) {
    throw new Error("latest-linux.yml files[0] is invalid.");
  }
  if (manifestFile.url !== appImage.name || manifestDocument.path !== appImage.name) {
    throw new Error("latest-linux.yml does not point to the exact versioned Omarchy AppImage.");
  }
  if (manifestFile.sha512 !== appImage.sha512 || manifestDocument.sha512 !== appImage.sha512) {
    throw new Error("latest-linux.yml SHA-512 does not match the AppImage.");
  }
  if (Number(manifestFile.size) !== appImage.size) {
    throw new Error("latest-linux.yml size does not match the AppImage.");
  }
  if ("stagingPercentage" in manifestDocument && Number(manifestDocument.stagingPercentage) !== 100) {
    throw new Error("Omarchy update manifests must not stage a partial rollout.");
  }

  const expectedChecksums = new Map([
    [appImage.name, appImage.sha512Hex],
    [archive.name, archive.sha512Hex],
    [manifest.name, manifest.sha512Hex]
  ]);
  const checksumLines = readFileSync(checksums.path, "utf8").replace(/\r\n/gu, "\n")
    .split("\n").filter(Boolean);
  if (checksumLines.length !== expectedChecksums.size) {
    throw new Error("SHA512SUMS must contain exactly the AppImage, archive, and update manifest.");
  }
  const seen = new Set();
  for (const line of checksumLines) {
    const match = line.match(/^([a-f0-9]{128})  (.+)$/u);
    if (!match || !expectedChecksums.has(match[2]) || seen.has(match[2])) {
      throw new Error("SHA512SUMS contains an invalid, unexpected, or duplicate entry.");
    }
    if (expectedChecksums.get(match[2]) !== match[1]) {
      throw new Error(`SHA512SUMS does not match ${match[2]}.`);
    }
    seen.add(match[2]);
  }
  if (seen.size !== expectedChecksums.size) {
    throw new Error("SHA512SUMS is missing a required release artifact.");
  }

  return {
    version,
    releaseDir: path.resolve(releaseDir),
    appImage,
    archive,
    checksums,
    manifest,
    manifestDocument
  };
}

function main() {
  const unknownArgs = process.argv.slice(2);
  if (unknownArgs.length > 0) {
    throw new Error(`Unknown verification argument: ${unknownArgs.join(", ")}`);
  }
  const release = resolveOmarchyRelease({
    releaseDir: process.env.SOVCHAT_RELEASE_DIR || undefined
  });
  console.log(`Verified Omarchy v${release.version} updater manifest and artifacts.`);
  console.log(`AppImage: ${release.appImage.name}`);
  console.log(`AppImage bytes: ${release.appImage.size}`);
  console.log(`AppImage SHA-512: ${release.appImage.sha512Hex}`);
  console.log(`Manifest: ${release.manifest.name}`);
  console.log(`Archive: ${release.archive.name}`);
  console.log(`Checksums: ${release.checksums.name}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    main();
  } catch (error) {
    console.error(`Omarchy release verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}

export { CHECKSUMS_NAME, UPDATE_MANIFEST_NAME };
