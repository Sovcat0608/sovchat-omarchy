import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function collectFiles(directoryPath) {
  const files = [];
  const pending = [directoryPath];

  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile()) files.push(entryPath);
    }
  }

  return files;
}

export function assertPreparedDesktopRenderer(rootDir = process.cwd()) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  const version = String(packageJson.version ?? "").trim();
  const commit = process.env.SOVCHAT_BUILD_COMMIT?.trim() ||
    execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8"
    }).trim();
  if (!/^[a-f0-9]{7,40}$/iu.test(commit)) {
    throw new Error(`Prepared desktop build commit is invalid: ${commit || "missing"}.`);
  }
  const rendererDir = path.join(rootDir, "electron", "renderer");
  const requiredPaths = [
    path.join(rendererDir, "desktop.html"),
    path.join(rendererDir, "desktop-popout.html"),
    path.join(rendererDir, "_next", "static"),
    path.join(rendererDir, "public"),
    path.join(rootDir, "lib", "generated", "build-meta.ts")
  ];

  for (const requiredPath of requiredPaths) {
    if (!fs.existsSync(requiredPath)) {
      throw new Error(`Prepared desktop renderer is missing: ${requiredPath}`);
    }
  }

  const expectedVersion = `v${version} (${commit})`;
  const buildMeta = fs.readFileSync(requiredPaths.at(-1), "utf8");
  if (!buildMeta.includes(JSON.stringify(expectedVersion))) {
    throw new Error(`Prepared desktop build metadata does not match ${expectedVersion}.`);
  }

  const searchableFiles = collectFiles(rendererDir).filter((filePath) =>
    /\.(?:html|js|json)$/u.test(filePath)
  );
  const rendererContainsProvenance = searchableFiles.some((filePath) =>
    fs.readFileSync(filePath, "utf8").includes(expectedVersion)
  );

  if (!rendererContainsProvenance) {
    throw new Error(`Prepared desktop renderer does not contain ${expectedVersion}.`);
  }

  return { version, commit, rendererDir, fileCount: searchableFiles.length };
}
