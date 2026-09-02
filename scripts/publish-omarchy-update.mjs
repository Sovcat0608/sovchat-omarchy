import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveOmarchyRelease } from "./verify-omarchy-release.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const PUBLIC_BASE_URL = "https://sovchat.com/desktop-updates/omarchy";
const EXPECTED_VPS_USER = "codex";
const EXPECTED_VPS_APP_DIR = "/opt/sovchat";
const MAX_CHILD_OUTPUT_BYTES = 1024 * 1024;
const MAX_APPIMAGE_BYTES = 268435456;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MANIFEST_FETCH_TIMEOUT_MS = 60_000;
const APPIMAGE_FETCH_TIMEOUT_MS = 20 * 60_000;
const PUBLIC_FETCH_POLICY = Object.freeze({ redirect: "error", cache: "no-store" });

export function shellQuote(value) {
  return `'${String(value).replace(/'/gu, `'\\''`)}'`;
}

export function loadEnvFile(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return {};
  }

  const values = {};
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function setting(name, fileEnv, runtimeEnv) {
  return runtimeEnv[name]?.trim() || fileEnv[name]?.trim() || "";
}

function expandHome(value, homeDirectory) {
  return value
    .replace(/^~(?=$|[\\/])/u, homeDirectory)
    .replace(/%USERPROFILE%/giu, homeDirectory)
    .replace(/\$HOME/gu, homeDirectory);
}

function assertSafeRemotePath(value, label) {
  if (!/^\/[A-Za-z0-9._/-]+$/u.test(value) || value.includes("..") || value.includes("//")) {
    throw new Error(`${label} must be an absolute normalized POSIX path.`);
  }
}

export function resolvePublishConfig({
  fileEnv = {},
  runtimeEnv = process.env,
  homeDirectory = os.homedir()
} = {}) {
  const host = setting("SOVCHAT_VPS_HOST", fileEnv, runtimeEnv);
  const user = setting("SOVCHAT_VPS_USER", fileEnv, runtimeEnv) || EXPECTED_VPS_USER;
  const port = setting("SOVCHAT_VPS_PORT", fileEnv, runtimeEnv) || "22";
  const appDir = setting("SOVCHAT_VPS_APP_DIR", fileEnv, runtimeEnv) || EXPECTED_VPS_APP_DIR;
  const fingerprint = setting("SOVCHAT_VPS_HOST_FINGERPRINT", fileEnv, runtimeEnv);
  const rawKeyPath = setting("SOVCHAT_VPS_KEY", fileEnv, runtimeEnv) ||
    path.join(homeDirectory, ".ssh", "codex_hostinger_vps");

  if (!host || !/^(?!-)[A-Za-z0-9.-]+$/u.test(host)) {
    throw new Error("SOVCHAT_VPS_HOST is required and must be a hostname or IPv4 address.");
  }
  if (user !== EXPECTED_VPS_USER) {
    throw new Error(`SOVCHAT_VPS_USER must be exactly ${EXPECTED_VPS_USER}.`);
  }
  if (!/^\d{1,5}$/u.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("SOVCHAT_VPS_PORT must be a valid TCP port.");
  }
  if (!/^SHA256:[A-Za-z0-9+/]{43}=?$/u.test(fingerprint)) {
    throw new Error("SOVCHAT_VPS_HOST_FINGERPRINT must contain an independently verified SHA256 fingerprint.");
  }
  assertSafeRemotePath(appDir, "SOVCHAT_VPS_APP_DIR");
  if (appDir !== EXPECTED_VPS_APP_DIR) {
    throw new Error(`SOVCHAT_VPS_APP_DIR must be exactly ${EXPECTED_VPS_APP_DIR}.`);
  }

  return {
    appDir,
    fingerprint,
    host,
    keyPath: path.resolve(expandHome(rawKeyPath, homeDirectory)),
    port: String(Number(port)),
    publicBaseUrl: PUBLIC_BASE_URL,
    target: `${user}@${host}`,
    updateParent: `${appDir}/static/desktop-updates`,
    updateDir: `${appDir}/static/desktop-updates/omarchy`,
    user
  };
}

function trustedOpenSshBinary(name) {
  const executable = process.platform === "win32" ? `${name}.exe` : name;
  const candidate = process.platform === "win32"
    ? path.join(process.env.WINDIR || "C:\\Windows", "System32", "OpenSSH", executable)
    : path.join("/usr/bin", executable);
  if (!existsSync(candidate)) {
    throw new Error(`Trusted OpenSSH binary is missing: ${candidate}`);
  }
  const stats = lstatSync(candidate);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Trusted OpenSSH binary is not a regular file: ${candidate}`);
  }
  return candidate;
}

