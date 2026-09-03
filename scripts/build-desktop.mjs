import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parse as parseEnv } from "dotenv";
import { cleanNextBuildOutputPreservingCache } from "./next-build-output.mjs";

const buildEnv = [".env.example", ".env", ".env.local"].reduce((values, fileName) => {
  const filePath = path.resolve(fileName);
  return fs.existsSync(filePath)
    ? { ...values, ...parseEnv(fs.readFileSync(filePath, "utf8")) }
    : values;
}, {});

function getCommand(command) {
  if (process.platform !== "win32") {
    return { file: command, argsPrefix: [] };
  }

  if (command === "npm" || command === "npx") {
    return { file: "cmd.exe", argsPrefix: ["/d", "/s", "/c", `${command}.cmd`] };
  }

  return { file: command, argsPrefix: [] };
}

function run(command, args, envOverrides = {}, label = `${command} ${args.join(" ")}`) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const resolved = getCommand(command);
    const child = spawn(resolved.file, [...resolved.argsPrefix, ...args], {
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
        console.log(`[sovchat:build] ${label}: ${elapsedSeconds}s`);
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}.`));
    });
  });
}

function stopDevServerPort() {
  const result = spawnSync(process.execPath, ["scripts/free-port.mjs", "3000"], {
    encoding: "utf8",
    stdio: "inherit"
  });

  if (result.status && result.status !== 0) {
    throw new Error("Unable to stop the local dev server on port 3000 before building desktop.");
  }
}

function stopConflictingDesktopProcesses() {
  const devCacheDirs = [
    path.join(process.cwd(), ".next", "cache", "webpack", "client-development"),
    path.join(process.cwd(), ".next", "cache", "webpack", "server-development")
  ];
  const hasDevWebpackCache = devCacheDirs.some((cacheDir) => fs.existsSync(cacheDir));

  if (process.platform !== "win32") {
    if (hasDevWebpackCache) {
      throw new Error(
        "Next development webpack cache exists in .next. Stop npm run dev/dev:web/dev:desktop " +
          "and remove .next before packaging or release builds."
      );
    }

    return;
  }

  const repoRoot = process.cwd().replace(/\\/gu, "\\\\");
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      [
        "$ErrorActionPreference = 'Stop'",
        `$repoRoot = '${repoRoot}'`,
        `$currentPid = ${process.pid}`,
        "$processes = Get-CimInstance Win32_Process",
        "$byId = @{}",
        "$processes | ForEach-Object { $byId[[int]$_.ProcessId] = $_ }",
        "$protected = New-Object 'System.Collections.Generic.HashSet[int]'",
        "$cursor = $currentPid",
        "while ($cursor -and $byId.ContainsKey([int]$cursor)) {",
        "  [void]$protected.Add([int]$cursor)",
        "  $cursor = $byId[[int]$cursor].ParentProcessId",
        "}",
        "$candidates = $processes | Where-Object {",
        "  -not $protected.Contains([int]$_.ProcessId) -and",
        "  $_.CommandLine -like \"*$repoRoot*\" -and",
        "  (",
        "    $_.CommandLine -like '*npm*run*dev*' -or",
        "    $_.CommandLine -like '*dev:web*' -or",
        "    $_.CommandLine -like '*dev:desktop*' -or",
        "    $_.CommandLine -like '*next* dev*' -or",
        "    $_.CommandLine -like '*npm*run*pack:desktop*' -or",
        "    $_.CommandLine -like '*pack:desktop*' -or",
        "    $_.CommandLine -like '*build-desktop.mjs*' -or",
        "    $_.CommandLine -like '*electron-builder*--dir*'",
        "  )",
        "}",
        "foreach ($process in $candidates) {",
        "  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue",
        "  Write-Output \"Stopped conflicting process $($process.ProcessId): $($process.CommandLine)\"",
        "}"
      ].join(" ")
    ],
    { encoding: "utf8" }
  );

  if (result.status === 0 && !result.error) {
    const output = result.stdout.trim();
    if (output) {
      console.log(output);
    }
    return;
  }

  if (hasDevWebpackCache) {
    console.warn(
      "Could not inspect running Node processes, but the dev server port was already cleared. " +
        "Continuing so the normal .next cleanup can remove stale development cache."
    );
  }
}

stopDevServerPort();
stopConflictingDesktopProcesses();
await run(process.execPath, [path.resolve("scripts", "write-build-meta.mjs")], buildEnv);
await run(process.execPath, [path.resolve("scripts", "write-release-highlights.mjs")], buildEnv);
const cleanup = cleanNextBuildOutputPreservingCache();
console.log(
  `[sovchat:build] Next.js cache ${cleanup.cachePreserved ? "preserved" : "not available"}; ` +
    `cleared ${cleanup.removedEntries.length} stale output entries.`
);
await run(
  process.execPath,
  [path.resolve("node_modules", "next", "dist", "bin", "next"), "build"],
  buildEnv,
  "Next.js production build"
);
await run(
  process.execPath,
  [path.resolve("scripts", "prepare-electron-dist.mjs")],
  buildEnv,
  "Desktop renderer preparation"
);
