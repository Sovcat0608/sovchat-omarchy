const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  desktopCapturer,
  dialog,
  ipcMain,
  nativeImage,
  net,
  powerMonitor,
  protocol,
  screen,
  session,
  shell
} = require("electron");
const { autoUpdater } = require("electron-updater");
const { execFileSync, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");
const { pathToFileURL } = require("node:url");
const packageMetadata = require("../package.json");
const { resolveLinuxDisplayBackend } = require("./linux-display-policy.cjs");
const {
  tryMinimizeOnHyprland,
  tryRestoreOnHyprland
} = require("./linux-window-control.cjs");
const { isDesktopPermissionAllowed } = require("./permission-policy.cjs");
const { resolveDesktopUpdatePolicy } = require("./update-policy.cjs");

const HOST = "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT ?? "3000", 10);
const DEFAULT_HOSTED_APP_URL = "https://sovchat.com";
const DEFAULT_API_BASE_URL = DEFAULT_HOSTED_APP_URL;
const DEFAULT_PUBLIC_APP_URL = DEFAULT_HOSTED_APP_URL;
const DEFAULT_REMOTE_APP_URL = DEFAULT_HOSTED_APP_URL;
const LEGACY_DEFAULT_REMOTE_APP_URLS = new Set(["https://sovchat.sovcat.com"]);
const DESKTOP_API_BASE_URL_ARG_PREFIX = "--sovchat-api-base-url=";
const DESKTOP_PUBLIC_APP_URL_ARG_PREFIX = "--sovchat-public-app-url=";
const DESKTOP_REMOTE_URL_ARG_PREFIX = "--sovchat-remote-app-url=";
const DESKTOP_WINDOW_ROLE_ARG_PREFIX = "--sovchat-window-role=";
const DESKTOP_QUIT_FOR_INSTALL_ARG = "--sovchat-quit-for-install";
const DESKTOP_APP_SCHEME = "app";
const DESKTOP_APP_HOST = "desktop";
const UPDATE_CHECK_DELAY_MS = 2500;
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const UPDATE_RESUME_CHECK_DELAY_MS = 5000;
const UPDATE_INSTALL_RESTART_DELAY_MS = 2600;
const DESKTOP_WINDOW_STATE_SAVE_DEBOUNCE_MS = 750;
const DESKTOP_EXPANDED_MIN_WIDTH = 1100;
const DESKTOP_EXPANDED_MIN_HEIGHT = 720;
const DESKTOP_COMPACT_WIDTH = 352;
const DESKTOP_COMPACT_HEIGHT = 656;
const DESKTOP_COMPACT_MIN_WIDTH = DESKTOP_COMPACT_WIDTH;
const DESKTOP_COMPACT_MIN_HEIGHT = DESKTOP_COMPACT_HEIGHT;
const LINUX_WINDOW_REPAINT_DELAYS_MS = [0, 50, 150];
const RENDERER_CONSOLE_WARNING_LEVEL = 2;
const DESKTOP_MEMORY_METRICS_INTERVAL_MS = 60 * 1000;
const PRESENCE_OFFLINE_TIMEOUT_MS = 1800;
const MAX_DESKTOP_SESSION_TOKEN_LENGTH = 16 * 1024;
const MAX_TRAY_BADGE_COUNT = 99;
const CLIENT_DIAGNOSTICS_HISTORY_LIMIT = 400;
const CLIENT_DIAGNOSTICS_MAX_BYTES = 512 * 1024;
const CLIENT_DIAGNOSTICS_MAX_DEPTH = 5;
const CLIENT_DIAGNOSTICS_MAX_ARRAY_LENGTH = 24;
const CLIENT_DIAGNOSTICS_MAX_OBJECT_KEYS = 40;
const CLIENT_DIAGNOSTICS_MAX_STRING_LENGTH = 512;
const CLIENT_DIAGNOSTICS_MAX_ENTRY_JSON_LENGTH = 12_000;
const CLIENT_DIAGNOSTICS_REDACTED_VALUE = "[redacted]";
const CLIENT_DIAGNOSTICS_TRUNCATED_VALUE = "[truncated]";
const DESKTOP_BUILD_CHANNEL = String(packageMetadata.sovchatBuildChannel ?? "stable")
  .trim()
  .toLowerCase();
const IS_WIP_BUILD = DESKTOP_BUILD_CHANNEL === "wip";
const DESKTOP_APP_VARIANT = "omarchy";
if (String(packageMetadata.sovchatVariant ?? "").trim().toLowerCase() !== DESKTOP_APP_VARIANT) {
  throw new Error("The SovChat Omarchy package identity is invalid.");
}
const CLIENT_DIAGNOSTICS_SAFE_CORRELATION_KEYS = new Set(["attemptid", "joinattemptid"]);
const CLIENT_DIAGNOSTICS_SAFE_LABEL_KEYS = new Set([
  "code",
  "deployment",
  "errorcode",
  "errorname",
  "host",
  "level",
  "protocol",
  "reason",
  "stage",
  "state",
  "status"
]);
const CLIENT_DIAGNOSTICS_ERROR_MESSAGE_KEYS = new Set([
  "error",
  "message",
  "errormessage",
  "lastaudioerror",
  "lastprocessorfailure",
  "lastdeviceswitchresult"
]);
const CLIENT_DIAGNOSTICS_ESSENTIAL_DETAIL_KEYS = new Set([
  "attemptId",
  "joinAttemptId",
  "stage",
  "status",
  "reason",
  "error",
  "errorName",
  "durationMs",
  "timeoutMs"
]);

if (process.platform === "linux") {
  app.setDesktopName("com.sovchat.omarchy");
}

const linuxDisplayBackend = resolveLinuxDisplayBackend({
  platform: process.platform,
  requested: process.env.SOVCHAT_OZONE_PLATFORM,
  hasExplicitSwitch: app.commandLine.hasSwitch("ozone-platform")
});
if (linuxDisplayBackend) {
  process.env.ELECTRON_OZONE_PLATFORM_HINT = linuxDisplayBackend;
  process.env.OZONE_PLATFORM = linuxDisplayBackend;
  app.commandLine.appendSwitch("ozone-platform", linuxDisplayBackend);
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: DESKTOP_APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

const hasSingleInstanceLock = app.requestSingleInstanceLock();
const isQuitForInstallLaunch = process.argv.includes(DESKTOP_QUIT_FOR_INSTALL_ARG);

let mainWindow = null;
let mainWindowCompact = false;
let mainWindowExpandedBounds = null;
let streamPopoutWindow = null;
let streamPopoutIdentity = null;
let nextServerProcess = null;
let pendingDisplayMediaSelection = null;
let updateCheckInterval = null;
let updateCheckInFlight = false;
let updateDownloadPromise = null;
let updateInstallRestartTimer = null;
let updateLifecycleChecksRegistered = false;
let tray = null;
let allowMainWindowClose = false;
let isPromptingForClose = false;
let sessionTrayIconEnabled = false;
let desktopVerboseLogging = !app.isPackaged;
let desktopMemoryMetricsLogging = false;
let memoryMetricsInterval = null;
let windowStateSaveTimeout = null;
let clientDiagnosticsHistory = [];
let clientDiagnosticsExportPromise = null;
let desktopPresenceSessionToken = null;
let desktopPresenceQuitInFlight = false;
let desktopPreferences = {
  startWithWindows: false,
  closeToTray: false,
  trayIconEnabled: false,
  closeAction: "ask"
};
let trayChatState = {
  whisperCount: 0,
  mentionCount: 0,
  hasUnreadMessages: false
};
let desktopConfig = {
  apiBaseUrl: DEFAULT_API_BASE_URL,
  publicAppUrl: DEFAULT_PUBLIC_APP_URL,
  updateFeedUrl: `${DEFAULT_PUBLIC_APP_URL}/desktop-updates/omarchy`
};
let updaterConfigured = false;
let updateState = {
  status: "idle",
  currentVersion: app.getVersion(),
  availableVersion: null,
  percent: null,
  error: null,
  checkedAt: null,
  feedUrl: null,
  installMode: "silent",
  installDirectory: app.isPackaged ? path.dirname(process.execPath) : null,
  installDirectoryWritable: null
};

async function markDesktopPresenceOffline(reason) {
  const sessionToken = desktopPresenceSessionToken;
  desktopPresenceSessionToken = null;

  if (!sessionToken) {
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PRESENCE_OFFLINE_TIMEOUT_MS);

  try {
    const response = await net.fetch(`${desktopConfig.apiBaseUrl}/api/presence/offline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sessionToken}`,
        "Content-Type": "application/json",
        "X-SovChat-Client": "desktop",
        "X-SovChat-Version": app.getVersion(),
        "X-SovChat-App-Variant": DESKTOP_APP_VARIANT
      },
      body: "{}",
      signal: controller.signal
    });

    if (!response.ok) {
      appendDesktopLog(
        `Presence offline notice was rejected. reason=${reason} status=${response.status}`
      );
      return false;
    }

    appendVerboseDesktopLog(`Presence offline notice completed. reason=${reason}`);
    return true;
  } catch (error) {
    appendDesktopLog(
      `Presence offline notice failed. reason=${reason} error=${serializeError(error)}`
    );
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function appendDesktopLog(message) {
  try {
    const logPath = path.join(app.getPath("userData"), "desktop.log");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch (error) {
    console.error("Failed to write desktop log.", error);
  }
}

function getDesktopRuntimeDiagnostics() {
  const runtime = {
    electronVersion: process.versions.electron ?? null,
    chromiumVersion: process.versions.chrome ?? null
  };

  if (process.platform !== "linux") {
    return runtime;
  }

  const rawSessionType = String(process.env.XDG_SESSION_TYPE ?? "")
    .trim()
    .toLowerCase();
  const sessionType = rawSessionType === "wayland" || rawSessionType === "x11"
    ? rawSessionType
    : "unknown";

  return {
    ...runtime,
    linuxDisplayBackend:
      app.commandLine.getSwitchValue("ozone-platform") || linuxDisplayBackend || "auto",
    linuxSessionType: sessionType,
    waylandDisplayAvailable: Boolean(process.env.WAYLAND_DISPLAY),
    x11DisplayAvailable: Boolean(process.env.DISPLAY)
  };
}

function isTruthyEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function configureDesktopVerboseLogging(values = {}) {
  desktopVerboseLogging =
    !app.isPackaged ||
    isTruthyEnv(process.env.SOVCHAT_DESKTOP_VERBOSE_LOGS) ||
    isTruthyEnv(values.SOVCHAT_DESKTOP_VERBOSE_LOGS);
  desktopMemoryMetricsLogging =
    isTruthyEnv(process.env.SOVCHAT_DESKTOP_MEMORY_LOGS) ||
    isTruthyEnv(values.SOVCHAT_DESKTOP_MEMORY_LOGS);
}

function appendVerboseDesktopLog(message) {
  if (desktopVerboseLogging) {
    appendDesktopLog(message);
  }
}

function formatMetricMb(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return null;
  }

  return Math.round((numberValue / 1024) * 10) / 10;
}

function getDesktopProcessMetricsSnapshot() {
  return app.getAppMetrics()
    .map((metric) => {
      const memory = metric.memory ?? {};

      return {
        pid: metric.pid,
        type: metric.type,
        name: metric.name ?? null,
        serviceName: metric.serviceName ?? null,
        cpuPercent: Number.isFinite(metric.cpu?.percentCPUUsage)
          ? Math.round(metric.cpu.percentCPUUsage * 10) / 10
          : null,
        workingSetMb: formatMetricMb(memory.workingSetSize),
        peakWorkingSetMb: formatMetricMb(memory.peakWorkingSetSize),
        privateMb: formatMetricMb(memory.privateBytes),
        sharedMb: formatMetricMb(memory.sharedBytes),
        rawMemory: memory
      };
    })
    .sort((left, right) => {
      if (left.type !== right.type) {
        return String(left.type).localeCompare(String(right.type));
      }

      return Number(left.pid) - Number(right.pid);
    });
}

function appendDesktopProcessMetrics(reason) {
  const metrics = getDesktopProcessMetricsSnapshot();
  appendDesktopLog(`[process-metrics] reason=${reason} metrics=${JSON.stringify(metrics)}`);
  return metrics;
}

function startDesktopMemoryMetricsLogging() {
  if (!desktopMemoryMetricsLogging || memoryMetricsInterval) {
    return;
  }

  appendDesktopProcessMetrics("startup");
  memoryMetricsInterval = setInterval(() => {
    appendDesktopProcessMetrics("interval");
  }, DESKTOP_MEMORY_METRICS_INTERVAL_MS);

  if (typeof memoryMetricsInterval.unref === "function") {
    memoryMetricsInterval.unref();
  }
}

function stopDesktopMemoryMetricsLogging() {
  if (!memoryMetricsInterval) {
    return;
  }

  clearInterval(memoryMetricsInterval);
  memoryMetricsInterval = null;
}

function getDesktopLogPath() {
  return path.join(app.getPath("userData"), "desktop.log");
}

function serializeError(error) {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}

function normalizeClientDiagnosticKey(key) {
  return key.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function isSensitiveClientDiagnosticKey(key) {
  const normalized = normalizeClientDiagnosticKey(key);

  if (CLIENT_DIAGNOSTICS_SAFE_CORRELATION_KEYS.has(normalized)) {
    return false;
  }

  return (
    normalized.endsWith("id") ||
    normalized.endsWith("identity") ||
    normalized.includes("token") ||
    normalized.includes("authorization") ||
    normalized.includes("cookie") ||
    normalized.includes("password") ||
    normalized.includes("secret") ||
    normalized.includes("credential") ||
    normalized.includes("nickname") ||
    normalized === "roomname" ||
    normalized.includes("label")
  );
}

function isErrorMessageClientDiagnosticKey(key) {
  const normalized = normalizeClientDiagnosticKey(key);
  return (
    CLIENT_DIAGNOSTICS_ERROR_MESSAGE_KEYS.has(normalized) ||
    normalized.endsWith("errormessage")
  );
}

function stripClientDiagnosticControls(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .slice(0, CLIENT_DIAGNOSTICS_MAX_STRING_LENGTH);
}

function looksLikeOpaqueClientDiagnosticIdentifier(value) {
  if (value.length >= 32 && /^[A-Za-z0-9_-]+$/u.test(value)) {
    return true;
  }

  if (value.length >= 10 && /[A-Za-z]/u.test(value) && /\d/u.test(value)) {
    return true;
  }

  return /^[0-9a-f]{12,}$/iu.test(value);
}

function redactOpaqueClientDiagnosticIdentifierTokens(value) {
  return value.replace(/\b[A-Za-z0-9][A-Za-z0-9_.:@-]{8,}\b/gu, (token) =>
    looksLikeOpaqueClientDiagnosticIdentifier(token) ? "[id]" : token
  );
}

function sanitizeClientDiagnosticErrorMessage(value) {
  const sanitized = stripClientDiagnosticControls(value)
    .replace(/Bearer\s+[^\s,;]+/giu, "Bearer [redacted]")
    .replace(/Basic\s+[A-Za-z0-9+/=]+/giu, "Basic [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, CLIENT_DIAGNOSTICS_REDACTED_VALUE)
    .replace(
      /\b((?:access|refresh|session)[_-]?token|token|api[_-]?key|secret|signature|authorization|password|credential)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/giu,
      "$1=[redacted]"
    )
    .replace(/([?&](?:access_token|refresh_token|token|api[_-]?key|key|secret|signature|authorization)=)[^&#\s]+/giu, "$1[redacted]")
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/giu, "[url]")
    .replace(/\b[^\s@"'<>]+@[^\s@"'<>]+\.[A-Za-z]{2,}\b/gu, "[credential]")
    .replace(
      /(^|[\s("'])(?:(?:[A-Za-z]:[\\/]|\\\\|\.{1,2}[\\/]|\/)(?:[^\r\n,;)"'<>]+))/gmu,
      "$1[path]"
    )
    .replace(
      /\b((?:audio[_ -]?)?(?:device|microphone|track|room|participant|peer|user|identity|session)(?:[_ -]?(?:id|sid|name|label))?\s*(?:=|:|#)\s*)(?:"[^"]*"|'[^']*'|[^\s,;)\]}]+)/giu,
      "$1[id]"
    )
    .replace(/"[^"\r\n]{2,}"/gu, '"[redacted]"')
    .replace(/`[^`\r\n]{2,}`/gu, "`[redacted]`")
    .replace(/\b(?:TR|RM|PA|AT|VE|VT)_[A-Za-z0-9_-]+\b/gu, "[id]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu, "[id]")
    .replace(/\b[0-9a-f]{12,}\b/giu, "[id]");

  return redactOpaqueClientDiagnosticIdentifierTokens(sanitized)
    .slice(0, CLIENT_DIAGNOSTICS_MAX_STRING_LENGTH);
}

function sanitizeClientDiagnosticEventName(value) {
  const sanitized = stripClientDiagnosticControls(value ?? "unknown").trim().slice(0, 120);
  return /^[A-Za-z0-9]+(?:[._:-][A-Za-z0-9]+)*$/u.test(sanitized)
    ? sanitized
    : "unknown";
}

function sanitizeClientDiagnosticLabel(value) {
  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    return CLIENT_DIAGNOSTICS_REDACTED_VALUE;
  }

  const sanitized = stripClientDiagnosticControls(value).trim();
  return sanitized.length <= 120 && /^[A-Za-z0-9]+(?:[._:-][A-Za-z0-9]+)*$/u.test(sanitized)
    ? sanitized
    : CLIENT_DIAGNOSTICS_REDACTED_VALUE;
}

function sanitizeClientDiagnosticCorrelationValue(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string" && /^\d{1,12}$/u.test(value)) {
    return value;
  }

  return CLIENT_DIAGNOSTICS_REDACTED_VALUE;
}

function sanitizeClientDiagnosticObjectKey(key, index) {
  const sanitized = stripClientDiagnosticControls(key).trim();
  if (
    sanitized.length > 0 &&
    sanitized.length <= 64 &&
    /^[A-Za-z][A-Za-z0-9_.-]*$/u.test(sanitized) &&
    !looksLikeOpaqueClientDiagnosticIdentifier(sanitized) &&
    sanitized !== "__proto__" &&
    sanitized !== "constructor" &&
    sanitized !== "prototype"
  ) {
    return sanitized;
  }

  return `field${index + 1}`;
}

function sanitizeClientDiagnosticValue(value, depth, seen) {
  if (value === null || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === "string") {
    return CLIENT_DIAGNOSTICS_REDACTED_VALUE;
  }

  if (typeof value === "bigint") {
    return CLIENT_DIAGNOSTICS_REDACTED_VALUE;
  }

  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }

  if (depth >= CLIENT_DIAGNOSTICS_MAX_DEPTH) {
    return CLIENT_DIAGNOSTICS_TRUNCATED_VALUE;
  }

  if (value instanceof Error) {
    return {
      name: sanitizeClientDiagnosticLabel(value.name),
      message: sanitizeClientDiagnosticErrorMessage(value.message)
    };
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .slice(0, CLIENT_DIAGNOSTICS_MAX_ARRAY_LENGTH)
      .map((item) => sanitizeClientDiagnosticValue(item, depth + 1, seen))
      .filter((item) => item !== undefined);
  }

  const sanitized = {};
  for (const [index, [key, nestedValue]] of Object.entries(value)
    .slice(0, CLIENT_DIAGNOSTICS_MAX_OBJECT_KEYS)
    .entries()) {
    const sanitizedKey = sanitizeClientDiagnosticObjectKey(key, index);
    const normalizedKey = normalizeClientDiagnosticKey(key);

    if (CLIENT_DIAGNOSTICS_SAFE_CORRELATION_KEYS.has(normalizedKey)) {
      sanitized[sanitizedKey] = sanitizeClientDiagnosticCorrelationValue(nestedValue);
      continue;
    }

    if (isSensitiveClientDiagnosticKey(key)) {
      sanitized[sanitizedKey] = CLIENT_DIAGNOSTICS_REDACTED_VALUE;
      continue;
    }

    if (isErrorMessageClientDiagnosticKey(key)) {
      sanitized[sanitizedKey] = typeof nestedValue === "string"
        ? sanitizeClientDiagnosticErrorMessage(nestedValue)
        : CLIENT_DIAGNOSTICS_REDACTED_VALUE;
      continue;
    }

    if (CLIENT_DIAGNOSTICS_SAFE_LABEL_KEYS.has(normalizedKey)) {
      sanitized[sanitizedKey] = sanitizeClientDiagnosticLabel(nestedValue);
      continue;
    }

    const sanitizedValue = sanitizeClientDiagnosticValue(nestedValue, depth + 1, seen);
    if (sanitizedValue !== undefined) {
      sanitized[sanitizedKey] = sanitizedValue;
    }
  }

  return sanitized;
}

function sanitizeClientDiagnosticDetails(details) {
  const sanitized = sanitizeClientDiagnosticValue(details, 0, new WeakSet());
  const result = sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized
    : { value: sanitized };

  try {
    if (JSON.stringify(result).length <= CLIENT_DIAGNOSTICS_MAX_ENTRY_JSON_LENGTH) {
      return result;
    }
  } catch {
    return { truncated: true, reason: "details-could-not-be-serialized" };
  }

  const compact = {
    truncated: true,
    reason: "details-exceeded-size-limit"
  };
  for (const key of CLIENT_DIAGNOSTICS_ESSENTIAL_DETAIL_KEYS) {
    if (key in result) {
      compact[key] = result[key];
    }
  }
  return compact;
}

function sanitizeClientDiagnosticEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const parsedTimestamp = Date.parse(entry.timestamp);
  const category = entry.category === "performance" ? "performance" : "audio";
  const name = sanitizeClientDiagnosticEventName(entry.name);

  return {
    timestamp: Number.isFinite(parsedTimestamp)
      ? new Date(parsedTimestamp).toISOString()
      : new Date().toISOString(),
    category,
    name,
    details: sanitizeClientDiagnosticDetails(entry.details ?? {})
  };
}

function trimClientDiagnosticsHistory(entries) {
  const trimmed = entries.slice(-CLIENT_DIAGNOSTICS_HISTORY_LIMIT);
  while (
    trimmed.length > 0 &&
    Buffer.byteLength(JSON.stringify(trimmed), "utf8") > CLIENT_DIAGNOSTICS_MAX_BYTES
  ) {
    trimmed.shift();
  }
  return trimmed;
}

function persistClientDiagnosticsHistory() {
  if (!app.isPackaged) {
    return true;
  }

  try {
    const diagnosticsPath = getClientDiagnosticsPath();
    fs.mkdirSync(path.dirname(diagnosticsPath), { recursive: true });
    fs.writeFileSync(
      diagnosticsPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          updatedAt: new Date().toISOString(),
          entries: clientDiagnosticsHistory
        },
        null,
        2
      ),
      "utf8"
    );
    return true;
  } catch (error) {
    appendDesktopLog(`Failed to persist client diagnostics: ${serializeError(error)}`);
    return false;
  }
}

function loadClientDiagnosticsHistory() {
  if (!app.isPackaged) {
    clientDiagnosticsHistory = [];
    return;
  }

  try {
    const diagnosticsPath = getClientDiagnosticsPath();
    if (!fs.existsSync(diagnosticsPath)) {
      clientDiagnosticsHistory = [];
      return;
    }

    const parsed = JSON.parse(fs.readFileSync(diagnosticsPath, "utf8"));
    const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
    clientDiagnosticsHistory = trimClientDiagnosticsHistory(
      (Array.isArray(entries) ? entries : [])
        .map(sanitizeClientDiagnosticEntry)
        .filter(Boolean)
    );
  } catch (error) {
    clientDiagnosticsHistory = [];
    appendDesktopLog(`Failed to load client diagnostics: ${serializeError(error)}`);
  }
}

function appendClientDiagnostics(entries) {
  const sanitizedEntries = (Array.isArray(entries) ? entries : [])
    .slice(-CLIENT_DIAGNOSTICS_HISTORY_LIMIT)
    .map(sanitizeClientDiagnosticEntry)
    .filter(Boolean);

  if (sanitizedEntries.length === 0) {
    return true;
  }

  clientDiagnosticsHistory = trimClientDiagnosticsHistory([
    ...clientDiagnosticsHistory,
    ...sanitizedEntries
  ]);
  return persistClientDiagnosticsHistory();
}

async function exportClientDiagnostics(targetWindow) {
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const options = {
    title: "Export SovChat audio diagnostics",
    defaultPath: `sovchat-audio-diagnostics-${timestamp}.json`,
    buttonLabel: "Export",
    filters: [{ name: "JSON files", extensions: ["json"] }]
  };
  const result = targetWindow
    ? await dialog.showSaveDialog(targetWindow, options)
    : await dialog.showSaveDialog(options);

  if (result.canceled || !result.filePath) {
    return { status: "cancelled", eventCount: clientDiagnosticsHistory.length, filePath: null };
  }

  const bundle = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    application: {
      name: app.getName(),
      version: app.getVersion(),
      variant: DESKTOP_APP_VARIANT,
      platform: process.platform,
      architecture: process.arch,
      packaged: app.isPackaged,
      runtime: getDesktopRuntimeDiagnostics()
    },
    privacy: {
      sanitized: true,
      note: "Tokens, credentials, device labels, and raw user, room, track, and device identifiers are excluded."
    },
    diagnostics: clientDiagnosticsHistory
  };

  fs.writeFileSync(result.filePath, JSON.stringify(bundle, null, 2), "utf8");
  appendDesktopLog(`Exported ${clientDiagnosticsHistory.length} sanitized client diagnostic events.`);
  return {
    status: "saved",
    eventCount: clientDiagnosticsHistory.length,
    filePath: result.filePath
  };
}

function getDesktopUpdateInstallDirectory() {
  if (!app.isPackaged) {
    return getSourceAppRoot();
  }

  return path.dirname(process.execPath);
}

function canWriteToDirectory(directory) {
  if (!directory) {
    return false;
  }

  const probePath = path.join(
    directory,
    `.sovchat-update-write-test-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
  );

  try {
    fs.writeFileSync(probePath, "", { flag: "wx" });
    fs.unlinkSync(probePath);
    return true;
  } catch (error) {
    appendVerboseDesktopLog(`Install directory is not writable for silent updates: ${directory}; ${serializeError(error)}`);

    try {
      if (fs.existsSync(probePath)) {
        fs.unlinkSync(probePath);
      }
    } catch (_cleanupError) {
      // Best-effort cleanup for a zero-byte write probe.
    }

    return false;
  }
}

function hasDesktopUpdaterElevateHelper() {
  return app.isPackaged && fs.existsSync(path.join(process.resourcesPath, "elevate.exe"));
}

function getDesktopUpdateInstallPlan() {
  const installDirectory = getDesktopUpdateInstallDirectory();

  if (!app.isPackaged) {
    return {
      installMode: "silent",
      installDirectory,
      installDirectoryWritable: true
    };
  }

  const installDirectoryWritable = canWriteToDirectory(installDirectory);

  if (installDirectoryWritable) {
    return {
      installMode: "silent",
      installDirectory,
      installDirectoryWritable
    };
  }

  return {
    installMode: hasDesktopUpdaterElevateHelper() ? "elevated" : "assisted",
    installDirectory,
    installDirectoryWritable
  };
}

function patchDesktopUpdateInstallPlan() {
  const installPlan = getDesktopUpdateInstallPlan();
  patchUpdateState(installPlan);
  return installPlan;
}

function requireElevatedSilentDesktopUpdateInstall() {
  const downloadedUpdateHelper = autoUpdater.downloadedUpdateHelper;
  const downloadedFileInfo = downloadedUpdateHelper?.downloadedFileInfo;

  if (!downloadedFileInfo || typeof downloadedFileInfo !== "object") {
    appendDesktopLog("Could not mark downloaded desktop update as requiring elevation; downloaded update info is missing.");
    return false;
  }

  downloadedFileInfo.isAdminRightsRequired = true;
  appendDesktopLog("Marked downloaded desktop update as requiring elevation for silent protected-directory install.");
  return true;
}

function parseEnvFile(raw) {
  const values = {};

  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    values[key] = value;
  }

  return values;
}

function getPackagedAppRoot() {
  return path.join(process.resourcesPath, "app.asar.unpacked");
}

function getSourceAppRoot() {
  return process.cwd();
}

function getDesktopRendererRoot() {
  const appRoot = app.isPackaged ? app.getAppPath() : getSourceAppRoot();
  return path.join(appRoot, "electron", "renderer");
}

function getDesktopRendererCacheBustToken() {
  if (!app.isPackaged) {
    return null;
  }

  try {
    const rendererEntry = path.join(getDesktopRendererRoot(), "desktop.html");
    const stats = fs.statSync(rendererEntry);
    return `${app.getVersion()}-${Math.round(stats.mtimeMs)}`;
  } catch (error) {
    appendDesktopLog(`Failed to compute renderer cache token: ${serializeError(error)}`);
    return `${app.getVersion()}-${Date.now()}`;
  }
}

function normalizeRendererPath(pathname) {
  const sanitized = pathname.replace(/\/+$/u, "") || "/";

  if (sanitized === "/" || sanitized === "/desktop") {
    return "desktop.html";
  }

  if (sanitized === "/desktop-popout") {
    return "desktop-popout.html";
  }

  if (sanitized.startsWith("/_next/")) {
    return sanitized.slice(1);
  }

  return path.join("public", sanitized.slice(1));
}

function buildPackagedDesktopEntryUrl(pathname, params = {}) {
  const url = new URL(`${DESKTOP_APP_SCHEME}://${DESKTOP_APP_HOST}${pathname}`);
  const cacheBustToken = getDesktopRendererCacheBustToken();

  if (cacheBustToken) {
    url.searchParams.set("_desktopBuild", cacheBustToken);
  }

  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") {
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

function registerDesktopRendererProtocol() {
  protocol.handle(DESKTOP_APP_SCHEME, async (request) => {
    const requestUrl = new URL(request.url);
    if (requestUrl.host !== DESKTOP_APP_HOST) {
      return new Response("Not found", { status: 404 });
    }

    const relativePath = normalizeRendererPath(requestUrl.pathname);
    const absolutePath = path.join(getDesktopRendererRoot(), relativePath);

    if (!fs.existsSync(absolutePath) || fs.statSync(absolutePath).isDirectory()) {
      appendDesktopLog(`Desktop renderer asset missing: ${absolutePath}`);
      return new Response("Not found", { status: 404 });
    }

    return net.fetch(pathToFileURL(absolutePath).toString());
  });
}

function getUserConfigPath() {
  return path.join(app.getPath("userData"), "desktop.env");
}

function getDesktopPreferencesPath() {
  return path.join(app.getPath("userData"), "desktop-preferences.json");
}

function getDesktopWindowStatePath() {
  return path.join(app.getPath("userData"), "desktop-window-state.json");
}

function getClientDiagnosticsPath() {
  return path.join(app.getPath("userData"), "client-diagnostics.json");
}

function getBoundsIntersectionArea(left, right) {
  const xOverlap = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const yOverlap = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));

  return xOverlap * yOverlap;
}

function sanitizeDesktopWindowState(windowState) {
  const bounds = windowState?.bounds;

  if (!bounds) {
    return null;
  }

  const width = Math.max(
    DESKTOP_EXPANDED_MIN_WIDTH,
    Math.min(3840, Math.round(Number(bounds.width) || 0))
  );
  const height = Math.max(
    DESKTOP_EXPANDED_MIN_HEIGHT,
    Math.min(2160, Math.round(Number(bounds.height) || 0))
  );
  const x = Math.round(Number(bounds.x));
  const y = Math.round(Number(bounds.y));

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  const nextBounds = { x, y, width, height };
  const visibleOnDisplay = screen
    .getAllDisplays()
    .some((display) => getBoundsIntersectionArea(nextBounds, display.workArea) >= 120 * 120);

  if (!visibleOnDisplay) {
    return null;
  }

  return {
    bounds: nextBounds,
    maximized: Boolean(windowState?.maximized),
    compact: Boolean(windowState?.compact)
  };
}

function getCompactWindowBounds(expandedBounds) {
  const display = screen.getDisplayMatching(expandedBounds);
  const workArea = display.workArea;
  const width = Math.min(DESKTOP_COMPACT_WIDTH, workArea.width);
  const height = Math.min(DESKTOP_COMPACT_HEIGHT, workArea.height);
  const preferredX = expandedBounds.x + expandedBounds.width - width;
  const preferredY = expandedBounds.y;

  return {
    x: Math.max(workArea.x, Math.min(preferredX, workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(preferredY, workArea.y + workArea.height - height)),
    width,
    height
  };
}

function loadDesktopWindowState() {
  try {
    const raw = fs.readFileSync(getDesktopWindowStatePath(), "utf8");
    return sanitizeDesktopWindowState(JSON.parse(raw));
  } catch {
    return null;
  }
}

function saveDesktopWindowState(targetWindow) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  try {
    const isCompactMainWindow = targetWindow === mainWindow && mainWindowCompact;
    const bounds = isCompactMainWindow && mainWindowExpandedBounds
      ? mainWindowExpandedBounds
      : targetWindow.isMaximized()
        ? targetWindow.getNormalBounds()
        : targetWindow.getBounds();
    const windowState = sanitizeDesktopWindowState({
      bounds,
      maximized: isCompactMainWindow ? false : targetWindow.isMaximized(),
      compact: isCompactMainWindow
    });

    if (!windowState) {
      return;
    }

    fs.mkdirSync(path.dirname(getDesktopWindowStatePath()), { recursive: true });
    fs.writeFileSync(getDesktopWindowStatePath(), JSON.stringify(windowState, null, 2), "utf8");
  } catch (error) {
    appendDesktopLog(`Failed to save desktop window state: ${serializeError(error)}`);
  }
}

function scheduleDesktopWindowStateSave(targetWindow) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  if (windowStateSaveTimeout) {
    clearTimeout(windowStateSaveTimeout);
  }

  windowStateSaveTimeout = setTimeout(() => {
    windowStateSaveTimeout = null;
    saveDesktopWindowState(targetWindow);
  }, DESKTOP_WINDOW_STATE_SAVE_DEBOUNCE_MS);
}

function flushDesktopWindowStateSave(targetWindow) {
  if (windowStateSaveTimeout) {
    clearTimeout(windowStateSaveTimeout);
    windowStateSaveTimeout = null;
  }

  saveDesktopWindowState(targetWindow);
}

function sanitizeDesktopPreferences(preferences) {
  const closeToTray =
    typeof preferences?.closeToTray === "boolean"
      ? preferences.closeToTray
      : desktopPreferences.closeToTray;
  const trayIconEnabled =
    typeof preferences?.trayIconEnabled === "boolean"
      ? preferences.trayIconEnabled
      : desktopPreferences.trayIconEnabled;
  const closeAction =
    preferences?.closeAction === "exit" || preferences?.closeAction === "tray"
      ? preferences.closeAction
      : closeToTray
        ? "tray"
        : "ask";

  return {
    startWithWindows:
      typeof preferences?.startWithWindows === "boolean"
        ? preferences.startWithWindows
        : desktopPreferences.startWithWindows,
    closeToTray,
    trayIconEnabled,
    closeAction
  };
}

function loadDesktopPreferences() {
  try {
    const preferencesPath = getDesktopPreferencesPath();
    if (!fs.existsSync(preferencesPath)) {
      desktopPreferences = sanitizeDesktopPreferences({});
      return desktopPreferences;
    }

    desktopPreferences = sanitizeDesktopPreferences(
      JSON.parse(fs.readFileSync(preferencesPath, "utf8"))
    );
  } catch (error) {
    appendDesktopLog(`Failed to load desktop preferences: ${serializeError(error)}`);
    desktopPreferences = sanitizeDesktopPreferences({});
  }

  return desktopPreferences;
}

function saveDesktopPreferences() {
  const preferencesPath = getDesktopPreferencesPath();
  fs.mkdirSync(path.dirname(preferencesPath), { recursive: true });
  fs.writeFileSync(preferencesPath, JSON.stringify(desktopPreferences, null, 2), "utf8");
}

function applyLoginItemPreference() {
  if (process.platform !== "win32") {
    return;
  }

  try {
    app.setLoginItemSettings({
      openAtLogin: desktopPreferences.startWithWindows,
      path: process.execPath
    });
  } catch (error) {
    appendDesktopLog(`Failed to apply Windows startup preference: ${serializeError(error)}`);
  }
}

function getTrayIconCandidates() {
  return [
    path.join(process.resourcesPath, "images", "icon.ico"),
    path.join(getSourceAppRoot(), "images", "icon.ico"),
    path.join(app.getAppPath(), "images", "icon.ico"),
    path.join(process.resourcesPath, "images", "tray-icon.svg"),
    path.join(app.getAppPath(), "images", "tray-icon.svg"),
    path.join(getSourceAppRoot(), "images", "tray-icon.svg"),
    path.join(getSourceAppRoot(), "public", "logo.png"),
    path.join(getDesktopRendererRoot(), "public", "logo.png"),
    path.join(app.getAppPath(), "public", "logo.png")
  ];
}

function getTraySvgIconPath() {
  const candidates = [
    path.join(process.resourcesPath, "images", "tray-icon.svg"),
    path.join(app.getAppPath(), "images", "tray-icon.svg"),
    path.join(getSourceAppRoot(), "images", "tray-icon.svg")
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function escapeSvgText(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function getBadgedTrayIconImage(notificationCount) {
  const iconPath = getTraySvgIconPath();

  if (!iconPath) {
    return null;
  }

  try {
    const badgeLabel =
      notificationCount > MAX_TRAY_BADGE_COUNT
        ? `${MAX_TRAY_BADGE_COUNT}+`
        : String(notificationCount);
    const badgeWidth = badgeLabel.length > 2 ? 18 : badgeLabel.length > 1 ? 15 : 12;
    const badgeHeight = 12;
    const badgeX = 31 - badgeWidth;
    const badgeY = 1;
    const fontSize = badgeLabel.length > 2 ? 6.4 : badgeLabel.length > 1 ? 7.4 : 8.4;
    const badgeSvg = [
      `<rect x="${badgeX}" y="${badgeY}" width="${badgeWidth}" height="${badgeHeight}" rx="6" fill="#71DCE1" stroke="#12292D" stroke-width="1.5"/>`,
      `<text x="${badgeX + badgeWidth / 2}" y="${badgeY + 8.8}" text-anchor="middle" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#12292D">${escapeSvgText(badgeLabel)}</text>`
    ].join("");
    const sourceSvg = fs.readFileSync(iconPath, "utf8");
    const badgedSvg = sourceSvg.includes("</svg>")
      ? sourceSvg.replace("</svg>", `${badgeSvg}</svg>`)
      : sourceSvg;
    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(badgedSvg).toString("base64")}`;
    const image = nativeImage.createFromDataURL(dataUrl);

    if (image.isEmpty()) {
      return null;
    }

    image.setTemplateImage(false);
    return image.resize({ width: 16, height: 16 });
  } catch (error) {
    appendDesktopLog(`Failed to badge tray icon: ${serializeError(error)}`);
    return null;
  }
}

function getTrayIconImage(notificationCount = 0) {
  if (notificationCount > 0) {
    const badgedImage = getBadgedTrayIconImage(notificationCount);

    if (badgedImage) {
      return badgedImage;
    }
  }

  const candidates = getTrayIconCandidates();
  const iconPath = candidates.find((candidate) => fs.existsSync(candidate));
  const image = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();

  if (image.isEmpty()) {
    return image;
  }

  image.setTemplateImage(false);
  return image.resize({ width: 16, height: 16 });
}

function sendTrayCommand(command) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send("desktop:tray-command", command);
}

function getDesktopWindowProcessIds(targetWindow) {
  const processIds = [process.pid];

  try {
    if (targetWindow && !targetWindow.isDestroyed() && !targetWindow.webContents.isDestroyed()) {
      processIds.push(targetWindow.webContents.getOSProcessId());
    }
  } catch {
    // The main process identity remains enough for X11/Hyprland matching.
  }

  return processIds;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  const linuxWindowOptions = {
    platform: process.platform,
    env: process.env,
    processIds: getDesktopWindowProcessIds(mainWindow),
    expectedTitle: mainWindow.getTitle()
  };
  const nativeRestore = tryRestoreOnHyprland(linuxWindowOptions);
  mainWindow.show();
  mainWindow.focus();

  if (process.platform === "linux" && !nativeRestore.handled) {
    const timer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        return;
      }

      tryRestoreOnHyprland({
        ...linuxWindowOptions,
        processIds: getDesktopWindowProcessIds(mainWindow),
        expectedTitle: mainWindow.getTitle()
      });
      mainWindow.focus();
      scheduleLinuxWindowRepaint(mainWindow);
    }, 80);
    timer.unref?.();
  }
}

function sanitizeTrayCount(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.floor(value));
}

function sanitizeTrayChatState(state) {
  return {
    whisperCount: sanitizeTrayCount(Number(state?.whisperCount ?? 0)),
    mentionCount: sanitizeTrayCount(Number(state?.mentionCount ?? 0)),
    hasUnreadMessages: Boolean(state?.hasUnreadMessages)
  };
}

function getTrayNotificationCount() {
  return trayChatState.whisperCount + trayChatState.mentionCount;
}

function formatTrayCount(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function getTrayChatSummaryParts() {
  const parts = [];

  if (trayChatState.whisperCount > 0) {
    parts.push(formatTrayCount(trayChatState.whisperCount, "unread whisper"));
  }

  if (trayChatState.mentionCount > 0) {
    parts.push(formatTrayCount(trayChatState.mentionCount, "mention"));
  }

  if (parts.length === 0 && trayChatState.hasUnreadMessages) {
    parts.push("Unread room chat");
  }

  return parts;
}

function getTrayTooltip() {
  const parts = getTrayChatSummaryParts();
  return parts.length > 0 ? `SovChat\n${parts.join("\n")}` : "SovChat";
}

function updateTray() {
  const shouldHaveTray = process.platform === "win32";

  if (!shouldHaveTray) {
    tray?.destroy();
    tray = null;
    return;
  }

  const notificationCount = getTrayNotificationCount();

  if (!tray) {
    tray = new Tray(getTrayIconImage(notificationCount));
    tray.on("double-click", showMainWindow);
  } else {
    tray.setImage(getTrayIconImage(notificationCount));
  }

  tray.setToolTip(getTrayTooltip());

  const chatSummaryParts = getTrayChatSummaryParts();
  const chatMenuItems =
    chatSummaryParts.length > 0
      ? [
          { label: chatSummaryParts.join(" | "), enabled: false },
          {
            label: "Open chat",
            click: () => {
              showMainWindow();
              sendTrayCommand("open-chat");
            }
          },
          { type: "separator" }
        ]
      : [];

  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...chatMenuItems,
      { label: "Open SovChat", click: showMainWindow },
      { type: "separator" },
      { label: "Mute mic", click: () => sendTrayCommand("toggle-input-muted") },
      { label: "Mute speakers", click: () => sendTrayCommand("toggle-output-muted") },
      { type: "separator" },
      { label: "Log out", click: () => sendTrayCommand("logout") },
      {
        label: "Close app",
        click: () => {
          app.isQuitting = true;
          app.quit();
        }
      }
    ])
  );
}

function setDesktopPreferences(nextPreferences) {
  desktopPreferences = sanitizeDesktopPreferences({
    ...desktopPreferences,
    ...nextPreferences
  });
  if (desktopPreferences.closeAction === "tray") {
    desktopPreferences.closeToTray = true;
    desktopPreferences.trayIconEnabled = true;
  } else {
    desktopPreferences.closeToTray = false;
  }
  saveDesktopPreferences();
  applyLoginItemPreference();
  updateTray();
  return desktopPreferences;
}

async function promptForMainWindowClose(targetWindow) {
  if (!targetWindow || targetWindow.isDestroyed() || isPromptingForClose) {
    return;
  }

  isPromptingForClose = true;

  try {
    const { response, checkboxChecked } = await dialog.showMessageBox(targetWindow, {
      type: "question",
      title: "Close SovChat",
      message: "Do you want to exit the app or minimise to tray?",
      detail: "Minimising to tray keeps SovChat running in the background.",
      buttons: ["Exit app", "Minimise to tray", "Cancel"],
      defaultId: 1,
      cancelId: 2,
      noLink: true,
      checkboxLabel: "Remember this option",
      checkboxChecked: false,
      normalizeAccessKeys: true
    });

    if (response === 1) {
      if (checkboxChecked) {
        sessionTrayIconEnabled = false;
        setDesktopPreferences({
          closeAction: "tray",
          closeToTray: true,
          trayIconEnabled: true
        });
      } else {
        sessionTrayIconEnabled = true;
        updateTray();
      }
      targetWindow.hide();
      return;
    }

    if (response === 0) {
      if (checkboxChecked) {
        sessionTrayIconEnabled = false;
        setDesktopPreferences({
          closeAction: "exit",
          closeToTray: false
        });
      }
      allowMainWindowClose = true;
      app.isQuitting = true;
      targetWindow.close();
    }
  } finally {
    isPromptingForClose = false;
  }
}

function buildDefaultDesktopEnv() {
  return [
    "# The hosted SovChat backend this desktop client should call for API/auth/database access.",
    `SOVCHAT_API_BASE_URL=${DEFAULT_API_BASE_URL}`,
    "# Optional. Hosted website used for downloads, legal links, and update feed defaults.",
    `SOVCHAT_PUBLIC_APP_URL=${DEFAULT_PUBLIC_APP_URL}`,
    "# Legacy alias. Prefer SOVCHAT_API_BASE_URL for new config.",
    `# SOVCHAT_REMOTE_APP_URL=${DEFAULT_REMOTE_APP_URL}`,
    "# Optional. Defaults to SOVCHAT_PUBLIC_APP_URL/desktop-updates/omarchy.",
    "# SOVCHAT_UPDATE_FEED_URL=https://sovchat.com/desktop-updates/omarchy",
    "# Optional. Set to true only when support needs verbose desktop diagnostics.",
    "# SOVCHAT_DESKTOP_VERBOSE_LOGS=false",
    "# Optional. Set to true to log periodic Electron process memory metrics.",
    "# SOVCHAT_DESKTOP_MEMORY_LOGS=false",
    ""
  ].join("\n");
}

function ensureDesktopEnvFile() {
  const envPath = getUserConfigPath();

  if (!fs.existsSync(envPath)) {
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, buildDefaultDesktopEnv(), "utf8");
    return envPath;
  }

  try {
    const raw = fs.readFileSync(envPath, "utf8");
    const values = parseEnvFile(raw);
    let remoteAppUrl = normalizeBaseUrl(values.SOVCHAT_REMOTE_APP_URL);

    if (LEGACY_DEFAULT_REMOTE_APP_URLS.has(remoteAppUrl)) {
      const legacyRemoteAppUrl = remoteAppUrl;
      const migrated = raw.replace(
        /^(SOVCHAT_REMOTE_APP_URL=).+$/mu,
        `$1${DEFAULT_API_BASE_URL}`
      );
      fs.writeFileSync(envPath, migrated, "utf8");
      remoteAppUrl = DEFAULT_API_BASE_URL;
      appendDesktopLog(
        `Migrated desktop.env remote URL from ${legacyRemoteAppUrl} to ${DEFAULT_API_BASE_URL}.`
      );
    }

    if (!values.SOVCHAT_API_BASE_URL && remoteAppUrl) {
      fs.appendFileSync(
        envPath,
        [
          "",
          "# Migrated from legacy SOVCHAT_REMOTE_APP_URL. This controls API/auth/database access.",
          `SOVCHAT_API_BASE_URL=${remoteAppUrl}`,
          ""
        ].join("\n"),
        "utf8"
      );
      appendDesktopLog("Added SOVCHAT_API_BASE_URL to desktop.env from legacy remote URL.");
    }
  } catch (error) {
    appendDesktopLog(`Failed to inspect desktop.env for migration: ${serializeError(error)}`);
  }

  return envPath;
}

function loadDesktopEnv() {
  if (!app.isPackaged) {
    return { filePath: null, values: {} };
  }

  const filePath = ensureDesktopEnvFile();
  return {
    filePath,
    values: parseEnvFile(fs.readFileSync(filePath, "utf8"))
  };
}

function getMissingDesktopKeys(envValues) {
  const apiBaseUrl =
    normalizeBaseUrl(envValues.SOVCHAT_API_BASE_URL) ||
    normalizeBaseUrl(envValues.SOVCHAT_REMOTE_APP_URL);

  return apiBaseUrl ? [] : ["SOVCHAT_API_BASE_URL"];
}

function sourceThumbnailToDataUrl(image) {
  if (!image || image.isEmpty()) {
    return null;
  }

  return image.toDataURL();
}

async function listDisplayMediaSources() {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    // Thumbnails are only for the picker UI and do not affect the actual capture resolution.
    thumbnailSize: {
      width: 480,
      height: 270
    },
    fetchWindowIcons: true
  });

  return sources
    .map((source) => {
      const kind = source.id.startsWith("screen:") ? "screen" : "window";

      return {
        id: source.id,
        name: source.name,
        kind,
        thumbnailDataUrl: sourceThumbnailToDataUrl(source.thumbnail),
        appIconDataUrl: sourceThumbnailToDataUrl(source.appIcon),
        displayId: source.display_id || null
      };
    })
    .sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "screen" ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    });
}

function registerDesktopCaptureHandlers() {
  ipcMain.handle("desktop:list-display-media-sources", async () => {
    const sources = await listDisplayMediaSources();
    appendDesktopLog(`Listed ${sources.length} display media sources.`);
    return sources;
  });

  ipcMain.handle("desktop:prepare-screen-share-source", (_event, selection) => {
    const sourceId =
      selection && typeof selection.id === "string" ? selection.id.trim() : "";
    const sourceKind = selection?.kind === "window" ? "window" : "screen";
    const includeSystemAudio = Boolean(selection?.includeSystemAudio);

    if (!sourceId) {
      pendingDisplayMediaSelection = null;
      appendDesktopLog("Rejected screen share source preparation with missing source id.");
      return false;
    }

    pendingDisplayMediaSelection = {
      id: sourceId,
      kind: sourceKind,
      includeSystemAudio,
      createdAt: Date.now()
    };

    appendDesktopLog(
      `Prepared display media source ${sourceId} kind=${sourceKind} audio=${includeSystemAudio}`
    );
    return true;
  });

  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      const selection = pendingDisplayMediaSelection;
      pendingDisplayMediaSelection = null;

      if (!selection || Date.now() - selection.createdAt > 15_000) {
        appendDesktopLog("Denied display media request because no recent source was selected.");
        callback({});
        return;
      }

      try {
        const sources = await desktopCapturer.getSources({
          types: [selection.kind],
          // Source lookup thumbnails are not part of the published capture pipeline.
          thumbnailSize: {
            width: 16,
            height: 16
          },
          fetchWindowIcons: false
        });
        const source = sources.find((candidate) => candidate.id === selection.id);

        if (!source) {
          appendDesktopLog(`Denied display media request because source was missing: ${selection.id}`);
          callback({});
          return;
        }

        appendDesktopLog(
          `Approved display media source ${source.id} (${source.name}) without low-resolution capture constraints.`
        );
        callback(
          selection.includeSystemAudio
            ? {
                video: source,
                audio: "loopback"
              }
            : {
                video: source
              }
        );
      } catch (error) {
        appendDesktopLog(`Display media request failed: ${serializeError(error)}`);
        callback({});
      }
    },
    {
      useSystemPicker: false
    }
  );
}

function sendWindowState(targetWindow) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  targetWindow.webContents.send("desktop:window-state", {
    maximized: targetWindow.isMaximized(),
    compact: targetWindow === mainWindow && mainWindowCompact
  });
}

function registerDesktopPermissionHandlers() {
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) =>
      isDesktopPermissionAllowed({
        permission,
        requestingUrl:
          details?.requestingUrl ||
          details?.securityOrigin ||
          requestingOrigin ||
          webContents?.getURL(),
        details,
        packaged: app.isPackaged
      })
  );

  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const allowed = isDesktopPermissionAllowed({
        permission,
        requestingUrl: details?.requestingUrl || details?.securityOrigin || webContents?.getURL(),
        details,
        packaged: app.isPackaged
      });

      if (!allowed) {
        appendDesktopLog(`Denied renderer permission request: ${permission}`);
      }
      callback(allowed);
    }
  );
}

