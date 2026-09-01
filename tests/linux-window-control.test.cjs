const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isHyprlandSession,
  isOwnedSovChatClient,
  selectSovChatClient,
  tryMinimizeOnHyprland,
  tryRestoreOnHyprland
} = require("../electron/linux-window-control.cjs");

const HYPRLAND_ENV = {
  HYPRLAND_INSTANCE_SIGNATURE: "test-instance",
  XDG_CURRENT_DESKTOP: "Hyprland"
};

function jsonResult(value) {
  return { ok: true, status: 0, stdout: JSON.stringify(value), stderr: "" };
}

function createRunner(responses) {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    const response = responses[calls.length - 1];
    if (typeof response === "function") {
      return response(args);
    }
    return response ?? { ok: false, status: 1, stdout: "", stderr: "failed" };
  };
  return { calls, run };
}

test("Hyprland detection is Linux-only and accepts the native session signature", () => {
  assert.equal(isHyprlandSession({ platform: "linux", env: HYPRLAND_ENV }), true);
  assert.equal(
    isHyprlandSession({ platform: "linux", env: { XDG_CURRENT_DESKTOP: "GNOME" } }),
    false
  );
  assert.equal(isHyprlandSession({ platform: "win32", env: HYPRLAND_ENV }), false);
});

test("client ownership requires a matching process or stable SovChat identity and title", () => {
  const client = {
    address: "0xabc",
    pid: 420,
    class: "com.sovchat.omarchy",
    title: "SovChat"
  };

  assert.equal(isOwnedSovChatClient(client, { processIds: [420], expectedTitle: "Other" }), true);
  assert.equal(isOwnedSovChatClient(client, { processIds: [999], expectedTitle: "SovChat" }), true);
  assert.equal(isOwnedSovChatClient(client, { processIds: [999], expectedTitle: "Other" }), false);
  assert.equal(
    isOwnedSovChatClient({ ...client, address: "not-an-address" }, { processIds: [420] }),
    false
  );
});

test("the minimize action uses Omarchy's scratchpad dispatcher for the active SovChat window", () => {
  const runner = createRunner([
    jsonResult({ address: "0xabc", pid: 420, class: "com.sovchat.omarchy", title: "SovChat" }),
    { ok: true, status: 0, stdout: "ok", stderr: "" }
  ]);

  const result = tryMinimizeOnHyprland({
    platform: "linux",
    env: HYPRLAND_ENV,
    processIds: [420],
    expectedTitle: "SovChat",
    runHyprctl: runner.run
  });

  assert.equal(result.handled, true);
  assert.equal(result.method, "omarchy-scratchpad");
  assert.deepEqual(runner.calls[0], ["activewindow", "-j"]);
  assert.deepEqual(runner.calls[1], [
    "dispatch",
    'hl.dsp.window.move({ window = "address:0xabc", workspace = "special:scratchpad", follow = false })'
  ]);
});

test("the minimize action falls back to the stable Hyprland dispatcher", () => {
  const runner = createRunner([
    jsonResult({ address: "0xabc", pid: 420, class: "SovChat", title: "SovChat" }),
    { ok: false, status: 1, stdout: "", stderr: "unknown dispatcher" },
    { ok: true, status: 0, stdout: "ok", stderr: "" }
  ]);

  const result = tryMinimizeOnHyprland({
    platform: "linux",
    env: HYPRLAND_ENV,
    processIds: [420],
    expectedTitle: "SovChat",
    runHyprctl: runner.run
  });

  assert.equal(result.handled, true);
  assert.equal(result.dispatcher, "hyprland");
  assert.deepEqual(runner.calls[2], [
    "dispatch",
    "movetoworkspacesilent",
    "special:scratchpad,address:0xabc"
  ]);
});

test("the minimize action never moves an unrelated active window", () => {
  const runner = createRunner([
    jsonResult({ address: "0xdef", pid: 999, class: "foot", title: "Terminal" })
  ]);

  const result = tryMinimizeOnHyprland({
    platform: "linux",
    env: HYPRLAND_ENV,
    processIds: [420],
    expectedTitle: "SovChat",
    runHyprctl: runner.run
  });

  assert.deepEqual(result, { handled: false, reason: "active-window-mismatch" });
  assert.equal(runner.calls.length, 1);
});

test("restoring a minimized client moves it to the active workspace before focusing", () => {
  const runner = createRunner([
    jsonResult([
      {
        address: "0xabc",
        pid: 420,
        class: "com.sovchat.omarchy",
        title: "SovChat",
        workspace: { id: -99, name: "special:scratchpad" }
      }
    ]),
    jsonResult({ id: 3, name: "3" }),
    { ok: true, status: 0, stdout: "ok", stderr: "" },
    { ok: true, status: 0, stdout: "ok", stderr: "" }
  ]);

  const result = tryRestoreOnHyprland({
    platform: "linux",
    env: HYPRLAND_ENV,
    processIds: [420],
    expectedTitle: "SovChat",
    runHyprctl: runner.run
  });

  assert.equal(result.handled, true);
  assert.equal(result.movedFromScratchpad, true);
  assert.deepEqual(runner.calls, [
    ["clients", "-j"],
    ["activeworkspace", "-j"],
    [
      "dispatch",
      'hl.dsp.window.move({ window = "address:0xabc", workspace = "3", follow = false })'
    ],
    ["dispatch", 'hl.dsp.focus({ window = "address:0xabc" })']
  ]);
});

test("restore selects the requested SovChat window when a stream popout also exists", () => {
  const mainClient = {
    address: "0xabc1",
    pid: 420,
    class: "com.sovchat.omarchy",
    title: "SovChat",
    workspace: { id: 1, name: "1" }
  };
  const streamClient = {
    address: "0xfeed",
    pid: 420,
    class: "com.sovchat.omarchy",
    title: "Jones - SovChat",
    workspace: { id: 1, name: "1" }
  };

  assert.equal(
    selectSovChatClient([streamClient, mainClient], {
      processIds: [420],
      expectedTitle: "SovChat"
    }),
    mainClient
  );
});