function minimalOpenSshEnvironment() {
  const environment = {
    HOME: os.homedir(),
    PATH: process.platform === "win32"
      ? path.join(process.env.WINDIR || "C:\\Windows", "System32", "OpenSSH")
      : "/usr/bin:/bin"
  };
  for (const name of [
    "SystemRoot", "WINDIR", "USERPROFILE", "USERNAME", "USERDOMAIN",
    "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "PROGRAMDATA",
    "COMSPEC", "PATHEXT", "TEMP", "TMP"
  ]) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return environment;
}

function runCapture(command, args, {
  timeoutMs = 60_000,
  maxOutputBytes = MAX_CHILD_OUTPUT_BYTES,
  env = process.env
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      env
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let outputExceeded = false;
    const collect = (target, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        outputExceeded = true;
        child.kill();
        return target;
      }
      return target + chunk;
    };
    child.stdout.on("data", (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = collect(stderr, chunk); });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${path.basename(command)} could not start: ${error.message}`));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (outputExceeded) return reject(new Error(`${path.basename(command)} exceeded its output limit.`));
      if (code === 0) return resolve({ stdout, stderr });
      const detail = (stderr || stdout).trim().slice(-1500);
      reject(new Error(`${path.basename(command)} failed${detail ? `: ${detail}` : "."}`));
    });
  });
}

function getSshSecurityArgs(config, knownHostsPath) {
  return [
    "-F", "none",
    "-i", config.keyPath,
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${knownHostsPath}`,
    "-o", "GlobalKnownHostsFile=none",
    "-o", "KnownHostsCommand=none",
    "-o", "UpdateHostKeys=no",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "ControlPersist=no",
    "-o", "KexAlgorithms=curve25519-sha256",
    "-o", "ConnectTimeout=15"
  ];
}

function runSsh(config, knownHostsPath, remoteCommand, options = {}) {
  return runCapture(
    trustedOpenSshBinary("ssh"),
    [
      ...getSshSecurityArgs(config, knownHostsPath),
      "-p", config.port,
      config.target,
      remoteCommand
    ],
    { ...options, env: minimalOpenSshEnvironment() }
  );
}

function runScp(config, knownHostsPath, source, remotePath, options = {}) {
  return runCapture(
    trustedOpenSshBinary("scp"),
    [
      ...getSshSecurityArgs(config, knownHostsPath),
      "-P", config.port,
      source,
      `${config.target}:${remotePath}`
    ],
    { ...options, env: minimalOpenSshEnvironment() }
  );
}