function scheduleLinuxWindowRepaint(targetWindow) {
  if (process.platform !== "linux" || !targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  for (const delayMs of LINUX_WINDOW_REPAINT_DELAYS_MS) {
    const timer = setTimeout(() => {
      if (targetWindow.isDestroyed() || targetWindow.webContents.isDestroyed()) {
        return;
      }

      targetWindow.webContents.invalidate();
    }, delayMs);
    timer.unref?.();
  }
}

function setMainWindowCompact(targetWindow, compact) {
  if (!targetWindow || targetWindow.isDestroyed() || targetWindow !== mainWindow) {
    return {
      maximized: Boolean(targetWindow?.isMaximized()),
      compact: false
    };
  }

  const nextCompact = Boolean(compact);
  if (nextCompact === mainWindowCompact) {
    return {
      maximized: targetWindow.isMaximized(),
      compact: mainWindowCompact
    };
  }

  if (nextCompact) {
    mainWindowExpandedBounds = targetWindow.isMaximized()
      ? targetWindow.getNormalBounds()
      : targetWindow.getBounds();
    mainWindowCompact = true;

    if (targetWindow.isMaximized()) {
      targetWindow.unmaximize();
    }

    if (targetWindow.isFullScreen()) {
      targetWindow.setFullScreen(false);
    }

    targetWindow.setMinimumSize(DESKTOP_COMPACT_MIN_WIDTH, DESKTOP_COMPACT_MIN_HEIGHT);
    targetWindow.setMaximumSize(DESKTOP_COMPACT_WIDTH, DESKTOP_COMPACT_HEIGHT);
    targetWindow.setBounds(getCompactWindowBounds(mainWindowExpandedBounds), true);
    targetWindow.setResizable(false);
    targetWindow.setMaximizable(false);
    targetWindow.setFullScreenable(false);
  } else {
    mainWindowCompact = false;
    targetWindow.setFullScreenable(true);
    targetWindow.setMaximizable(true);
    targetWindow.setResizable(true);
    targetWindow.setMaximumSize(0, 0);
    targetWindow.setMinimumSize(DESKTOP_EXPANDED_MIN_WIDTH, DESKTOP_EXPANDED_MIN_HEIGHT);

    const restoredState = sanitizeDesktopWindowState({
      bounds: mainWindowExpandedBounds,
      maximized: false,
      compact: false
    });
    if (restoredState?.bounds) {
      targetWindow.setBounds(restoredState.bounds, true);
    }
  }

  scheduleLinuxWindowRepaint(targetWindow);
  sendWindowState(targetWindow);
  scheduleDesktopWindowStateSave(targetWindow);

  return {
    maximized: targetWindow.isMaximized(),
    compact: mainWindowCompact
  };
}

function buildDesktopRouteUrl(pathname, params = {}) {
  const baseUrl = app.isPackaged
    ? `${DESKTOP_APP_SCHEME}://${DESKTOP_APP_HOST}/desktop`
    : process.env.ELECTRON_START_URL ?? `http://${HOST}:${PORT}/desktop`;
  const url = new URL(pathname, baseUrl);

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value.trim()) {
      url.searchParams.set(key, value.trim());
    }
  }

  return url.toString();
}

function getUrlOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function isHostedRendererPath(pathname) {
  return (
    pathname === "/" ||
    pathname === "/desktop" ||
    pathname === "/desktop/" ||
    pathname === "/login" ||
    pathname === "/signup" ||
    pathname.startsWith("/app")
  );
}

function getLocalDesktopRedirectUrl(navigationUrl) {
  let parsedUrl;

  try {
    parsedUrl = new URL(navigationUrl);
  } catch {
    return null;
  }

  const hostedOrigins = new Set(
    [desktopConfig.publicAppUrl, desktopConfig.apiBaseUrl, DEFAULT_HOSTED_APP_URL]
      .map(getUrlOrigin)
      .filter(Boolean)
  );

  if (!hostedOrigins.has(parsedUrl.origin) || !isHostedRendererPath(parsedUrl.pathname)) {
    return null;
  }

  const redirectParams = {};
  for (const key of ["desktopSessionToken", "rememberMe", "authError"]) {
    const value = parsedUrl.searchParams.get(key);
    if (value) {
      redirectParams[key] = value;
    }
  }

  return buildDesktopRouteUrl("/desktop", redirectParams);
}

function installHostedRendererNavigationGuard(targetWindow, role) {
  const guardHostedRendererNavigation = (event, navigationUrl) => {
    const localRedirectUrl = getLocalDesktopRedirectUrl(navigationUrl);

    if (!localRedirectUrl) {
      return;
    }

    event.preventDefault();
    appendDesktopLog(
      `Prevented ${role} window from rendering hosted app URL ${navigationUrl}; redirecting to ${localRedirectUrl}.`
    );
    void targetWindow.loadURL(localRedirectUrl);
  };

  targetWindow.webContents.on("will-navigate", guardHostedRendererNavigation);
  targetWindow.webContents.on("will-redirect", guardHostedRendererNavigation);
}

