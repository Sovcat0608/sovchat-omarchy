import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "com.sovchat.omarchy"

  readonly property string pluginDir: {
    var override = Quickshell.env("SOVCHAT_OMARCHY_PLUGIN_DIR")
    return override && override.length > 0
      ? override
      : Quickshell.env("HOME") + "/.config/omarchy/plugins/" + moduleName
  }
  readonly property string helperPath: pluginDir + "/bin/sovchat-control"
  readonly property string executableOverride: String(setting("executable", "") || "").trim()
  readonly property int pollIntervalSec: {
    var value = parseInt(String(setting("pollIntervalSec", 5)), 10)
    return Math.max(2, Math.min(60, isFinite(value) ? value : 5))
  }

  property bool probed: false
  property bool probing: false
  property bool clientInstalled: false
  property bool clientRunning: false
  property string clientVersion: ""
  property string clientPath: ""
  property bool legacyClientInstalled: false
  property string legacyClientVersion: ""
  property string legacyClientPath: ""
  property string lastError: ""
  property string actionError: ""
  property string _probeOutput: ""
  property string _probeError: ""
  property string _actionError: ""

  readonly property bool migrationRequired: legacyClientInstalled && !clientInstalled && !clientRunning
  readonly property bool statusReady: probed && !probing && lastError === ""
  readonly property string statusLabel: lastError !== ""
    ? "CHECK FAILED"
    : (clientRunning ? "RUNNING" : (clientInstalled ? "READY" : (migrationRequired ? "STANDALONE FOUND" : "NOT INSTALLED")))
  readonly property string tooltipText: probing
    ? "Checking SovChat"
    : (lastError !== ""
      ? lastError
      : (clientRunning
        ? "SovChat is running"
        : (clientInstalled
          ? "SovChat is ready"
          : (migrationRequired ? "Install the Omarchy edition alongside standalone SovChat" : "SovChat client not found"))))
  readonly property bool busy: probing || actionProcess.running

  function refresh() {
    if (probeProcess.running) return
    probing = true
    _probeOutput = ""
    _probeError = ""
    probeProcess.command = ["bash", helperPath, "status-v2", executableOverride]
    probeProcess.running = true
  }

  function clearClientState() {
    clientInstalled = false
    clientRunning = false
    clientVersion = ""
    clientPath = ""
    legacyClientInstalled = false
    legacyClientVersion = ""
    legacyClientPath = ""
  }

  function finishProbe(exitCode, stdout, stderr) {
    probing = false
    probed = true
    if (exitCode !== 0) {
      clearClientState()
      lastError = exitCode === 2
        ? "The SovChat plugin update is incomplete. Refresh after Omarchy finishes updating the plugin."
        : conciseError(stderr || stdout, "Could not check the SovChat client")
      return
    }

    var lines = String(stdout || "").replace(/[\r\n]+$/, "").split("\n")
    var fields = lines.length > 0 ? lines[lines.length - 1].split("\t") : []
    var responseValid = fields.length === 7
      && (fields[0] === "0" || fields[0] === "1")
      && (fields[1] === "0" || fields[1] === "1")
      && (fields[4] === "0" || fields[4] === "1")
      && ((fields[0] === "1") === (fields[3] !== ""))
      && ((fields[4] === "1") === (fields[6] !== ""))
    if (!responseValid) {
      clearClientState()
      lastError = "The SovChat plugin update is incomplete. Refresh after Omarchy finishes updating the plugin."
      return
    }

    clientInstalled = fields[0] === "1"
    clientRunning = fields[1] === "1"
    clientVersion = fields[2]
    clientPath = fields[3]
    legacyClientInstalled = fields[4] === "1"
    legacyClientVersion = fields[5]
    legacyClientPath = fields[6]
    lastError = ""
  }

  function conciseError(value, fallback) {
    var text = String(value || fallback || "SovChat action failed").replace(/\s+/g, " ").trim()
    return text.length > 180 ? text.substring(0, 177) + "..." : text
  }

  function launchClient() {
    if (actionProcess.running) return
    if (!statusReady) {
      refresh()
      open()
      return
    }
    if (!clientInstalled && !clientRunning) {
      installOrUpdate()
      return
    }
    actionError = ""
    _actionError = ""
    actionProcess.command = ["bash", helperPath, "launch", executableOverride]
    actionProcess.running = true
  }

  function openWebApp() {
    if (!bar) return
    bar.run("omarchy-launch-or-focus-webapp "
      + Util.shellQuote("SovChat") + " "
      + Util.shellQuote("https://sovchat.com/app"))
    close()
  }

  function installOrUpdate() {
    if (!bar || actionProcess.running) return
    if (!statusReady) {
      refresh()
      open()
      return
    }
    var installCommand = "bash " + Util.shellQuote(helperPath) + " install"
      + "; result=$?; printf '\\n'"
      + "; if [ \"$result\" -eq 0 ]; then printf 'SovChat is ready.\\n'"
      + "; else printf 'Install failed (exit %s).\\n' \"$result\"; fi"
      + "; printf '\\nPress Enter to close...'; read -r _; exit \"$result\""
    bar.run("omarchy-launch-floating-terminal-with-presentation " + Util.shellQuote(installCommand))
    close()
  }

  function open() {
    if (panelLoader.item) panelLoader.item.open()
  }

  function close() {
    if (panelLoader.item) panelLoader.item.close()
  }

  function toggle() {
    if (panelLoader.item) panelLoader.item.toggle()
  }

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    target.bar = root.bar
    target.settings = root.settings
    target.anchorItem = button
    target.hostWidget = root
  }

  function refreshEveryInstance() {
    broadcast("refresh")
  }

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool popoutSwitchClosing: panelLoader.item
    ? panelLoader.item.popoutSwitchClosing === true
    : false
  readonly property real openPanelIndicatorWidth: Style.bar.iconCanvas
  readonly property real openPanelIndicatorHeight: Math.max(Style.space(10), Math.round(Style.bar.iconSlot * 0.55))

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  Timer {
    interval: root.pollIntervalSec * 1000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Timer {
    id: postLaunchRefresh
    interval: 900
    repeat: false
    onTriggered: root.refreshEveryInstance()
  }

  Process {
    id: probeProcess
    running: false
    command: []
    stdout: StdioCollector {
      id: probeStdout
      waitForEnd: true
      onStreamFinished: root._probeOutput = text
    }
    stderr: StdioCollector {
      id: probeStderr
      waitForEnd: true
      onStreamFinished: root._probeError = text
    }
    onExited: function(exitCode) {
      root.finishProbe(
        exitCode,
        String(probeStdout.text || root._probeOutput || ""),
        String(probeStderr.text || root._probeError || ""))
    }
  }

  Process {
    id: actionProcess
    running: false
    command: []
    stderr: StdioCollector {
      id: actionStderr
      waitForEnd: true
      onStreamFinished: root._actionError = text
    }
    onExited: function(exitCode) {
      if (exitCode !== 0)
        root.actionError = root.conciseError(actionStderr.text || root._actionError, "Could not open SovChat")
      else
        root.close()
      postLaunchRefresh.restart()
    }
  }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  IpcHandler {
    target: root.moduleName
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
    function refresh(): void { root.refreshEveryInstance() }
    function launch(): string { root.launchClient(); return "ok" }
    function web(): string { root.openWebApp(); return "ok" }
    function status(): string {
      return JSON.stringify({
        installed: root.clientInstalled,
        running: root.clientRunning,
        version: root.clientVersion,
        path: root.clientPath,
        migrationRequired: root.migrationRequired,
        legacyInstalled: root.legacyClientInstalled,
        legacyVersion: root.legacyClientVersion,
        legacyPath: root.legacyClientPath,
        error: root.lastError || root.actionError
      })
    }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    active: root.clientRunning
    tooltipText: root.tooltipText
    iconComponent: Component {
      Item {
        Image {
          anchors.fill: parent
          source: Qt.resolvedUrl("sovchat.svg")
          sourceSize.width: width
          sourceSize.height: height
          fillMode: Image.PreserveAspectFit
          opacity: root.clientInstalled || root.clientRunning ? 1.0 : 0.48
          smooth: false
        }
        Rectangle {
          anchors.right: parent.right
          anchors.bottom: parent.bottom
          width: Style.space(5)
          height: width
          radius: width / 2
          color: root.clientRunning
            ? Color.accent
            : (root.clientInstalled ? Color.muted : Color.urgent)
          border.width: Style.spacing.hairline
          border.color: Color.popups.background
        }
      }
    }
    onPressed: function(buttonCode) {
      if (buttonCode === Qt.RightButton) root.launchClient()
      else if (buttonCode === Qt.MiddleButton) root.openWebApp()
      else root.toggle()
    }
  }
}
