import { spawn } from "node:child_process";

function getCommand(command) {
  if (process.platform !== "win32") {
    return { file: command, argsPrefix: [] };
  }

  if (command === "npm" || command === "npx") {
    return { file: "cmd.exe", argsPrefix: ["/d", "/s", "/c", `${command}.cmd`] };
  }

  return { file: command, argsPrefix: [] };
}

function run(command, args, envOverrides = {}) {
  return new Promise((resolve, reject) => {
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
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "unknown"}.`));
    });
  });
}

const port = process.env.PORT ?? "3001";

await run("node", ["scripts/free-port.mjs", port]);
await run("node", ["scripts/write-build-meta.mjs"]);
await run("npx", ["next", "dev", "--hostname", "127.0.0.1", "--port", port], {
  PORT: port
});