function sendStreamPopoutClosed(streamIdentity = streamPopoutIdentity) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send("desktop:stream-popout-closed", {
    streamIdentity: streamIdentity ?? null
  });
}

function closeStreamPopoutWindow() {
  if (!streamPopoutWindow || streamPopoutWindow.isDestroyed()) {
    streamPopoutWindow = null;
    streamPopoutIdentity = null;
    return false;
  }

  streamPopoutWindow.close();
  return true;
}

function openStreamPopoutWindow(request) {
  const streamIdentity =
    request && typeof request.streamIdentity === "string"
      ? request.streamIdentity.trim()
      : "";
  const streamLabel =
    request && typeof request.streamLabel === "string"
      ? request.streamLabel.trim()
      : "";

  if (!streamIdentity) {
    appendDesktopLog("Rejected stream popout request with missing stream identity.");
    return false;
  }

  if (streamPopoutWindow && !streamPopoutWindow.isDestroyed()) {
    streamPopoutIdentity = streamIdentity;
    streamPopoutWindow.loadURL(
      app.isPackaged
        ? buildPackagedDesktopEntryUrl("/desktop-popout", {
            streamIdentity,
            streamLabel
          })
        : buildDesktopRouteUrl("/desktop-popout", {
            streamIdentity,
            streamLabel
          })
    );
    streamPopoutWindow.show();
    streamPopoutWindow.focus();
    return true;
  }

  streamPopoutIdentity = streamIdentity;
  streamPopoutWindow = new BrowserWindow({
    width: 960,
    height: 560,
    minWidth: 520,
    minHeight: 320,
    title: streamLabel ? `${streamLabel} - SovChat` : "SovChat stream",
    backgroundColor: "#0e161b",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: path.join(__dirname, "preload.cjs"),
      additionalArguments: [
        `${DESKTOP_API_BASE_URL_ARG_PREFIX}${desktopConfig.apiBaseUrl}`,
        `${DESKTOP_PUBLIC_APP_URL_ARG_PREFIX}${desktopConfig.publicAppUrl}`,
        `${DESKTOP_REMOTE_URL_ARG_PREFIX}${desktopConfig.apiBaseUrl}`,
        `${DESKTOP_WINDOW_ROLE_ARG_PREFIX}stream-popout`
      ]
    }
  });

  installHostedRendererNavigationGuard(streamPopoutWindow, "stream-popout");

  streamPopoutWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  streamPopoutWindow.webContents.on("did-fail-load", (_event, code, description, validatedUrl) => {
    appendDesktopLog(
      `Stream popout failed to load. code=${code} description=${description} url=${validatedUrl}`
    );
  });

  streamPopoutWindow.on("closed", () => {
    const closedIdentity = streamPopoutIdentity;
    streamPopoutWindow = null;
    streamPopoutIdentity = null;
    sendStreamPopoutClosed(closedIdentity);
  });

  void streamPopoutWindow.loadURL(
    app.isPackaged
      ? buildPackagedDesktopEntryUrl("/desktop-popout", {
          streamIdentity,
          streamLabel
        })
      : buildDesktopRouteUrl("/desktop-popout", {
          streamIdentity,
          streamLabel
        })
  );

  return true;
}

