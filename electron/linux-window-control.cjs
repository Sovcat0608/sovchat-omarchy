const { spawnSync } = require("node:child_process");

const HYPRLAND_COMMAND_TIMEOUT_MS = 1800;
const HYPRLAND_MAX_OUTPUT_BYTES = 1024 * 1024;
const HYPRLAND_ADDRESS_PATTERN = /^0x[0-9a-f]+$/i;
const SOVCHAT_LINUX_IDENTITIES = new Set([
  "com.sovchat.omarchy",
  "sovchat",
  "sovchatomarchy"
]);

function isHyprlandSession(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  if (platform !== "linux") {
    return false;
  }

  const desktop = [env.XDG_CURRENT_DESKTOP, env.XDG_SESSION_DESKTOP, env.DESKTOP_SESSION]
    .filter(Boolean)
    .join(":")
    .toLowerCase();

  return Boolean(String(env.HYPRLAND_INSTANCE_SIGNATURE ?? "").trim()) || desktop.includes("hyprland");
}

function runHyprctl(args, spawnSyncImplementation = spawnSync) {
  try {
    const result = spawnSyncImplementation("hyprctl", args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: HYPRLAND_COMMAND_TIMEOUT_MS,
      maxBuffer: HYPRLAND_MAX_OUTPUT_BYTES
    });

    return {
      ok: !result.error && result.status === 0,
      status: result.status,
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
      error: result.error ?? null
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      stdout: "",
      stderr: "",
      error
    };
  }
}

function parseJsonResult(result) {
  if (!result?.ok || !result.stdout) {
    return null;
  }

  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function normalizeProcessIds(values) {
  return new Set(
    (Array.isArray(values) ? values : [values])
      .map((value) => Number.parseInt(String(value), 10))
      .filter((value) => Number.isSafeInteger(value) && value > 0)
  );
}

function normalizeIdentity(value) {
  return String(value ?? "").trim().toLowerCase();
}

function hasSovChatIdentity(client) {
  return [client?.class, client?.initialClass]
    .map(normalizeIdentity)
    .some((identity) => SOVCHAT_LINUX_IDENTITIES.has(identity));
}

function hasExpectedTitle(client, expectedTitle) {
  const normalizedExpectedTitle = normalizeIdentity(expectedTitle);
  if (!normalizedExpectedTitle) {
    return false;
  }

  return [client?.title, client?.initialTitle]
    .map(normalizeIdentity)
    .some((title) => title === normalizedExpectedTitle);
}

function isOwnedSovChatClient(client, options = {}) {
  if (!HYPRLAND_ADDRESS_PATTERN.test(String(client?.address ?? ""))) {
    return false;
  }

  const processIds = normalizeProcessIds(options.processIds ?? []);
  const clientProcessId = Number.parseInt(String(client?.pid ?? ""), 10);
  if (processIds.has(clientProcessId)) {
    return true;
  }

  return hasSovChatIdentity(client) && hasExpectedTitle(client, options.expectedTitle);
}

function invokeHyprctl(runHyprctlImplementation, args) {
  try {
    return runHyprctlImplementation(args) ?? { ok: false };
  } catch (error) {
    return { ok: false, error };
  }
}

function dispatchWithLegacyFallback(runHyprctlImplementation, omarchyCommand, legacyArgs) {
  const omarchyResult = invokeHyprctl(runHyprctlImplementation, ["dispatch", omarchyCommand]);
  if (omarchyResult.ok) {
    return { ok: true, command: "omarchy" };
  }

  const legacyResult = invokeHyprctl(runHyprctlImplementation, ["dispatch", ...legacyArgs]);
  return {
    ok: Boolean(legacyResult.ok),
    command: legacyResult.ok ? "hyprland" : null,
    error: legacyResult.error ?? omarchyResult.error ?? null
  };
}

function tryMinimizeOnHyprland(options = {}) {
  if (!isHyprlandSession(options)) {
    return { handled: false, reason: "not-hyprland" };
  }

  const run = options.runHyprctl ?? runHyprctl;
  const activeClient = parseJsonResult(invokeHyprctl(run, ["activewindow", "-j"]));
  if (!isOwnedSovChatClient(activeClient, options)) {
    return { handled: false, reason: "active-window-mismatch" };
  }

  const address = String(activeClient.address);
  const result = dispatchWithLegacyFallback(
    run,
    `hl.dsp.window.move({ window = "address:${address}", workspace = "special:scratchpad", follow = false })`,
    ["movetoworkspacesilent", `special:scratchpad,address:${address}`]
  );

  return result.ok
    ? { handled: true, method: "omarchy-scratchpad", address, dispatcher: result.command }
    : { handled: false, reason: "scratchpad-dispatch-failed", error: result.error };
}

function selectSovChatClient(clients, options = {}) {
  if (!Array.isArray(clients)) {
    return null;
  }

  const candidates = clients.filter((client) => isOwnedSovChatClient(client, options));
  if (candidates.length <= 1) {
    return candidates[0] ?? null;
  }

  const exactTitleMatch = candidates.find((client) => hasExpectedTitle(client, options.expectedTitle));
  if (exactTitleMatch) {
    return exactTitleMatch;
  }

  return candidates.find((client) => String(client?.workspace?.name ?? "").startsWith("special:"))
    ?? candidates[0];
}

function getActiveWorkspaceId(runHyprctlImplementation) {
  const activeWorkspace = parseJsonResult(
    invokeHyprctl(runHyprctlImplementation, ["activeworkspace", "-j"])
  );
  const workspaceId = Number.parseInt(String(activeWorkspace?.id ?? ""), 10);
  return Number.isSafeInteger(workspaceId) && workspaceId > 0 ? String(workspaceId) : null;
}

function tryRestoreOnHyprland(options = {}) {
  if (!isHyprlandSession(options)) {
    return { handled: false, reason: "not-hyprland" };
  }

  const run = options.runHyprctl ?? runHyprctl;
  const clients = parseJsonResult(invokeHyprctl(run, ["clients", "-j"]));
  const client = selectSovChatClient(clients, options);
  if (!client) {
    return { handled: false, reason: "window-not-found" };
  }

  const address = String(client.address);
  const workspaceName = String(client?.workspace?.name ?? "");
  let movedFromScratchpad = false;

  if (workspaceName.startsWith("special:")) {
    const activeWorkspaceId = getActiveWorkspaceId(run);
    if (activeWorkspaceId) {
      const moveResult = dispatchWithLegacyFallback(
        run,
        `hl.dsp.window.move({ window = "address:${address}", workspace = "${activeWorkspaceId}", follow = false })`,
        ["movetoworkspacesilent", `${activeWorkspaceId},address:${address}`]
      );
      movedFromScratchpad = moveResult.ok;
    }
  }

  const focusResult = dispatchWithLegacyFallback(
    run,
    `hl.dsp.focus({ window = "address:${address}" })`,
    ["focuswindow", `address:${address}`]
  );

  if (focusResult.ok || movedFromScratchpad) {
    return {
      handled: true,
      method: movedFromScratchpad ? "omarchy-scratchpad-restore" : "omarchy-focus",
      address,
      movedFromScratchpad,
      dispatcher: focusResult.command
    };
  }

  return { handled: false, reason: "focus-dispatch-failed", error: focusResult.error };
}

module.exports = {
  hasSovChatIdentity,
  isHyprlandSession,
  isOwnedSovChatClient,
  runHyprctl,
  selectSovChatClient,
  tryMinimizeOnHyprland,
  tryRestoreOnHyprland
};
