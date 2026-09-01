const { contextBridge, ipcRenderer } = require("electron");

const API_BASE_URL_ARG_PREFIX = "--sovchat-api-base-url=";
const PUBLIC_APP_URL_ARG_PREFIX = "--sovchat-public-app-url=";
const REMOTE_URL_ARG_PREFIX = "--sovchat-remote-app-url=";
const WINDOW_ROLE_ARG_PREFIX = "--sovchat-window-role=";
const apiBaseUrlArg = process.argv.find((value) => value.startsWith(API_BASE_URL_ARG_PREFIX));
const publicAppUrlArg = process.argv.find((value) => value.startsWith(PUBLIC_APP_URL_ARG_PREFIX));
const remoteUrlArg = process.argv.find((value) => value.startsWith(REMOTE_URL_ARG_PREFIX));
const windowRoleArg = process.argv.find((value) => value.startsWith(WINDOW_ROLE_ARG_PREFIX));
const legacyRemoteAppUrl = remoteUrlArg
  ? remoteUrlArg.slice(REMOTE_URL_ARG_PREFIX.length)
  : process.env.SOVCHAT_REMOTE_APP_URL || "";
const apiBaseUrl = apiBaseUrlArg
  ? apiBaseUrlArg.slice(API_BASE_URL_ARG_PREFIX.length)
  : process.env.SOVCHAT_API_BASE_URL || legacyRemoteAppUrl || "https://sovchat.com";
const publicAppUrl = publicAppUrlArg
  ? publicAppUrlArg.slice(PUBLIC_APP_URL_ARG_PREFIX.length)
  : process.env.SOVCHAT_PUBLIC_APP_URL || legacyRemoteAppUrl || apiBaseUrl;
const windowRole = windowRoleArg ? windowRoleArg.slice(WINDOW_ROLE_ARG_PREFIX.length) : "main";

contextBridge.exposeInMainWorld("sovchatDesktop", {
  isDesktop: true,
  apiBaseUrl,
  publicAppUrl,
  remoteAppUrl: apiBaseUrl,
  windowRole,
  listDisplayMediaSources: () => ipcRenderer.invoke("desktop:list-display-media-sources"),
  prepareScreenShareSource: (selection) =>
    ipcRenderer.invoke("desktop:prepare-screen-share-source", selection),
  openStreamPopout: (request) => ipcRenderer.invoke("desktop:stream-popout-open", request),
  closeStreamPopout: () => ipcRenderer.invoke("desktop:stream-popout-close"),
  sendStreamPopoutCommand: (command) =>
    ipcRenderer.invoke("desktop:stream-popout-command", command),
  publishStreamPopoutVoiceState: (state) =>
    ipcRenderer.invoke("desktop:stream-popout-voice-state", state),
  minimizeWindow: () => ipcRenderer.invoke("desktop:window-minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("desktop:window-toggle-maximize"),
  setCompactWindow: (compact) => ipcRenderer.invoke("desktop:window-set-compact", compact),
  closeWindow: () => ipcRenderer.invoke("desktop:window-close"),
  setPresenceSessionToken: (token) =>
    ipcRenderer.invoke("desktop:presence-token-sync", token),
  clearUserData: () => ipcRenderer.invoke("desktop:clear-user-data"),
  getDesktopPreferences: () => ipcRenderer.invoke("desktop:preferences-get"),
  setDesktopPreferences: (preferences) =>
    ipcRenderer.invoke("desktop:preferences-set", preferences),
  getSystemIdleTime: () => ipcRenderer.invoke("desktop:system-idle-time"),
  appendClientDiagnostics: (entries) => ipcRenderer.invoke("desktop:diagnostics-append", entries),
  exportClientDiagnostics: () => ipcRenderer.invoke("desktop:diagnostics-export"),
  logMuteDebug: (entry) => ipcRenderer.invoke("desktop:debug-log-mute", entry),
  logProcessMetrics: (reason) => ipcRenderer.invoke("desktop:debug-log-process-metrics", reason),
  openDevTools: () => ipcRenderer.invoke("desktop:debug-open-devtools"),
  openLogFolder: () => ipcRenderer.invoke("desktop:debug-open-log-folder"),
  getUpdateState: () => ipcRenderer.invoke("desktop:updates-get-state"),
  checkForUpdates: () => ipcRenderer.invoke("desktop:updates-check"),
  downloadUpdate: () => ipcRenderer.invoke("desktop:updates-download"),
  installUpdate: () => ipcRenderer.invoke("desktop:updates-install"),
  restartToUpdate: () => ipcRenderer.invoke("desktop:updates-install"),
  setTrayChatState: (state) => ipcRenderer.invoke("desktop:tray-chat-state", state),
  subscribeUpdateState: (listener) => {
    if (typeof listener !== "function") {
      return undefined;
    }

    const handleState = (_event, state) => {
      listener(state);
    };

    ipcRenderer.on("desktop:update-state", handleState);
    void ipcRenderer.invoke("desktop:updates-get-state").then((state) => {
      listener(state);
    });

    return () => {
      ipcRenderer.removeListener("desktop:update-state", handleState);
    };
  },
  subscribeWindowState: (listener) => {
    if (typeof listener !== "function") {
      return undefined;
    }

    const handleState = (_event, state) => {
      listener(state);
    };

    ipcRenderer.on("desktop:window-state", handleState);
    void ipcRenderer.invoke("desktop:window-get-state").then((state) => {
      listener(state);
    });

    return () => {
      ipcRenderer.removeListener("desktop:window-state", handleState);
    };
  },
  subscribeTrayCommand: (listener) => {
    if (typeof listener !== "function") {
      return undefined;
    }

    const handleCommand = (_event, command) => {
      listener(command);
    };

    ipcRenderer.on("desktop:tray-command", handleCommand);

    return () => {
      ipcRenderer.removeListener("desktop:tray-command", handleCommand);
    };
  },
  subscribeStreamPopoutClosed: (listener) => {
    if (typeof listener !== "function") {
      return undefined;
    }

    const handleClosed = (_event, payload) => {
      listener(payload);
    };

    ipcRenderer.on("desktop:stream-popout-closed", handleClosed);

    return () => {
      ipcRenderer.removeListener("desktop:stream-popout-closed", handleClosed);
    };
  },
  subscribeStreamPopoutCommand: (listener) => {
    if (typeof listener !== "function") {
      return undefined;
    }

    const handleCommand = (_event, command) => {
      listener(command);
    };

    ipcRenderer.on("desktop:stream-popout-command", handleCommand);

    return () => {
      ipcRenderer.removeListener("desktop:stream-popout-command", handleCommand);
    };
  },
  subscribeStreamPopoutVoiceState: (listener) => {
    if (typeof listener !== "function") {
      return undefined;
    }

    const handleState = (_event, state) => {
      listener(state);
    };

    ipcRenderer.on("desktop:stream-popout-voice-state", handleState);

    return () => {
      ipcRenderer.removeListener("desktop:stream-popout-voice-state", handleState);
    };
  }
});