function registerWindowHandlers() {
  ipcMain.handle("desktop:window-minimize", (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    if (!targetWindow || targetWindow.isDestroyed()) {
      return { handled: false, method: "unavailable" };
    }

    const nativeResult = tryMinimizeOnHyprland({
      platform: process.platform,
      env: process.env,
      processIds: getDesktopWindowProcessIds(targetWindow),
      expectedTitle: targetWindow.getTitle()
    });
    if (nativeResult.handled) {
      appendDesktopLog(`Window moved to the Omarchy scratchpad: ${nativeResult.address}`);
      return nativeResult;
    }

    if (process.platform === "linux") {
      targetWindow.hide();
      return { handled: true, method: "electron-hide" };
    }

    targetWindow.minimize();
    return { handled: true, method: "electron-minimize" };
  });

  ipcMain.handle("desktop:window-toggle-maximize", (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    if (!targetWindow) {
      return;
    }

    if (targetWindow === mainWindow && mainWindowCompact) {
      return;
    }

    if (targetWindow.isMaximized()) {
      targetWindow.unmaximize();
      return;
    }

    targetWindow.maximize();
  });

  ipcMain.handle("desktop:window-set-compact", (event, compact) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    return setMainWindowCompact(targetWindow, compact);
  });

  ipcMain.handle("desktop:window-close", (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    targetWindow?.close();
  });

  ipcMain.handle("desktop:presence-token-sync", (event, token) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    if (!targetWindow || targetWindow !== mainWindow) {
      return false;
    }

    if (token === null) {
      desktopPresenceSessionToken = null;
      return true;
    }

    if (
      typeof token !== "string" ||
      token.length < 16 ||
      token.length > MAX_DESKTOP_SESSION_TOKEN_LENGTH ||
      /[\u0000-\u001f\u007f]/u.test(token)
    ) {
      return false;
    }

    desktopPresenceSessionToken = token;
    return true;
  });

  ipcMain.handle("desktop:window-get-state", (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    return {
      maximized: Boolean(targetWindow?.isMaximized()),
      compact: targetWindow === mainWindow && mainWindowCompact
    };
  });

  ipcMain.handle("desktop:stream-popout-open", (_event, request) =>
    openStreamPopoutWindow(request)
  );

  ipcMain.handle("desktop:stream-popout-close", () => closeStreamPopoutWindow());

  ipcMain.handle("desktop:stream-popout-command", (_event, command) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return false;
    }

    mainWindow.webContents.send("desktop:stream-popout-command", command);
    return true;
  });

  ipcMain.handle("desktop:stream-popout-voice-state", (_event, state) => {
    if (!streamPopoutWindow || streamPopoutWindow.isDestroyed()) {
      return false;
    }

    streamPopoutWindow.webContents.send("desktop:stream-popout-voice-state", state);
    return true;
  });

  ipcMain.handle("desktop:clear-user-data", async () => {
    const userDataPath = app.getPath("userData");
    appendDesktopLog(`Clearing desktop user data at ${userDataPath}`);

    await markDesktopPresenceOffline("clear-user-data");

    for (const entry of fs.readdirSync(userDataPath, { withFileTypes: true })) {
      const absolutePath = path.join(userDataPath, entry.name);
      fs.rmSync(absolutePath, { recursive: true, force: true });
    }

    appendDesktopLog("Desktop user data cleared. Relaunching app.");
    app.relaunch();
    app.exit(0);
    return true;
  });

  ipcMain.handle("desktop:preferences-get", () => desktopPreferences);

  ipcMain.handle("desktop:preferences-set", (_event, preferences) =>
    setDesktopPreferences(preferences)
  );

  ipcMain.handle("desktop:tray-chat-state", (_event, state) => {
    trayChatState = sanitizeTrayChatState(state);
    updateTray();
    return true;
  });

  ipcMain.handle("desktop:system-idle-time", () => powerMonitor.getSystemIdleTime());

  ipcMain.handle("desktop:debug-log-mute", (_event, entry) => {
    appendVerboseDesktopLog(`[mute-debug] ${JSON.stringify(entry)}`);
    return desktopVerboseLogging;
  });

  ipcMain.handle("desktop:debug-log-process-metrics", (_event, reason) =>
    appendDesktopProcessMetrics(
      typeof reason === "string" && reason.trim() ? reason.trim() : "manual"
    )
  );

  ipcMain.handle("desktop:debug-open-devtools", (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) {
      return false;
    }

    window.webContents.openDevTools({ mode: "detach" });
    return true;
  });

  ipcMain.handle("desktop:debug-open-log-folder", async () => {
    await shell.openPath(path.dirname(getDesktopLogPath()));
    return getDesktopLogPath();
  });

  ipcMain.handle("desktop:diagnostics-append", (event, entries) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    if (!targetWindow || targetWindow !== mainWindow) {
      return false;
    }

    return appendClientDiagnostics(entries);
  });

  ipcMain.handle("desktop:diagnostics-export", (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    if (!targetWindow || targetWindow !== mainWindow) {
      return {
        status: "cancelled",
        eventCount: clientDiagnosticsHistory.length,
        filePath: null
      };
    }

    if (!clientDiagnosticsExportPromise) {
      clientDiagnosticsExportPromise = exportClientDiagnostics(targetWindow).finally(() => {
        clientDiagnosticsExportPromise = null;
      });
    }

    return clientDiagnosticsExportPromise;
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

function stopBundledServer() {
  if (!nextServerProcess) {
    return;
  }

  nextServerProcess.removeAllListeners();

  if (!nextServerProcess.killed) {
    nextServerProcess.kill();
  }

  nextServerProcess = null;
}

function normalizeBaseUrl(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.replace(/\/+$/u, "");
}

function getDefaultUpdateFeedUrl(publicAppUrl) {
  const normalizedPublicAppUrl = normalizeBaseUrl(publicAppUrl) || DEFAULT_PUBLIC_APP_URL;
  return `${normalizedPublicAppUrl}/desktop-updates/omarchy`;
}

function normalizeUpdateFeedUrl(value, publicAppUrl) {
  const configuredUrl = normalizeBaseUrl(value);
  return configuredUrl || getDefaultUpdateFeedUrl(publicAppUrl);
}

function resolveDesktopApiBaseUrl(values) {
  return (
    normalizeBaseUrl(values.SOVCHAT_API_BASE_URL) ||
    normalizeBaseUrl(values.SOVCHAT_REMOTE_APP_URL) ||
    DEFAULT_API_BASE_URL
  );
}

function resolveDesktopPublicAppUrl(values, apiBaseUrl) {
  return (
    normalizeBaseUrl(values.SOVCHAT_PUBLIC_APP_URL) ||
    normalizeBaseUrl(values.SOVCHAT_REMOTE_APP_URL) ||
    apiBaseUrl ||
    DEFAULT_PUBLIC_APP_URL
  );
}

function buildDesktopConfig(values) {
  const apiBaseUrl = resolveDesktopApiBaseUrl(values);
  const publicAppUrl = resolveDesktopPublicAppUrl(values, apiBaseUrl);

  return {
    apiBaseUrl,
    publicAppUrl,
    updateFeedUrl: normalizeUpdateFeedUrl(values.SOVCHAT_UPDATE_FEED_URL, publicAppUrl)
  };
}

function patchUpdateState(nextState) {
  updateState = {
    ...updateState,
    ...nextState
  };

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("desktop:update-state", updateState);
  }
}

function isUpdaterEnabled() {
  return getDesktopUpdatePolicy().enabled;
}

function getDesktopUpdatePolicy() {
  return resolveDesktopUpdatePolicy({
    isPackaged: app.isPackaged,
    enableDevUpdates: process.env.SOVCHAT_ENABLE_DEV_UPDATES === "true"
  });
}

function configureAutoUpdater() {
  if (!isUpdaterEnabled() || updaterConfigured) {
    return;
  }

  updaterConfigured = true;
  const installPlan = getDesktopUpdateInstallPlan();
  const updatePolicy = getDesktopUpdatePolicy();
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = installPlan.installMode === "silent";
  autoUpdater.allowDowngrade = updatePolicy.allowDowngrade;
  autoUpdater.logger = {
    info: (message) => appendDesktopLog(`[updater] ${String(message)}`),
    warn: (message) => appendDesktopLog(`[updater warn] ${String(message)}`),
    error: (message) => appendDesktopLog(`[updater error] ${String(message)}`),
    debug: (message) => appendDesktopLog(`[updater debug] ${String(message)}`)
  };
  autoUpdater.setFeedURL({
    provider: "generic",
    url: desktopConfig.updateFeedUrl,
    channel: updatePolicy.manifestChannel
  });
  // Setting a custom channel directly on autoUpdater enables downgrades in
  // electron-updater. Supplying it in the generic provider config avoids that
  // side effect; keep this explicit as a second guard against older releases.
  autoUpdater.allowDowngrade = updatePolicy.allowDowngrade;

  appendDesktopLog(
    `Desktop updater configured. buildChannel=${DESKTOP_BUILD_CHANNEL}; manifestChannel=${updatePolicy.manifestChannel}; allowDowngrade=${String(updatePolicy.allowDowngrade)}; feed=${desktopConfig.updateFeedUrl}`
  );

  patchUpdateState({
    currentVersion: app.getVersion(),
    feedUrl: desktopConfig.updateFeedUrl,
    ...installPlan
  });

  autoUpdater.on("checking-for-update", () => {
    appendDesktopLog(
      `Checking for desktop updates at ${desktopConfig.updateFeedUrl}/${updatePolicy.manifestChannel}.yml`
    );
    patchUpdateState({
      status: "checking",
      percent: null,
      error: null,
      checkedAt: new Date().toISOString()
    });
  });

  autoUpdater.on("update-available", (info) => {
    appendDesktopLog(`Desktop update available: ${info.version ?? "unknown"}`);
    patchUpdateState({
      status: "available",
      availableVersion: info.version ?? null,
      percent: null,
      error: null,
      checkedAt: new Date().toISOString()
    });

    setImmediate(() => {
      void downloadDesktopUpdate("background");
    });
  });

  autoUpdater.on("update-not-available", () => {
    appendDesktopLog("No desktop update available.");
    patchUpdateState({
      status: "not-available",
      availableVersion: null,
      percent: null,
      error: null,
      checkedAt: new Date().toISOString()
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    patchUpdateState({
      status: "downloading",
      percent: Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : null,
      error: null
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    appendDesktopLog(`Desktop update downloaded: ${info.version ?? "unknown"}`);
    patchUpdateState({
      status: "downloaded",
      availableVersion: info.version ?? updateState.availableVersion,
      percent: 100,
      error: null,
      checkedAt: new Date().toISOString()
    });
  });

  autoUpdater.on("error", (error) => {
    appendDesktopLog(`Desktop update check failed: ${serializeError(error)}`);
    patchUpdateState({
      status: "error",
      percent: null,
      error: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString()
    });
  });
}

function registerUpdateHandlers() {
  ipcMain.handle("desktop:updates-get-state", () => {
    if (isUpdaterEnabled()) {
      patchDesktopUpdateInstallPlan();
    }

    return updateState;
  });

  ipcMain.handle("desktop:updates-check", async () => checkForDesktopUpdates());

  ipcMain.handle("desktop:updates-download", async () => downloadDesktopUpdate("manual"));

  ipcMain.handle("desktop:updates-install", () => {
    if (!isUpdaterEnabled()) {
      return false;
    }

    if (updateState.status === "installing") {
      return true;
    }

    if (updateState.status !== "downloaded") {
      appendDesktopLog(`Ignored restart-to-update request while status is ${updateState.status}.`);
      return false;
    }

    const installPlan = patchDesktopUpdateInstallPlan();
    const isElevatedSilentInstall = installPlan.installMode === "elevated";
    let isSilentInstall = installPlan.installMode === "silent" || isElevatedSilentInstall;

    if (isElevatedSilentInstall && !requireElevatedSilentDesktopUpdateInstall()) {
      appendDesktopLog("Falling back to assisted desktop update install because elevation metadata could not be patched.");
      isSilentInstall = false;
    }

    patchUpdateState({
      status: "installing",
      percent: 100,
      error: null
    });

    if (updateInstallRestartTimer) {
      clearTimeout(updateInstallRestartTimer);
    }

    appendDesktopLog(
      `Desktop update install queued; restarting in ${UPDATE_INSTALL_RESTART_DELAY_MS}ms. mode=${installPlan.installMode}`
    );

    updateInstallRestartTimer = setTimeout(() => {
      updateInstallRestartTimer = null;
      try {
        allowMainWindowClose = true;
        app.isQuitting = true;
        autoUpdater.quitAndInstall(isSilentInstall, true);
      } catch (error) {
        appendDesktopLog(`Desktop update install handoff failed: ${serializeError(error)}`);
        allowMainWindowClose = false;
        app.isQuitting = false;
        patchUpdateState({
          status: "error",
          percent: 100,
          error: error instanceof Error ? error.message : String(error),
          checkedAt: new Date().toISOString()
        });
      }
    }, UPDATE_INSTALL_RESTART_DELAY_MS);
    updateInstallRestartTimer.unref?.();

    return true;
  });
}

function quitForExternalInstall(reason) {
  appendDesktopLog(`External installer requested app shutdown. reason=${reason}`);
  allowMainWindowClose = true;
  app.isQuitting = true;

  if (updateCheckInterval) {
    clearInterval(updateCheckInterval);
    updateCheckInterval = null;
  }

  stopDesktopMemoryMetricsLogging();
  stopBundledServer();

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.close();
    }
  }

  const forceExitTimeout = setTimeout(() => {
    appendDesktopLog(`Forcing app exit after installer shutdown request. reason=${reason}`);
    stopBundledServer();
    app.exit(0);
  }, 2500);
  forceExitTimeout.unref?.();

  app.quit();
}

async function downloadDesktopUpdate(reason = "manual") {
  if (!isUpdaterEnabled()) {
    return updateState;
  }

  configureAutoUpdater();

  if (updateState.status === "downloaded" || updateState.status === "installing") {
    return updateState;
  }

  if (updateDownloadPromise) {
    appendDesktopLog(`Joining existing desktop update download (${reason}).`);
    await updateDownloadPromise;
    return updateState;
  }

  appendDesktopLog(`Starting desktop update download (${reason}).`);
  patchUpdateState({
    status: "downloading",
    percent: updateState.percent ?? 0,
    error: null
  });

  updateDownloadPromise = autoUpdater.downloadUpdate()
    .catch((error) => {
      appendDesktopLog(`Desktop update download failed: ${serializeError(error)}`);
      patchUpdateState({
        status: "error",
        percent: null,
        error: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString()
      });
    })
    .finally(() => {
      updateDownloadPromise = null;
    });

  await updateDownloadPromise;
  return updateState;
}

async function checkForDesktopUpdates() {
  if (!isUpdaterEnabled()) {
    patchUpdateState({
      status: "idle",
      error: null
    });
    return updateState;
  }

  configureAutoUpdater();

  if (updateCheckInFlight) {
    appendDesktopLog("Skipped desktop update check because one is already in progress.");
    return updateState;
  }

  if (
    updateState.status === "available" ||
    updateState.status === "downloading" ||
    updateState.status === "downloaded" ||
    updateState.status === "installing"
  ) {
    appendDesktopLog(`Skipped desktop update check while status is ${updateState.status}.`);
    return updateState;
  }

  updateCheckInFlight = true;

  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    appendDesktopLog(`Desktop update check threw: ${serializeError(error)}`);
    patchUpdateState({
      status: "error",
      percent: null,
      error: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString()
    });
  } finally {
    updateCheckInFlight = false;
  }

  return updateState;
}

function startHourlyUpdateChecks() {
  if (!isUpdaterEnabled() || updateCheckInterval) {
    return;
  }

  updateCheckInterval = setInterval(() => {
    appendDesktopLog("Running scheduled hourly desktop update check.");
    void checkForDesktopUpdates();
  }, UPDATE_CHECK_INTERVAL_MS);

  if (typeof updateCheckInterval.unref === "function") {
    updateCheckInterval.unref();
  }
}

function registerUpdateLifecycleChecks() {
  if (!isUpdaterEnabled() || updateLifecycleChecksRegistered) {
    return;
  }

  updateLifecycleChecksRegistered = true;

  const scheduleLifecycleCheck = (reason) => {
    setTimeout(() => {
      appendDesktopLog(`Running ${reason} desktop update check.`);
      void checkForDesktopUpdates();
    }, UPDATE_RESUME_CHECK_DELAY_MS);
  };

  powerMonitor.on("resume", () => scheduleLifecycleCheck("resume"));
  powerMonitor.on("unlock-screen", () => scheduleLifecycleCheck("unlock"));
}

function scheduleLaunchUpdateCheck(targetWindow) {
  if (!isUpdaterEnabled()) {
    return;
  }

  targetWindow.webContents.once("did-finish-load", () => {
    setTimeout(() => {
      if (targetWindow.isDestroyed()) {
        return;
      }

      void checkForDesktopUpdates();
      startHourlyUpdateChecks();
    }, UPDATE_CHECK_DELAY_MS);
  });
}

function getListeningPidsForPort(port) {
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
            .filter((line) => line.includes(`:${port} `) || line.endsWith(`:${port}`))
            .map((line) => line.split(/\s+/u).at(-1))
            .filter((value) => value && /^\d+$/u.test(value))
            .map((value) => Number(value))
        )
      );
    }

    const output = execFileSync("lsof", ["-ti", `tcp:${port}`], {
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

function forceKillProcess(pid) {
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
  } catch (error) {
    appendDesktopLog(`Failed to kill process ${pid}: ${serializeError(error)}`);
  }
}

function forceReleasePort(port) {
  const pids = getListeningPidsForPort(port);

  if (!pids.length) {
    appendDesktopLog(`Port ${port} is already free.`);
    return;
  }

  appendDesktopLog(`Port ${port} is occupied by pid(s): ${pids.join(", ")}. Terminating them.`);
  for (const pid of pids) {
    forceKillProcess(pid);
  }
}

async function startStandaloneServer(appRoot, envOverrides) {
  const standaloneDir = path.join(appRoot, ".next", "standalone");
  const serverPath = path.join(standaloneDir, "server.js");
  const standaloneNodeModulesPath = path.join(standaloneDir, "standalone_node_modules");

  if (!fs.existsSync(serverPath)) {
    throw new Error(`Standalone server not found at ${serverPath}. Run npm run build first.`);
  }

  forceReleasePort(PORT);

  nextServerProcess = spawn(process.execPath, [serverPath], {
    cwd: standaloneDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...envOverrides,
      ELECTRON_RUN_AS_NODE: "1",
      HOSTNAME: HOST,
      NODE_PATH: standaloneNodeModulesPath,
      PORT: String(PORT),
      NODE_ENV: "production"
    }
  });

  appendDesktopLog(`Starting bundled server from ${serverPath}`);

  nextServerProcess.stdout?.on("data", (chunk) => {
    appendDesktopLog(`[server stdout] ${String(chunk).trimEnd()}`);
  });

  nextServerProcess.stderr?.on("data", (chunk) => {
    appendDesktopLog(`[server stderr] ${String(chunk).trimEnd()}`);
  });

  nextServerProcess.once("exit", (code, signal) => {
    appendDesktopLog(`Bundled server exited. code=${code ?? "unknown"} signal=${signal ?? "none"}`);
    nextServerProcess = null;

    if (!app.isQuitting) {
      void dialog.showMessageBox({
        type: "error",
        title: "SovChat server stopped",
        message: "The embedded Next.js server exited unexpectedly.",
        detail: `Code: ${code ?? "unknown"} Signal: ${signal ?? "none"}`
      });
      app.quit();
    }
  });

  await waitForServer(`http://${HOST}:${PORT}/desktop`, 30_000);
}

