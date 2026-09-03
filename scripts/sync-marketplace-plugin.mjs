#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_PLUGIN_ID = "com.sovchat.omarchy";
const EXPECTED_ORIGIN =
  /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)Sovcat0608\/sovchat-omarchy-plugin(?:\.git)?\/?$/i;

export const SHARED_FILES = Object.freeze([
  ".github/workflows/security-tests.yml",
  "BarWidget.qml",
  "Panel.qml",
  "LICENSE",
  "manifest.json",
  "sovchat.svg",
  "bin/sovchat-control",
  "bin/sovchat-safe-install.py",
  "tests/test_safe_install.py",
]);

const EXECUTABLE_TARGETS = new Set([
  "bin/sovchat-control",
  "bin/sovchat-safe-install.py",
]);

function usage() {
  return [
    "Usage:",
    "  node scripts/sync-marketplace-plugin.mjs --target <official-clone> --check",
    "  node scripts/sync-marketplace-plugin.mjs --target <official-clone> --write",
  ].join("\n");
}

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  let target;
  let mode;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") {
      target = argv[index + 1];
      index += 1;
    } else if (argument === "--check" || argument === "--write") {
      if (mode) {
        fail("Choose exactly one mode.\n\n" + usage());
      }
      mode = argument.slice(2);
    } else {
      fail("Unknown argument: " + argument + "\n\n" + usage());
    }
  }

  if (!target || !mode) {
    fail(usage());
  }

  return { mode, targetRoot: resolve(target) };
}

function normalizedPath(path) {
  return resolve(path).replaceAll("\\", "/").toLowerCase();
}

function runGit(root, arguments_) {
  const safeRoot = resolve(root).replaceAll("\\", "/");
  const result = spawnSync(
    "git",
    ["-c", "safe.directory=" + safeRoot, "-C", root, ...arguments_],
    { encoding: "utf8" },
  );

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "git failed").trim();
    fail(
      "git " +
        arguments_.join(" ") +
        " failed in " +
        root +
        ": " +
        detail,
    );
  }

  return result.stdout.trim();
}

async function validateTarget(targetRoot) {
  if (normalizedPath(targetRoot) === normalizedPath(SOURCE_ROOT)) {
    fail("The marketplace target must not be the combined source repository.");
  }

  await access(join(targetRoot, ".git"), fsConstants.F_OK).catch(() => {
    fail("Target is not a git checkout: " + targetRoot);
  });

  const manifestPath = join(targetRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.id !== EXPECTED_PLUGIN_ID) {
    fail(
      "Target manifest ID is " +
        JSON.stringify(manifest.id) +
        "; expected " +
        EXPECTED_PLUGIN_ID +
        ".",
    );
  }

  const origin = runGit(targetRoot, ["remote", "get-url", "origin"]);
  if (!EXPECTED_ORIGIN.test(origin)) {
    fail("Target origin is not the official plugin repository: " + origin);
  }
}

function assertCleanSharedFiles(root, label) {
  const status = runGit(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ...SHARED_FILES,
  ]);
  if (status) {
    fail(label + " has dirty shared files:\n" + status);
  }
}

async function readIfPresent(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function shortDigest(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

async function copySharedFiles(targetRoot) {
  for (const sharedPath of SHARED_FILES) {
    const sourcePath = join(SOURCE_ROOT, sharedPath);
    const targetPath = join(targetRoot, sharedPath);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    await chmod(
      targetPath,
      EXECUTABLE_TARGETS.has(sharedPath) ? 0o755 : 0o644,
    );
  }
}

async function findByteDrift(targetRoot) {
  const drift = [];
  for (const sharedPath of SHARED_FILES) {
    const sourceBytes = await readFile(join(SOURCE_ROOT, sharedPath));
    const targetBytes = await readIfPresent(join(targetRoot, sharedPath));
    if (!targetBytes || !sourceBytes.equals(targetBytes)) {
      drift.push({
        path: sharedPath,
        source: shortDigest(sourceBytes),
        target: targetBytes ? shortDigest(targetBytes) : "missing",
      });
    }
  }
  return drift;
}

function findModeDrift(targetRoot) {
  const drift = [];
  for (const sharedPath of SHARED_FILES) {
    const listing = runGit(targetRoot, [
      "ls-files",
      "--stage",
      "--",
      sharedPath,
    ]);
    const actual = listing.split(/\s/u, 1)[0] || "untracked";
    const expected = EXECUTABLE_TARGETS.has(sharedPath) ? "100755" : "100644";
    if (actual !== expected) {
      drift.push({ path: sharedPath, actual, expected });
    }
  }
  return drift;
}

async function main() {
  const { mode, targetRoot } = parseArguments(process.argv.slice(2));
  await validateTarget(targetRoot);
  assertCleanSharedFiles(SOURCE_ROOT, "Combined source");
  assertCleanSharedFiles(targetRoot, "Marketplace target");

  if (mode === "write") {
    await copySharedFiles(targetRoot);
  }

  const byteDrift = await findByteDrift(targetRoot);
  const modeDrift = findModeDrift(targetRoot);
  if (byteDrift.length || modeDrift.length) {
    for (const item of byteDrift) {
      console.error(
        "byte drift: " +
          item.path +
          " (source " +
          item.source +
          ", target " +
          item.target +
          ")",
      );
    }
    for (const item of modeDrift) {
      console.error(
        "mode drift: " +
          item.path +
          " (expected " +
          item.expected +
          ", target " +
          item.actual +
          ")",
      );
    }
    process.exitCode = 1;
    return;
  }

  const action = mode === "write" ? "Synced and verified" : "Verified";
  console.log(
    action +
      " " +
      SHARED_FILES.length +
      " shared files in " +
      (relative(process.cwd(), targetRoot) || ".") +
      ".",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
