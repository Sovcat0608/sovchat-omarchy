import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(rootDir, "package.json");
const outputPath = path.join(rootDir, "lib", "generated", "release-highlights.ts");

const IGNORED_FILE_PREFIXES = [
  ".next/",
  "node_modules/",
  "release/",
  "prebuilt/",
  "electron/renderer/",
  "lib/generated/"
];

const RULES = [
  {
    kind: "fix",
    title: "Voice connection reliability",
    detail:
      "Improved LiveKit joining, audio readiness, timeout handling, and local audio recovery paths.",
    matches: [/^components\/voice-room\.tsx$/u, /^lib\/livekit/u, /^lib\/audio/u]
  },
  {
    kind: "implementation",
    title: "Audio pipeline diagnostics",
    detail:
      "Added clearer health checks, timing signals, and failure reporting around voice and media setup.",
    matches: [/^lib\/audio/u, /diagnostic/u, /livekit/u]
  },
  {
    kind: "feature",
    title: "Chat and whisper improvements",
    detail:
      "Updated text chat, whispers, unread states, message actions, and media attachment handling.",
    matches: [/^components\/chat-view\.tsx$/u]
  },
  {
    kind: "feature",
    title: "Room and settings controls",
    detail:
      "Refined room identity, member management, settings layout, and owner-facing control behavior.",
    matches: [/^components\/settings/u]
  },
  {
    kind: "feature",
    title: "Stage and user controls",
    detail:
      "Improved stage interactions, user pills, dock controls, streaming controls, and participant states.",
    matches: [/^components\/app-shell\.tsx$/u, /^components\/primary-panel/u, /^app\/globals\.css$/u]
  },
  {
    kind: "polish",
    title: "Desktop app polish",
    detail:
      "Refreshed desktop chrome, tray behavior, packaged renderer assets, and update/install flows.",
    matches: [/^electron/u, /^components\/desktop/u, /^lib\/desktop\.ts$/u]
  },
  {
    kind: "implementation",
    title: "Release pipeline updates",
    detail: "Updated the client build, packaging, and updater workflows for this release.",
    matches: [/^scripts/u, /^package(-lock)?\.json$/u, /^\.github\/workflows/u]
  },
  {
    kind: "polish",
    title: "Interface refinements",
    detail:
      "Smoothed visual details, spacing, responsive layout behavior, and interaction timing.",
    matches: [/^components/u, /^app\/globals\.css$/u, /^images/u]
  }
];