async function startBundledServer() {
  const appRoot = getPackagedAppRoot();
  const { filePath: envFilePath, values: desktopEnv } = loadDesktopEnv();
  configureDesktopVerboseLogging(desktopEnv);
  const missingKeys = getMissingDesktopKeys(desktopEnv);

  if (missingKeys.length > 0) {
    const detail = [
      `Update ${envFilePath} with the hosted SovChat API URL and launch the app again.`,
      "",
      `Missing: ${missingKeys.join(", ")}`
    ].join("\n");

    await dialog.showMessageBox({
      type: "error",
      title: "Desktop config required",
      message: "The packaged app needs a desktop.env file before it can start.",
      detail
    });

    if (envFilePath) {
      await shell.openPath(path.dirname(envFilePath));
    }

    throw new Error(detail);
  }

  desktopConfig = buildDesktopConfig(desktopEnv);

  await startStandaloneServer(appRoot, {
    ...desktopEnv,
    SOVCHAT_API_BASE_URL: desktopConfig.apiBaseUrl,
    SOVCHAT_PUBLIC_APP_URL: desktopConfig.publicAppUrl,
    SOVCHAT_REMOTE_APP_URL: desktopConfig.apiBaseUrl
  });
}

function configureSourceDesktopConfig() {
  configureDesktopVerboseLogging(process.env);
  desktopConfig = buildDesktopConfig(process.env);
}

