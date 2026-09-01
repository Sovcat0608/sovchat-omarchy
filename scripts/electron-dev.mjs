import { spawn } from "node:child_process";

const HOST = "127.0.0.1";
const PORT = "3001";
const START_URL = `http://${HOST}:${PORT}/desktop`;
const DEFAULT_HOSTED_APP_URL = "https://sovchat.com";
const API_BASE_URL =
  process.env.SOVCHAT_API_BASE_URL ??
  process.env.SOVCHAT_REMOTE_APP_URL ??
  DEFAULT_HOSTED_APP_URL;
const PUBLIC_APP_URL = process.env.SOVCHAT_PUBLIC_APP_URL ?? API_BASE_URL;

function getCommand(command) {
  return process.platform === "win32" ? `${command}.cmd` : command;
}

function runAndCollect(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.once("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr || stdout || `${command} exited with code ${code ?? "unknown"}.`));
    });
  });
}

function waitForServer(url, timeoutMs) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      fetch(url, { cache: "no-store" })
        .then((response) => {
          if (response.ok) {
            resolve();
            return;
          }

          if (Date.now() - startedAt >= timeoutMs) {
            reject(new Error(`Timed out waiting for ${url}.`));
            return;
          }

          setTimeout(tryConnect, 500);
        })
        .catch(() => {
          if (Date.now() - startedAt >= timeoutMs) {
            reject(new Error(`Timed out waiting for ${url}.`));
            return;
          }

          setTimeout(tryConnect, 500);
        });
    };

    tryConnect();
  });
}

await runAndCollect(process.execPath, ["scripts/free-port.mjs", PORT]);

const webProcess = spawn(getCommand("npm"), ["run", "dev:web"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    PORT
  }
});

let electronProcess = null;

function stopAll() {
  if (electronProcess && !electronProcess.killed) {
    electronProcess.kill();
  }

  if (!webProcess.killed) {
    webProcess.kill();
  }
}

process.on("SIGINT", () => {
  stopAll();
  process.exit(130);
});

process.on("SIGTERM", () => {
  stopAll();
  process.exit(143);
});

webProcess.once("exit", (code) => {
  if (electronProcess && !electronProcess.killed) {
    electronProcess.kill();
  }

  process.exit(code ?? 0);
});

try {
  await waitForServer(START_URL, 60_000);

  electronProcess = spawn(getCommand("electron"), ["."], {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      ELECTRON_START_URL: START_URL,
      SOVCHAT_API_BASE_URL: API_BASE_URL,
      SOVCHAT_PUBLIC_APP_URL: PUBLIC_APP_URL,
      SOVCHAT_REMOTE_APP_URL: API_BASE_URL
    }
  });

  electronProcess.once("exit", (code) => {
    if (!webProcess.killed) {
      webProcess.kill();
    }

    process.exit(code ?? 0);
  });
} catch (error) {
  console.error(error);
  stopAll();
  process.exit(1);
}
