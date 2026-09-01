export type DesktopDisplayMediaSource = {
  id: string;
  name: string;
  kind: "screen" | "window";
  thumbnailDataUrl: string | null;
  appIconDataUrl: string | null;
  displayId: string | null;
};

export type DesktopScreenShareSelection = {
  id: string;
  kind: "screen" | "window";
  includeSystemAudio?: boolean;
};

export type DesktopUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "not-available"
  | "error";

export type DesktopUpdateInstallMode = "silent" | "elevated" | "assisted";

export type DesktopUpdateState = {
  status: DesktopUpdateStatus;
  currentVersion: string;
  availableVersion: string | null;
  percent: number | null;
  error: string | null;
  checkedAt: string | null;
  feedUrl: string | null;
  installMode: DesktopUpdateInstallMode;
  installDirectory: string | null;
  installDirectoryWritable: boolean | null;
};

export const DESKTOP_UPDATE_INSTALL_STAGE_EVENT = "sovchat:desktop-update-install-stage";

export type DesktopUpdateInstallStageDetail = {
  active?: boolean;
  source?: "install";
};

export type DesktopPreferences = {
  startWithWindows: boolean;
  closeToTray: boolean;
  trayIconEnabled: boolean;
  closeAction: "ask" | "exit" | "tray";
};

export type DesktopTrayCommand =
  | "open-chat"
  | "toggle-input-muted"
  | "toggle-output-muted"
  | "logout";

export type DesktopTrayChatState = {
  whisperCount: number;
  mentionCount: number;
  hasUnreadMessages?: boolean;
};

export type DesktopWindowRole = "main" | "stream-popout";

export type DesktopWindowState = {
  maximized: boolean;
  compact: boolean;
};

export type DesktopStreamPopoutRequest = {
  streamIdentity: string;
  streamLabel?: string | null;
};

export type DesktopStreamPopoutClosedEvent = {
  streamIdentity: string | null;
};

export type DesktopStreamPopoutVoiceState = {
  connected: boolean;
  inputMuted: boolean;
  outputMuted: boolean;
  streamMuted: boolean;
  streamVolume: number;
  nickname: string;
  streamLabel: string | null;
};

export type DesktopStreamPopoutCommand =
  | "toggle-input-muted"
  | "toggle-output-muted"
  | "leave-room"
  | "stop-watching"
  | "pop-back-in"
  | { type: "set-stream-muted"; value: boolean }
  | { type: "set-stream-volume"; value: number };

export type DesktopProcessMetric = {
  pid: number;
  type: string;
  name: string | null;
  serviceName: string | null;
  cpuPercent: number | null;
  workingSetMb: number | null;
  peakWorkingSetMb: number | null;
  privateMb: number | null;
  sharedMb: number | null;
  rawMemory: Record<string, unknown>;
};

export type DesktopClientDiagnosticsExportResult = {
  status: "saved" | "cancelled";
  eventCount: number;
  filePath: string | null;
};

export type SovChatDesktopBridge = {
  isDesktop: boolean;
  apiBaseUrl?: string;
  publicAppUrl?: string;
  remoteAppUrl?: string;
  windowRole?: DesktopWindowRole;
  listDisplayMediaSources: () => Promise<DesktopDisplayMediaSource[]>;
  prepareScreenShareSource: (
    selection: DesktopScreenShareSelection
  ) => Promise<boolean>;
  openStreamPopout?: (request: DesktopStreamPopoutRequest) => Promise<boolean>;
  closeStreamPopout?: () => Promise<boolean>;
  sendStreamPopoutCommand?: (command: DesktopStreamPopoutCommand) => Promise<boolean>;
  publishStreamPopoutVoiceState?: (state: DesktopStreamPopoutVoiceState) => Promise<boolean>;
  minimizeWindow?: () => Promise<void>;
  toggleMaximizeWindow?: () => Promise<void>;
  setCompactWindow?: (compact: boolean) => Promise<DesktopWindowState>;
  closeWindow?: () => Promise<void>;
  setPresenceSessionToken?: (token: string | null) => Promise<boolean>;
  clearUserData?: () => Promise<boolean>;
  getDesktopPreferences?: () => Promise<DesktopPreferences>;
  setDesktopPreferences?: (preferences: Partial<DesktopPreferences>) => Promise<DesktopPreferences>;
  getSystemIdleTime?: () => Promise<number>;
  appendClientDiagnostics?: (entries: unknown[]) => Promise<boolean>;
  exportClientDiagnostics?: () => Promise<DesktopClientDiagnosticsExportResult>;
  logMuteDebug?: (entry: unknown) => Promise<boolean>;
  logProcessMetrics?: (reason?: string) => Promise<DesktopProcessMetric[]>;
  openDevTools?: () => Promise<boolean>;
  openLogFolder?: () => Promise<string>;
  getUpdateState?: () => Promise<DesktopUpdateState>;
  checkForUpdates?: () => Promise<DesktopUpdateState>;
  downloadUpdate?: () => Promise<DesktopUpdateState>;
  installUpdate?: () => Promise<boolean>;
  restartToUpdate?: () => Promise<boolean>;
  setTrayChatState?: (state: DesktopTrayChatState) => Promise<boolean>;
  subscribeUpdateState?: (
    listener: (state: DesktopUpdateState) => void
  ) => (() => void) | undefined;
  subscribeWindowState?: (
    listener: (state: DesktopWindowState) => void
  ) => (() => void) | undefined;
  subscribeTrayCommand?: (
    listener: (command: DesktopTrayCommand) => void
  ) => (() => void) | undefined;
  subscribeStreamPopoutClosed?: (
    listener: (event: DesktopStreamPopoutClosedEvent) => void
  ) => (() => void) | undefined;
  subscribeStreamPopoutCommand?: (
    listener: (command: DesktopStreamPopoutCommand) => void
  ) => (() => void) | undefined;
  subscribeStreamPopoutVoiceState?: (
    listener: (state: DesktopStreamPopoutVoiceState) => void
  ) => (() => void) | undefined;
};

declare global {
  interface Window {
    sovchatDesktop?: SovChatDesktopBridge;
  }
}

export function getDesktopBridge() {
  if (typeof window === "undefined") {
    return null;
  }

  return window.sovchatDesktop ?? null;
}