async function startSourceServer() {
  const appRoot = getSourceAppRoot();
  configureSourceDesktopConfig();
  await startStandaloneServer(appRoot, {
    SOVCHAT_API_BASE_URL: desktopConfig.apiBaseUrl,
    SOVCHAT_PUBLIC_APP_URL: desktopConfig.publicAppUrl,
    SOVCHAT_REMOTE_APP_URL: desktopConfig.apiBaseUrl
  });
}

async function loadPackagedDesktopConfig() {
  const { filePath: envFilePath, values: desktopEnv } = loadDesktopEnv();
  configureDesktopVerboseLogging(desktopEnv);
  const missingKeys = getMissingDesktopKeys(desktopEnv);

  if (missingKeys.length > 0) {
    const detail = [
      `Update ${envFilePath} with the hosted SovChat API URL and launch the app again.`,
      "",
      `Missing: ${missingKeys.join(", ")}`
    ].join("\n");

    await dialog.showMessageBox({
      type: "error",
      title: "Desktop config required",
      message: "The packaged app needs a desktop.env file before it can start.",
      detail
    });

    if (envFilePath) {
      await shell.openPath(path.dirname(envFilePath));
    }

    throw new Error(detail);
  }

  desktopConfig = buildDesktopConfig(desktopEnv);
}

