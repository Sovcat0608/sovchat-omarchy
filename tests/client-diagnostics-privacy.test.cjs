const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const typescript = require("typescript");

function loadClientDiagnosticsModule() {
  const sourcePath = path.resolve(__dirname, "..", "lib", "client-diagnostics.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const compiled = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022
    },
    fileName: sourcePath
  }).outputText;
  const loadedModule = { exports: {} };
  const requireForTest = (specifier) => {
    if (specifier === "@/lib/desktop") {
      return { getDesktopBridge: () => null };
    }

    return require(specifier);
  };

  new Function("exports", "require", "module", "__filename", "__dirname", compiled)(
    loadedModule.exports,
    requireForTest,
    loadedModule,
    sourcePath,
    path.dirname(sourcePath)
  );
  return loadedModule.exports;
}

const { sanitizeClientDiagnosticDetails } = loadClientDiagnosticsModule();

test("client diagnostics retain useful stages while redacting raw identifiers and secrets", () => {
  const rawSecrets = [
    "TR_7xL9AbCdEfGh",
    "room-123456789",
    "alice@example.com",
    "top-secret-token",
    "C:\\Users\\Alice\\AppData\\Local\\SovChat\\device.txt"
  ];
  const details = sanitizeClientDiagnosticDetails({
    attemptId: 17,
    status: "degraded",
    stage: "audio-ready",
    durationMs: 9421,
    roomId: rawSecrets[1],
    deviceLabel: "Alice's Studio Microphone",
    note: "free-form values are not schema-approved",
    error:
      `Track ${rawSecrets[0]} failed for user ${rawSecrets[2]} at ${rawSecrets[4]}; ` +
      `roomId=${rawSecrets[1]}; token=${rawSecrets[3]}; ` +
      "https://voice.example.test/join?access_token=top-secret-token"
  });

  assert.equal(details.attemptId, 17);
  assert.equal(details.status, "degraded");
  assert.equal(details.stage, "audio-ready");
  assert.equal(details.durationMs, 9421);
  assert.equal(details.roomId, "[redacted]");
  assert.equal(details.deviceLabel, "[redacted]");
  assert.equal(details.note, "[redacted]");

  const serialized = JSON.stringify(details);
  for (const secret of rawSecrets) {
    assert.equal(serialized.includes(secret), false, `leaked diagnostic value: ${secret}`);
  }
  assert.match(String(details.error), /\[(?:id|path|url|credential|redacted)\]/u);
});
