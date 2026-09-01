const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const previewUrl = process.env.SOVCHAT_LAYOUT_TEST_URL ?? "http://127.0.0.1:3001/desktop";
const previewOrigin = new URL(previewUrl).origin;
const screenshotSuffix = "-linux";
const outputDirectory = path.join(os.tmpdir(), "sovchat-layout-visual");
const expandedScreenshotPath = path.join(outputDirectory, `expanded${screenshotSuffix}.png`);
const compactScreenshotPath = path.join(outputDirectory, `compact${screenshotSuffix}.png`);
const compactChatScreenshotPath = path.join(outputDirectory, `compact-chat${screenshotSuffix}.png`);
const compactSettingsScreenshotPath = path.join(outputDirectory, `compact-settings${screenshotSuffix}.png`);
const reportPath = path.join(outputDirectory, `report${screenshotSuffix}.json`);

let compact = false;
let mainWindow = null;
const rendererMessages = [];

fs.mkdirSync(outputDirectory, { recursive: true });
app.disableHardwareAcceleration();
app.setPath("userData", path.join(outputDirectory, `profile-${process.pid}`));

function windowState() {
  return {
    maximized: Boolean(mainWindow?.isMaximized()),
    compact
  };
}

function sendWindowState() {
  mainWindow?.webContents.send("desktop:window-state", windowState());
}

function registerHarnessIpc() {
  ipcMain.handle("desktop:window-get-state", windowState);
  ipcMain.handle("desktop:window-set-compact", (_event, nextCompact) => {
    compact = Boolean(nextCompact);
    mainWindow.setFullScreenable(!compact);
    mainWindow.setMaximizable(!compact);
    mainWindow.setResizable(!compact);
    if (compact) {
      mainWindow.setMinimumSize(352, 656);
      mainWindow.setMaximumSize(352, 656);
    } else {
      mainWindow.setMaximumSize(0, 0);
      mainWindow.setMinimumSize(1100, 720);
    }
    mainWindow.setBounds(compact
      ? { x: 100, y: 80, width: 352, height: 656 }
      : { x: 80, y: 60, width: 1440, height: 900 });
    sendWindowState();
    return windowState();
  });
  ipcMain.handle("desktop:window-minimize", () => undefined);
  ipcMain.handle("desktop:window-toggle-maximize", () => undefined);
  ipcMain.handle("desktop:window-close", () => undefined);
  ipcMain.handle("desktop:updates-get-state", () => ({
    status: "idle",
    currentVersion: "visual-test",
    availableVersion: null,
    percent: null,
    error: null,
    checkedAt: null,
    feedUrl: null,
    installMode: "silent",
    installDirectory: null,
    installDirectoryWritable: null
  }));
  ipcMain.handle("desktop:preferences-get", () => ({
    startWithWindows: false,
    closeToTray: false,
    trayIconEnabled: false,
    closeAction: "ask"
  }));
  ipcMain.handle("desktop:system-idle-time", () => 0);
  ipcMain.handle("desktop:diagnostics-append", () => true);
  ipcMain.handle("desktop:tray-chat-state", () => true);
  ipcMain.handle("desktop:stream-popout-voice-state", () => true);
  ipcMain.handle("desktop:list-display-media-sources", () => []);
}