function createMainWindow(startUrl) {
  const savedWindowState = loadDesktopWindowState();
  const defaultExpandedBounds = { x: 80, y: 60, width: 1440, height: 900 };
  mainWindowCompact = Boolean(savedWindowState?.compact);
  mainWindowExpandedBounds = savedWindowState?.bounds ?? defaultExpandedBounds;
  const initialBounds = mainWindowCompact
    ? getCompactWindowBounds(mainWindowExpandedBounds)
    : savedWindowState?.bounds;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    ...(initialBounds ?? {}),
    minWidth: mainWindowCompact ? DESKTOP_COMPACT_MIN_WIDTH : DESKTOP_EXPANDED_MIN_WIDTH,
    minHeight: mainWindowCompact ? DESKTOP_COMPACT_MIN_HEIGHT : DESKTOP_EXPANDED_MIN_HEIGHT,
    maxWidth: mainWindowCompact ? DESKTOP_COMPACT_WIDTH : undefined,
    maxHeight: mainWindowCompact ? DESKTOP_COMPACT_HEIGHT : undefined,
    resizable: !mainWindowCompact,
    maximizable: !mainWindowCompact,
    fullscreenable: !mainWindowCompact,
    frame: false,
    backgroundColor: "#0e161b",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: path.join(__dirname, "preload.cjs"),
      additionalArguments: [
        `${DESKTOP_API_BASE_URL_ARG_PREFIX}${desktopConfig.apiBaseUrl}`,
        `${DESKTOP_PUBLIC_APP_URL_ARG_PREFIX}${desktopConfig.publicAppUrl}`,
        `${DESKTOP_REMOTE_URL_ARG_PREFIX}${desktopConfig.apiBaseUrl}`,
        `${DESKTOP_WINDOW_ROLE_ARG_PREFIX}main`
      ]
    }
  });

  installHostedRendererNavigationGuard(mainWindow, "main");

  if (savedWindowState?.maximized && !mainWindowCompact) {
    mainWindow.maximize();
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("did-fail-load", (_event, code, description, validatedUrl) => {
    appendDesktopLog(
      `BrowserWindow failed to load. code=${code} description=${description} url=${validatedUrl}`
    );
  });

  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    if (!desktopVerboseLogging && level < RENDERER_CONSOLE_WARNING_LEVEL) {
      return;
    }

    appendDesktopLog(
      `[renderer console] level=${level} source=${sourceId}:${line} message=${message}`
    );
  });

  mainWindow.webContents.on("before-input-event", (event, input) => {
    const key = input.key?.toLowerCase();
    const isDevToolsShortcut =
      input.type === "keyDown" &&
      (key === "f12" || (input.control && input.shift && key === "i"));

    if (!isDevToolsShortcut) {
      return;
    }

    event.preventDefault();
    if (mainWindow.webContents.isDevToolsOpened()) {
      mainWindow.webContents.closeDevTools();
      return;
    }

    mainWindow.webContents.openDevTools({ mode: "detach" });
  });

  mainWindow.on("maximize", () => sendWindowState(mainWindow));
  mainWindow.on("unmaximize", () => {
    sendWindowState(mainWindow);
    scheduleDesktopWindowStateSave(mainWindow);
  });
  mainWindow.on("move", () => scheduleDesktopWindowStateSave(mainWindow));
  mainWindow.on("resize", () => scheduleDesktopWindowStateSave(mainWindow));
  mainWindow.on("enter-full-screen", () => sendWindowState(mainWindow));
  mainWindow.on("leave-full-screen", () => sendWindowState(mainWindow));
  mainWindow.on("close", (event) => {
    flushDesktopWindowStateSave(mainWindow);
    if (process.platform !== "win32" || app.isQuitting || allowMainWindowClose) {
      return;
    }

    if (desktopPreferences.closeAction === "tray") {
      event.preventDefault();
      mainWindow.hide();
      return;
    }

    if (desktopPreferences.closeAction === "exit") {
      return;
    }

    event.preventDefault();
    void promptForMainWindowClose(mainWindow);
  });

  scheduleLaunchUpdateCheck(mainWindow);

  void mainWindow.loadURL(startUrl);
}

async function bootstrap() {
  loadDesktopPreferences();
  loadClientDiagnosticsHistory();
  applyLoginItemPreference();
  registerDesktopPermissionHandlers();
  registerDesktopCaptureHandlers();
  registerWindowHandlers();
  registerUpdateHandlers();
  registerUpdateLifecycleChecks();
  registerDesktopRendererProtocol();

  if (process.platform === "linux") {
    appendDesktopLog(`[linux-runtime] ${JSON.stringify(getDesktopRuntimeDiagnostics())}`);
  }

  if (!app.isPackaged) {
    configureSourceDesktopConfig();
    startDesktopMemoryMetricsLogging();

    if (!process.env.ELECTRON_START_URL) {
      await startSourceServer();
    }

    createMainWindow(process.env.ELECTRON_START_URL ?? `http://${HOST}:${PORT}/desktop`);
    updateTray();
    return;
  }

  try {
    appendDesktopLog("Electron packaged bootstrap starting.");
    if (IS_WIP_BUILD) {
      appendDesktopLog(
        "WIP desktop build active; stable latest update checks enabled; downgrades disabled."
      );
    }
    await loadPackagedDesktopConfig();
    startDesktopMemoryMetricsLogging();
    appendDesktopLog(
      `Loading packaged desktop renderer from ${DESKTOP_APP_SCHEME}://${DESKTOP_APP_HOST}/desktop with remote backend ${desktopConfig.apiBaseUrl}`
    );
    createMainWindow(buildPackagedDesktopEntryUrl("/desktop"));
    updateTray();
  } catch (error) {
    appendDesktopLog(`Bootstrap failed: ${serializeError(error)}`);
    console.error(error);
    app.quit();
  }
}

app.on("before-quit", (event) => {
  app.isQuitting = true;

  if (
    !desktopPresenceQuitInFlight &&
    desktopPresenceSessionToken &&
    updateState.status !== "installing"
  ) {
    event.preventDefault();
    desktopPresenceQuitInFlight = true;
    void markDesktopPresenceOffline("app-quit").finally(() => {
      desktopPresenceQuitInFlight = false;
      app.quit();
    });
    return;
  }

  if (desktopPresenceSessionToken) {
    void markDesktopPresenceOffline("update-install-quit");
  }

  if (updateCheckInterval) {
    clearInterval(updateCheckInterval);
    updateCheckInterval = null;
  }
  stopDesktopMemoryMetricsLogging();
  stopBundledServer();
});

if (!hasSingleInstanceLock) {
  app.quit();
} else if (isQuitForInstallLaunch) {
  app.exit(0);
} else {
  app.on("second-instance", (_event, commandLine) => {
    if (commandLine.includes(DESKTOP_QUIT_FOR_INSTALL_ARG)) {
      quitForExternalInstall("installer-second-instance");
      return;
    }

    showMainWindow();
  });

  app.whenReady().then(bootstrap);

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("activate", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      showMainWindow();
      return;
    }

    createMainWindow(
      app.isPackaged
        ? buildPackagedDesktopEntryUrl("/desktop")
        : process.env.ELECTRON_START_URL ?? `http://${HOST}:${PORT}/desktop`
    );
  });
}