async function collectHostKeyLines(config, temporaryDirectory, sshEnvironment) {
  try {
    const scan = await runCapture(
      trustedOpenSshBinary("ssh-keyscan"),
      ["-T", "10", "-t", "ed25519", "-p", config.port, config.host],
      { env: sshEnvironment }
    );
    const lines = scan.stdout.split(/\r?\n/u).map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    if (lines.length > 0) return lines;
  } catch {
    // Some Windows ssh-keyscan builds cannot negotiate modern server KEX.
  }

  // Establish only the unauthenticated handshake into an isolated file. No
  // credentials or remote command are accepted until the captured key is
  // verified against the independently configured fingerprint below.
  const candidateKnownHosts = path.join(temporaryDirectory, "handshake_known_hosts");
  try {
    await runCapture(
      trustedOpenSshBinary("ssh"),
      [
        "-F", "none",
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", `UserKnownHostsFile=${candidateKnownHosts}`,
        "-o", "GlobalKnownHostsFile=none",
        "-o", "KnownHostsCommand=none",
        "-o", "UpdateHostKeys=no",
        "-o", "KexAlgorithms=curve25519-sha256",
        "-o", "HostKeyAlgorithms=ssh-ed25519",
        "-o", "PreferredAuthentications=none",
        "-o", "PubkeyAuthentication=no",
        "-o", "PasswordAuthentication=no",
        "-o", "KbdInteractiveAuthentication=no",
        "-o", "NumberOfPasswordPrompts=0",
        "-o", "ConnectTimeout=15",
        "-p", config.port,
        config.target,
        "true"
      ],
      { env: sshEnvironment, timeoutMs: 30_000 }
    );
  } catch {
    // Authentication is deliberately disabled; only the host-key file matters.
  }
  return existsSync(candidateKnownHosts)
    ? readFileSync(candidateKnownHosts, "utf8").split(/\r?\n/u)
      .map((line) => line.trim()).filter(Boolean)
    : [];
}