async function capture(name, targetPath) {
  const image = await mainWindow.webContents.capturePage();
  fs.writeFileSync(targetPath, image.toPNG());
  const rendererMetrics = await mainWindow.webContents.executeJavaScript(`(() => ({
    rects: Object.fromEntries(['.compact-voice-stage', '.compact-stage-controls', '.compact-primary-dock', '.desktop-titlebar__layout-button'].map((selector) => {
      const element = document.querySelector(selector);
      if (!element) return [selector, null];
      const rect = element.getBoundingClientRect();
      return [selector, { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom }];
    })),
    scrollMetrics: Object.fromEntries(['.compact-chat-stage', '.chat-scroll', '.chat-composer-shell', '.settings-panel-nav', '.settings-content-column'].map((selector) => {
      const element = document.querySelector(selector);
      if (!element) return [selector, null];
      const rect = element.getBoundingClientRect();
      return [selector, {
        clientHeight: element.clientHeight,
        clientWidth: element.clientWidth,
        scrollHeight: element.scrollHeight,
        scrollWidth: element.scrollWidth,
        x: rect.x,
        y: rect.y,
        right: rect.right,
        bottom: rect.bottom
      }];
    })),
    bodyLayout: document.body.dataset.appLayout ?? null,
    bodyUiMode: document.body.dataset.uiMode ?? null,
    bodyWidth: document.body.scrollWidth,
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    compactStageCount: document.querySelectorAll('.compact-voice-stage').length,
    layoutToggleLabel: document.querySelector('.desktop-titlebar__layout-button')?.getAttribute('aria-label') ?? null
  }))()`);

  return {
    name,
    bounds: mainWindow.getBounds(),
    capabilities: {
      fullscreenable: mainWindow.isFullScreenable(),
      maximizable: mainWindow.isMaximizable(),
      resizable: mainWindow.isResizable()
    },
    rendererMetrics,
    screenshotPath: targetPath
  };
}

async function waitForLayoutToggle(label, timeoutMs = 10_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const found = await mainWindow.webContents.executeJavaScript(
      `Boolean(document.querySelector('[aria-label="${label}"]'))`
    );

    if (found) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return false;
}

async function waitForAppShell(timeoutMs = 10_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const found = await mainWindow.webContents.executeJavaScript(
      "Boolean(document.querySelector('[aria-label=\"Join voice\"]'))"
    );

    if (found) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return false;
}

async function waitForSelector(selector, timeoutMs = 10_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const found = await mainWindow.webContents.executeJavaScript(
      `Boolean(document.querySelector(${JSON.stringify(selector)}))`
    );

    if (found) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return false;
}

