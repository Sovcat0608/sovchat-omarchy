import fs from "node:fs";
import path from "node:path";

const DEVELOPMENT_CACHE_PATHS = [
  ["webpack", "client-development"],
  ["webpack", "server-development"]
];

export function cleanNextBuildOutputPreservingCache(rootDir = process.cwd()) {
  const nextDir = path.join(rootDir, ".next");
  if (!fs.existsSync(nextDir)) {
    return { cachePreserved: false, removedEntries: [] };
  }

  const removedEntries = [];
  for (const entry of fs.readdirSync(nextDir, { withFileTypes: true })) {
    if (entry.name === "cache" && entry.isDirectory()) {
      continue;
    }

    fs.rmSync(path.join(nextDir, entry.name), {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 500
    });
    removedEntries.push(entry.name);
  }

  const cacheDir = path.join(nextDir, "cache");
  for (const segments of DEVELOPMENT_CACHE_PATHS) {
    fs.rmSync(path.join(cacheDir, ...segments), { recursive: true, force: true });
  }

  return { cachePreserved: fs.existsSync(cacheDir), removedEntries };
}
