import { execFileSync } from "node:child_process";

const rawPort = process.argv[2] ?? process.env.PORT ?? "3000";
const port = Number.parseInt(rawPort, 10);

if (!Number.isFinite(port) || port <= 0) {
  console.error(`Invalid port: ${rawPort}`);
  process.exit(1);
}

function getListeningPidsForPort(targetPort) {
  try {
    if (process.platform === "win32") {
      const output = execFileSync("netstat", ["-ano", "-p", "tcp"], {
        encoding: "utf8",
        windowsHide: true
      });

      return Array.from(
        new Set(
          output
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter((line) => line.includes("LISTENING"))
            .filter((line) => line.includes(`:${targetPort} `) || line.endsWith(`:${targetPort}`))
            .map((line) => line.split(/\s+/u).at(-1))
            .filter((value) => value && /^\d+$/u.test(value))
            .map((value) => Number(value))
        )
      );
    }

    const output = execFileSync("lsof", ["-ti", `tcp:${targetPort}`], {
      encoding: "utf8",
      windowsHide: true
    });

    return Array.from(
      new Set(
        output
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter((value) => /^\d+$/u.test(value))
          .map((value) => Number(value))
      )
    );
  } catch {
    return [];
  }
}

function killPid(pid) {
  if (!pid || pid === process.pid) {
    return;
  }

  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      return;
    }

    process.kill(pid, "SIGKILL");
  } catch {
    // Ignore processes that exit between detection and termination.
  }
}

const pids = getListeningPidsForPort(port);

for (const pid of pids) {
  killPid(pid);
}