app.whenReady().then(async () => {
  registerHarnessIpc();

  mainWindow = new BrowserWindow({
    x: 80,
    y: 60,
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    frame: false,
    show: false,
    backgroundColor: "#0e161b",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      preload: path.join(__dirname, "..", "electron", "preload.cjs"),
      additionalArguments: [
        `--sovchat-api-base-url=${previewOrigin}`,
        `--sovchat-public-app-url=${previewOrigin}`,
        `--sovchat-remote-app-url=${previewOrigin}`,
        "--sovchat-window-role=main"
      ]
    }
  });

  mainWindow.webContents.on("console-message", (event) => {
    rendererMessages.push({ level: event.level, message: event.message });
  });

  await mainWindow.loadURL(previewUrl);
  const compactToggleReady = await waitForLayoutToggle("Compact SovChat layout");
  const appShellReady = await waitForAppShell();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const initialBounds = mainWindow.getBounds();

  const clickedCompact = compactToggleReady && await mainWindow.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('[aria-label="Compact SovChat layout"]');
    button?.click();
    return Boolean(button);
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const compactCapture = await capture("compact", compactScreenshotPath);

  const clickedChat = await mainWindow.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('[aria-label="Open room chat"]');
    button?.click();
    return Boolean(button);
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 350));
  const compactChatCapture = await capture("compact-chat", compactChatScreenshotPath);

  await mainWindow.webContents.executeJavaScript(`(() => {
    document.querySelector('[aria-label="Close chat"]')?.click();
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 250));

  const clickedSettings = await mainWindow.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('[aria-label="Open settings"]');
    button?.click();
    return Boolean(button);
  })()`);
  const settingsReady = await waitForSelector(".settings-panel-nav");
  await new Promise((resolve) => setTimeout(resolve, 350));
  const compactSettingsCapture = await capture("compact-settings", compactSettingsScreenshotPath);

  const clickedExpand = await mainWindow.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('[aria-label="Expand SovChat layout"]');
    button?.click();
    return Boolean(button);
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const expanded = await capture("expanded", expandedScreenshotPath);

  const report = {
    clickedCompact,
    clickedExpand,
    compactToggleReady,
    appShellReady,
    initialBounds,
    expanded,
    compact: compactCapture,
    compactChat: compactChatCapture,
    compactSettings: compactSettingsCapture,
    clickedChat,
    clickedSettings,
    settingsReady,
    restoredBounds: mainWindow.getBounds(),
    rendererMessages,
    rendererText: await mainWindow.webContents.executeJavaScript(
      "document.body.innerText.slice(0, 2000)"
    )
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  const compactRects = compactCapture.rendererMetrics.rects;
  assert.equal(clickedCompact, true);
  assert.equal(clickedExpand, true);
  assert.equal(clickedChat, true);
  assert.equal(clickedSettings, true);
  assert.equal(settingsReady, true);
  assert.equal(appShellReady, true);
  assert.deepEqual(initialBounds, { x: 80, y: 60, width: 1440, height: 900 });
  assert.deepEqual(expanded.bounds, initialBounds);
  assert.deepEqual(compactCapture.bounds, { x: 100, y: 80, width: 352, height: 656 });
  assert.deepEqual(compactCapture.capabilities, {
    fullscreenable: false,
    maximizable: false,
    resizable: false
  });
  assert.deepEqual(expanded.capabilities, {
    fullscreenable: true,
    maximizable: true,
    resizable: true
  });
  assert.deepEqual(report.restoredBounds, expanded.bounds);
  assert.equal(compactCapture.rendererMetrics.bodyLayout, "compact");
  assert.equal(compactCapture.rendererMetrics.bodyUiMode, requestedUiMode);
  assert.equal(compactCapture.rendererMetrics.compactStageCount, 1);
  assert.equal(
    compactCapture.rendererMetrics.documentWidth,
    compactCapture.rendererMetrics.viewportWidth
  );
  assert.equal(compactRects[".compact-primary-dock"].x, 0);
  assert.equal(
    compactRects[".compact-primary-dock"].right,
    compactCapture.rendererMetrics.viewportWidth
  );
  assert.equal(
    compactRects[".compact-primary-dock"].bottom,
    compactCapture.rendererMetrics.viewportHeight
  );
  assert.ok(compactRects[".compact-stage-controls"].bottom < compactRects[".compact-primary-dock"].y);
  assert.ok(compactRects[".desktop-titlebar__layout-button"].x >= 0);
  assert.ok(
    compactRects[".desktop-titlebar__layout-button"].right <= compactCapture.rendererMetrics.viewportWidth
  );
  assert.equal(
    compactChatCapture.rendererMetrics.documentWidth,
    compactChatCapture.rendererMetrics.viewportWidth
  );
  assert.ok(
    compactChatCapture.rendererMetrics.scrollMetrics[".chat-scroll"].scrollWidth <=
      compactChatCapture.rendererMetrics.scrollMetrics[".chat-scroll"].clientWidth
  );
  assert.ok(
    compactChatCapture.rendererMetrics.scrollMetrics[".chat-composer-shell"].right <=
      compactChatCapture.rendererMetrics.viewportWidth
  );
  assert.equal(
    compactSettingsCapture.rendererMetrics.documentWidth,
    compactSettingsCapture.rendererMetrics.viewportWidth
  );
  assert.ok(
    compactSettingsCapture.rendererMetrics.scrollMetrics[".settings-panel-nav"].scrollWidth <=
      compactSettingsCapture.rendererMetrics.scrollMetrics[".settings-panel-nav"].clientWidth
  );
  assert.ok(
    compactSettingsCapture.rendererMetrics.scrollMetrics[".settings-content-column"].scrollWidth <=
      compactSettingsCapture.rendererMetrics.scrollMetrics[".settings-content-column"].clientWidth
  );
  assert.ok(
    compactSettingsCapture.rendererMetrics.scrollMetrics[".settings-content-column"].scrollHeight <=
      compactSettingsCapture.rendererMetrics.scrollMetrics[".settings-content-column"].clientHeight
  );
  process.stdout.write(`${JSON.stringify(report)}\n`);
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

app.on("window-all-closed", () => app.quit());