async function createPinnedKnownHosts(config, temporaryDirectory) {
  const sshEnvironment = minimalOpenSshEnvironment();
  const lines = await collectHostKeyLines(config, temporaryDirectory, sshEnvironment);
  const accepted = [];
  const observedFingerprints = new Set();

  for (let index = 0; index < lines.length; index += 1) {
    const candidatePath = path.join(temporaryDirectory, `host-key-${index}`);
    writeFileSync(candidatePath, `${lines[index]}\n`, { encoding: "utf8", mode: 0o600 });
    const result = await runCapture(
      trustedOpenSshBinary("ssh-keygen"),
      ["-lf", candidatePath, "-E", "sha256"],
      { env: sshEnvironment }
    );
    const fingerprints = [...result.stdout.matchAll(/SHA256:[A-Za-z0-9+/]{43}=?(?=\s|$)/gu)]
      .map((match) => match[0]);
    for (const fingerprint of fingerprints) observedFingerprints.add(fingerprint);
    if (fingerprints.includes(config.fingerprint)) accepted.push(lines[index]);
  }

  if (!accepted.length) {
    const observed = [...observedFingerprints].join(", ") || "none";
    throw new Error(
      `The VPS host key did not match the independently configured fingerprint (observed: ${observed}).`
    );
  }
  const knownHostsPath = path.join(temporaryDirectory, "known_hosts");
  writeFileSync(knownHostsPath, `${accepted.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  return knownHostsPath;
}

export function buildRemotePreflightScript(config) {
  return [
    "set -eu",
    `app_dir=${shellQuote(config.appDir)}`,
    `update_parent=${shellQuote(config.updateParent)}`,
    `update_dir=${shellQuote(config.updateDir)}`,
    `test "$(id -un)" = ${shellQuote(EXPECTED_VPS_USER)}`,
    "test " + '"$(id -u)"' + " -ne 0",
    'static_dir="$app_dir/static"',
    'for root in "$app_dir" "$static_dir" "$update_parent"; do test -d "$root" && test ! -L "$root" && test "$(realpath -e "$root")" = "$root"; done',
    'test -w "$update_parent"',
    'test "$(stat -c %u -- "$update_parent")" = "$(id -u)"',
    'test -z "$(find "$update_parent" -maxdepth 0 -perm /022 -print)"',
    'if test -e "$update_dir" || test -L "$update_dir"; then test -d "$update_dir" && test ! -L "$update_dir" && test "$(realpath -e "$update_dir")" = "$update_dir" && test "$(stat -c %u -- "$update_dir")" = "$(id -u)" && test -z "$(find "$update_dir" -maxdepth 0 -perm /022 -print)"; fi',
    'printf "SOVCHAT_OMARCHY_PREFLIGHT|OK\\n"'
  ].join("\n");
}

function buildPrepareScript(config, publishId) {
  return [
    buildRemotePreflightScript(config),
    `publish_id=${shellQuote(publishId)}`,
    'if test ! -e "$update_dir" && test ! -L "$update_dir"; then mkdir -m 0755 -- "$update_dir"; fi',
    'test -d "$update_dir" && test ! -L "$update_dir" && test "$(realpath -e "$update_dir")" = "$update_dir" && test "$(stat -c %u -- "$update_dir")" = "$(id -u)"',
    'lock_dir="$update_dir/.publish-lock"',
    'incoming="$update_dir/.incoming-$publish_id"',
    'test ! -e "$lock_dir" && test ! -L "$lock_dir"',
    'mkdir -m 0700 -- "$lock_dir"',
    'printf "%s\\n" "$publish_id" > "$lock_dir/owner"',
    'test ! -e "$incoming" && test ! -L "$incoming"',
    'mkdir -m 0700 -- "$incoming"',
    'printf "SOVCHAT_OMARCHY_PREPARED|%s|%s\\n" "$publish_id" "$incoming"'
  ].join("\n");
}

export function buildPromotionScript(config, publishId, release) {
  const backupName = `.latest-linux.yml.${publishId}.bak`;
  return [
    "set -eu",
    `update_dir=${shellQuote(config.updateDir)}`,
    `publish_id=${shellQuote(publishId)}`,
    `app_name=${shellQuote(release.appImage.name)}`,
    `manifest_name=${shellQuote(release.manifest.name)}`,
    `app_hash=${shellQuote(release.appImage.sha512Hex)}`,
    `manifest_hash=${shellQuote(release.manifest.sha512Hex)}`,
    `app_size=${shellQuote(String(release.appImage.size))}`,
    `manifest_size=${shellQuote(String(release.manifest.size))}`,
    `backup_name=${shellQuote(backupName)}`,
    'lock_dir="$update_dir/.publish-lock"',
    'incoming="$update_dir/.incoming-$publish_id"',
    'test -d "$update_dir" && test ! -L "$update_dir" && test "$(realpath -e "$update_dir")" = "$update_dir"',
    'test -d "$lock_dir" && test ! -L "$lock_dir" && test "$(cat "$lock_dir/owner")" = "$publish_id"',
    'for item in "$incoming/$app_name" "$incoming/$manifest_name"; do test -f "$item" && test ! -L "$item"; done',
    'test "$(stat -c %s -- "$incoming/$app_name")" = "$app_size"',
    'test "$(stat -c %s -- "$incoming/$manifest_name")" = "$manifest_size"',
    'test "$(sha512sum -- "$incoming/$app_name" | awk \'{print $1}\')" = "$app_hash"',
    'test "$(sha512sum -- "$incoming/$manifest_name" | awk \'{print $1}\')" = "$manifest_hash"',
    'final_app="$update_dir/$app_name"',
    'final_manifest="$update_dir/$manifest_name"',
    'backup="$update_dir/$backup_name"',
    'had_previous=0',
    'if test -e "$final_app" || test -L "$final_app"; then test -f "$final_app" && test ! -L "$final_app" && test "$(sha512sum -- "$final_app" | awk \'{print $1}\')" = "$app_hash" && rm -- "$incoming/$app_name"; else chmod 0755 "$incoming/$app_name" && mv -T -- "$incoming/$app_name" "$final_app"; fi',
    'if test -e "$final_manifest" || test -L "$final_manifest"; then test -f "$final_manifest" && test ! -L "$final_manifest"; test ! -e "$backup" && test ! -L "$backup"; cp -p --no-clobber "$final_manifest" "$backup"; chmod 0600 "$backup"; had_previous=1; fi',
    'chmod 0644 "$incoming/$manifest_name"',
    'mv -fT -- "$incoming/$manifest_name" "$final_manifest"',
    'rmdir -- "$incoming"',
    'sync -f "$final_app"; sync -f "$final_manifest"',
    'printf "SOVCHAT_OMARCHY_PROMOTED|%s|%s\\n" "$publish_id" "$had_previous"'
  ].join("\n");
}

function buildReconcileScript(config, publishId, release) {
  return [
    "set -eu",
    `update_dir=${shellQuote(config.updateDir)}`,
    `publish_id=${shellQuote(publishId)}`,
    `app_name=${shellQuote(release.appImage.name)}`,
    `manifest_name=${shellQuote(release.manifest.name)}`,
    `app_hash=${shellQuote(release.appImage.sha512Hex)}`,
    `manifest_hash=${shellQuote(release.manifest.sha512Hex)}`,
    'if test -f "$update_dir/$app_name" && test ! -L "$update_dir/$app_name" && test "$(sha512sum -- "$update_dir/$app_name" | awk \'{print $1}\')" = "$app_hash" && test -f "$update_dir/$manifest_name" && test ! -L "$update_dir/$manifest_name" && test "$(sha512sum -- "$update_dir/$manifest_name" | awk \'{print $1}\')" = "$manifest_hash"; then printf "SOVCHAT_OMARCHY_STATE|LIVE\\n"; else printf "SOVCHAT_OMARCHY_STATE|NOT_LIVE\\n"; fi'
  ].join("\n");
}

export function buildRollbackScript(config, publishId, release) {
  const backupName = `.latest-linux.yml.${publishId}.bak`;
  return [
    "set -eu",
    `update_dir=${shellQuote(config.updateDir)}`,
    `publish_id=${shellQuote(publishId)}`,
    `manifest_name=${shellQuote(release.manifest.name)}`,
    `manifest_hash=${shellQuote(release.manifest.sha512Hex)}`,
    `backup_name=${shellQuote(backupName)}`,
    'final_manifest="$update_dir/$manifest_name"',
    'backup="$update_dir/$backup_name"',
    'test -f "$final_manifest" && test ! -L "$final_manifest" && test "$(sha512sum -- "$final_manifest" | awk \'{print $1}\')" = "$manifest_hash"',
    'if test -f "$backup" && test ! -L "$backup"; then chmod 0644 "$backup"; mv -fT -- "$backup" "$final_manifest"; sync -f "$final_manifest"; else rm -- "$final_manifest"; fi',
    'printf "SOVCHAT_OMARCHY_ROLLBACK|OK\\n"'
  ].join("\n");
}

export function buildCleanupScript(config, publishId, release) {
  const backupName = `.latest-linux.yml.${publishId}.bak`;
  return [
    "set -eu",
    `update_dir=${shellQuote(config.updateDir)}`,
    `publish_id=${shellQuote(publishId)}`,
    `app_name=${shellQuote(release.appImage.name)}`,
    `manifest_name=${shellQuote(release.manifest.name)}`,
    `backup_name=${shellQuote(backupName)}`,
    'incoming="$update_dir/.incoming-$publish_id"',
    'lock_dir="$update_dir/.publish-lock"',
    'if test -d "$incoming" && test ! -L "$incoming"; then for name in "$app_name" "$manifest_name"; do item="$incoming/$name"; if test -f "$item" && test ! -L "$item"; then rm -- "$item"; fi; done; rmdir -- "$incoming"; fi',
    'backup="$update_dir/$backup_name"',
    'if test -f "$backup" && test ! -L "$backup"; then rm -- "$backup"; fi',
    'if test -d "$lock_dir" && test ! -L "$lock_dir" && test "$(cat "$lock_dir/owner")" = "$publish_id"; then rm -- "$lock_dir/owner"; rmdir -- "$lock_dir"; fi',
    'printf "SOVCHAT_OMARCHY_CLEANUP|OK\\n"'
  ].join("\n");
}

function assertedContentLength(response, { expectedBytes, maxBytes, label }) {
  const rawLength = response.headers.get("content-length");
  if (rawLength === null) return null;
  if (!/^\d+$/u.test(rawLength)) {
    throw new Error(`${label} returned an invalid Content-Length.`);
  }
  const contentLength = Number(rawLength);
  if (!Number.isSafeInteger(contentLength) || contentLength > maxBytes) {
    throw new Error(`${label} exceeds the permitted response size.`);
  }
  if (expectedBytes !== undefined && contentLength !== expectedBytes) {
    throw new Error(`${label} Content-Length does not match the reviewed release.`);
  }
  return contentLength;
}

async function consumeBoundedResponse(response, {
  expectedBytes,
  maxBytes,
  label,
  onChunk
}) {
  if (!response.body) throw new Error(`${label} returned an empty response body.`);
  assertedContentLength(response, { expectedBytes, maxBytes, label });
  const reader = response.body.getReader();
  let complete = false;
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes ||
          (expectedBytes !== undefined && totalBytes > expectedBytes)) {
        throw new Error(`${label} exceeds the permitted response size.`);
      }
      onChunk(chunk);
    }
    complete = true;
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (expectedBytes !== undefined && totalBytes !== expectedBytes) {
    throw new Error(`${label} size does not match the reviewed release.`);
  }
  return totalBytes;
}

export async function readBoundedResponse(response, options) {
  const chunks = [];
  await consumeBoundedResponse(response, { ...options, onChunk: (chunk) => chunks.push(chunk) });
  return Buffer.concat(chunks);
}

export async function hashBoundedResponse(response, options) {
  const hash = createHash("sha512");
  const size = await consumeBoundedResponse(response, {
    ...options,
    onChunk: (chunk) => hash.update(chunk)
  });
  return { size, sha512Hex: hash.digest("hex") };
}

async function verifyPublicRelease(config, release, publishId) {
  const cacheBust = `sovchat-release=${encodeURIComponent(publishId)}`;
  const manifestUrl = `${config.publicBaseUrl}/${release.manifest.name}?${cacheBust}`;
  const manifestResponse = await fetch(manifestUrl, {
    ...PUBLIC_FETCH_POLICY,
    signal: AbortSignal.timeout(MANIFEST_FETCH_TIMEOUT_MS)
  });
  if (!manifestResponse.ok) {
    throw new Error(`Public ${release.manifest.name} returned HTTP ${manifestResponse.status}.`);
  }
  const localManifest = readFileSync(release.manifest.path);
  if (localManifest.length > MAX_MANIFEST_BYTES) {
    throw new Error("The reviewed latest-linux.yml exceeds the manifest size limit.");
  }
  const publicManifest = await readBoundedResponse(manifestResponse, {
    expectedBytes: localManifest.length,
    maxBytes: MAX_MANIFEST_BYTES,
    label: "Public latest-linux.yml"
  });
  if (!publicManifest.equals(localManifest)) {
    throw new Error("Public latest-linux.yml does not match the promoted manifest.");
  }

  const appImageUrl = `${config.publicBaseUrl}/${encodeURIComponent(release.appImage.name)}?${cacheBust}`;
  const appImageResponse = await fetch(appImageUrl, {
    ...PUBLIC_FETCH_POLICY,
    signal: AbortSignal.timeout(APPIMAGE_FETCH_TIMEOUT_MS)
  });
  if (!appImageResponse.ok || !appImageResponse.body) {
    throw new Error(`Public AppImage returned HTTP ${appImageResponse.status}.`);
  }
  const publicAppImage = await hashBoundedResponse(appImageResponse, {
    expectedBytes: release.appImage.size,
    maxBytes: MAX_APPIMAGE_BYTES,
    label: "Public AppImage"
  });
  if (publicAppImage.sha512Hex !== release.appImage.sha512Hex) {
    throw new Error("Public AppImage SHA-512 does not match the reviewed release.");
  }
}

async function main() {
  const args = process.argv.slice(2);
  const preflightOnly = args.includes("--preflight");
  const unknownArgs = args.filter((argument) => argument !== "--preflight");
  if (unknownArgs.length > 0) {
    throw new Error(`Unknown publish argument: ${unknownArgs.join(", ")}.`);
  }

  const deployEnvPath = process.env.SOVCHAT_DEPLOY_ENV_FILE
    ? path.resolve(process.env.SOVCHAT_DEPLOY_ENV_FILE)
    : path.join(REPO_ROOT, "deploy.env");
  const config = resolvePublishConfig({
    fileEnv: loadEnvFile(deployEnvPath),
    runtimeEnv: process.env
  });
  if (!existsSync(config.keyPath) || !lstatSync(config.keyPath).isFile() || lstatSync(config.keyPath).isSymbolicLink()) {
    throw new Error("The configured VPS private key does not exist or is not a regular file.");
  }

  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "sovchat-omarchy-publish-"));
  let knownHostsPath = null;
  let publishId = null;
  let release = null;
  let live = false;
  let cleanupAllowed = true;

  try {
    knownHostsPath = await createPinnedKnownHosts(config, temporaryDirectory);
    console.log("VPS identity matched the independently configured host fingerprint.");
    const preflight = await runSsh(config, knownHostsPath, buildRemotePreflightScript(config));
    if (!preflight.stdout.includes("SOVCHAT_OMARCHY_PREFLIGHT|OK")) {
      throw new Error("The VPS did not confirm the Omarchy update-directory preflight.");
    }
    console.log("Read-only Omarchy update-directory preflight passed.");
    if (preflightOnly) return;

    release = resolveOmarchyRelease({
      releaseDir: process.env.SOVCHAT_RELEASE_DIR || undefined
    });
    if (release.appImage.size > MAX_APPIMAGE_BYTES) {
      throw new Error("The reviewed AppImage exceeds the installer maximum size.");
    }
    publishId = `${new Date().toISOString().replace(/[^0-9]/gu, "").slice(0, 14)}-${randomBytes(6).toString("hex")}`;
    const prepare = await runSsh(config, knownHostsPath, buildPrepareScript(config, publishId));
    if (!prepare.stdout.includes(`SOVCHAT_OMARCHY_PREPARED|${publishId}|`)) {
      throw new Error("The VPS did not confirm the unique incoming release directory.");
    }
    const incomingDir = `${config.updateDir}/.incoming-${publishId}`;
    await runScp(config, knownHostsPath, release.appImage.path, `${incomingDir}/${release.appImage.name}`, {
      timeoutMs: 20 * 60_000
    });
    await runScp(config, knownHostsPath, release.manifest.path, `${incomingDir}/${release.manifest.name}`, {
      timeoutMs: 2 * 60_000
    });

    cleanupAllowed = false;
    try {
      const promotion = await runSsh(
        config,
        knownHostsPath,
        buildPromotionScript(config, publishId, release),
        { timeoutMs: 10 * 60_000 }
      );
      live = promotion.stdout.includes(`SOVCHAT_OMARCHY_PROMOTED|${publishId}|`);
    } catch (error) {
      const reconciliation = await runSsh(
        config,
        knownHostsPath,
        buildReconcileScript(config, publishId, release)
      );
      live = reconciliation.stdout.includes("SOVCHAT_OMARCHY_STATE|LIVE");
      if (!live) throw error;
    }
    if (!live) throw new Error("The VPS did not confirm the promoted Omarchy release.");

    try {
      await verifyPublicRelease(config, release, publishId);
    } catch (error) {
      try {
        await runSsh(config, knownHostsPath, buildRollbackScript(config, publishId, release));
        live = false;
        cleanupAllowed = true;
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Public verification and rollback both failed; the remote backup and publish lock were preserved for manual recovery."
        );
      }
      throw error;
    }

    cleanupAllowed = true;
    console.log(`Omarchy update ${release.version} is live with a verified manifest, size, and SHA-512.`);
    console.log("The AppImage was promoted before latest-linux.yml; no web app or database was changed.");
  } finally {
    if (knownHostsPath && publishId && release && cleanupAllowed) {
      try {
        await runSsh(config, knownHostsPath, buildCleanupScript(config, publishId, release));
      } catch (error) {
        console.error(`Remote publish cleanup needs inspection: ${error.message}`);
        if (live) process.exitCode = 1;
      }
    } else if (knownHostsPath && publishId && release && !cleanupAllowed) {
      console.error(`Remote recovery state was preserved for publish ${publishId}; do not remove its lock or backup without inspection.`);
    }
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(`Omarchy updater publish aborted: ${error.message}`);
    process.exitCode = 1;
  });
}