function runGit(args, fallback = "") {
  try {
    return execFileSync("git", args, {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return fallback;
  }
}

function parseSemver(value) {
  const match = /^v?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$/u.exec(value.trim());
  if (!match?.groups) {
    return null;
  }

  return [Number(match.groups.major), Number(match.groups.minor), Number(match.groups.patch)];
}

function compareSemver(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }

  return 0;
}

function getPackageVersion() {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  return typeof packageJson.version === "string" ? packageJson.version.trim() : "0.0.0";
}

function getPreviousRelease(version) {
  const current = parseSemver(version);
  if (!current) {
    return null;
  }

  const releaseLog = runGit([
    "log",
    "--format=%H%x09%s",
    "--grep=^Release v[0-9][0-9]*\\.[0-9][0-9]*\\.[0-9][0-9]*$"
  ]);

  const candidates = releaseLog
    .split(/\r?\n/u)
    .map((line) => {
      const [hash, subject] = line.split("\t");
      const match = /^Release v(?<version>\d+\.\d+\.\d+)$/u.exec(subject ?? "");
      const parsed = match?.groups ? parseSemver(match.groups.version) : null;

      return hash && match?.groups && parsed && compareSemver(parsed, current) < 0
        ? { hash, version: match.groups.version, parsed }
        : null;
    })
    .filter(Boolean)
    .sort((left, right) => compareSemver(right.parsed, left.parsed));

  return candidates[0] ?? null;
}

function normalizeFilePath(filePath) {
  return filePath.replace(/\\/gu, "/").trim();
}

function getChangedFiles(previousRelease) {
  const trackedFiles = previousRelease
    ? runGit(["diff", "--name-only", previousRelease.hash, "--"])
    : runGit(["diff", "--name-only", "HEAD", "--"]);
  const untrackedFiles = runGit(["ls-files", "--others", "--exclude-standard"]);

  return Array.from(
    new Set(
      [...trackedFiles.split(/\r?\n/u), ...untrackedFiles.split(/\r?\n/u)]
        .map(normalizeFilePath)
        .filter(Boolean)
        .filter((filePath) => !IGNORED_FILE_PREFIXES.some((prefix) => filePath.startsWith(prefix)))
    )
  ).sort();
}

function getCommitSubjects(previousRelease) {
  if (!previousRelease) {
    return [];
  }

  return runGit(["log", "--format=%s", `${previousRelease.hash}..HEAD`])
    .split(/\r?\n/u)
    .map((subject) => subject.trim())
    .filter(Boolean)
    .filter((subject) => !/^Release v\d+\.\d+\.\d+$/u.test(subject))
    .slice(0, 8);
}

function buildHighlights(changedFiles) {
  const highlights = RULES.filter((rule) =>
    changedFiles.some((filePath) => rule.matches.some((pattern) => pattern.test(filePath)))
  ).map(({ kind, title, detail }) => ({ kind, title, detail }));

  if (highlights.length === 0) {
    highlights.push({
      kind: "implementation",
      title: "Maintenance refresh",
      detail: "Updated the app bundle and release metadata for this version."
    });
  }

  return highlights.slice(0, 6);
}

function buildSummary(highlights) {
  const titles = highlights.slice(0, 3).map((item) => item.title.toLowerCase());

  if (titles.length === 1) {
    return `This build focuses on ${titles[0]}.`;
  }

  return `This build focuses on ${titles.slice(0, -1).join(", ")}, and ${titles.at(-1)}.`;
}

function normalizeReleaseNote(value) {
  return value.trim().replace(/\s+/gu, " ").replace(/\.$/u, "");
}

function buildReleaseNotes(commitSubjects, highlights) {
  const commitNotes = commitSubjects
    .filter((subject) => !/^merge\b/iu.test(subject))
    .map(normalizeReleaseNote)
    .filter(Boolean);

  const fallbackNotes = highlights.map((item) => normalizeReleaseNote(item.detail));

  return Array.from(new Set(commitNotes.length > 0 ? commitNotes : fallbackNotes)).slice(0, 8);
}

function toSource(value) {
  return JSON.stringify(value, null, 2);
}

const version = getPackageVersion();
const previousRelease = getPreviousRelease(version);
const changedFiles = getChangedFiles(previousRelease);
const commitSubjects = getCommitSubjects(previousRelease);
const highlights = buildHighlights(changedFiles);
const releaseNotes = buildReleaseNotes(commitSubjects, highlights);
const range = previousRelease ? `Since v${previousRelease.version}` : "Current development build";
const summary = buildSummary(highlights);

const source = [
  `export const RELEASE_HIGHLIGHTS_VERSION = ${JSON.stringify(version)};`,
  `export const RELEASE_HIGHLIGHTS_RANGE = ${JSON.stringify(range)};`,
  `export const RELEASE_HIGHLIGHTS_SUMMARY = ${JSON.stringify(summary)};`,
  "",
  `export const RELEASE_HIGHLIGHTS = ${toSource(highlights)} as const;`,
  "",
  `export const RELEASE_HIGHLIGHT_NOTES = ${toSource(releaseNotes)} as const;`,
  `export const RELEASE_HIGHLIGHT_COMMITS = ${toSource(commitSubjects)} as const;`,
  `export const RELEASE_HIGHLIGHT_FILES = ${toSource(changedFiles.slice(0, 24))} as const;`,
  ""
].join("\n");

fs.mkdirSync(path.dirname(outputPath), { recursive: true });

const previousSource = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
if (previousSource !== source) {
  fs.writeFileSync(outputPath, source, "utf8");
}
