import QtQuick
import QtQuick.Layouts
import qs.Commons
import qs.Ui

Panel {
  id: root
  moduleName: "com.sovchat.omarchy"
  ipcTarget: "com.sovchat.omarchy"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  readonly property color foreground: Color.popups.text
  readonly property color muted: Color.muted
  readonly property color accent: Color.accent
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property bool installed: hostWidget ? hostWidget.clientInstalled : false
  readonly property bool running: hostWidget ? hostWidget.clientRunning : false
  readonly property bool probed: hostWidget ? hostWidget.probed : false
  readonly property bool busy: hostWidget ? hostWidget.busy : false
  readonly property bool actionsReady: hostWidget ? hostWidget.statusReady : false
  readonly property string versionText: hostWidget ? hostWidget.clientVersion : ""
  readonly property string clientPath: hostWidget ? hostWidget.clientPath : ""
  readonly property bool migrationRequired: hostWidget ? hostWidget.migrationRequired : false
  readonly property string legacyVersionText: hostWidget ? hostWidget.legacyClientVersion : ""
  readonly property string displayClientPath: clientPath !== "" ? clientPath : (migrationRequired && hostWidget ? hostWidget.legacyClientPath : "")
  readonly property string errorText: hostWidget
    ? (hostWidget.actionError || hostWidget.lastError)
    : ""
  readonly property string stateText: errorText !== ""
    ? "CHECK FAILED"
    : (!probed
      ? "CHECKING"
      : (running ? "RUNNING" : (installed ? "READY" : (migrationRequired ? "STANDALONE FOUND" : "CLIENT NOT FOUND"))))
  readonly property color stateColor: errorText !== ""
    ? urgent
    : (migrationRequired ? urgent : (running ? accent : (installed ? foreground : muted)))

  function launch() {
    if (hostWidget) hostWidget.launchClient()
  }

  function openWeb() {
    if (hostWidget) hostWidget.openWebApp()
  }

  function install() {
    if (hostWidget) hostWidget.installOrUpdate()
  }

  function refresh() {
    if (hostWidget) hostWidget.refreshEveryInstance()
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.hostWidget || root, direction)
    return false
  }

  onOpenedChanged: if (opened) {
    refresh()
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.hostWidget || root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(content.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onActivateRequested: root.launch()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(text) {
        if (text === "r" || text === "R") root.refresh()
        else if (text === "w" || text === "W") root.openWeb()
        else if (text === "i" || text === "I") root.install()
      }

      Column {
        id: content
        width: parent.width
        spacing: Style.spacing.panelGap

        RowLayout {
          width: parent.width
          spacing: Style.space(12)

          Image {
            Layout.preferredWidth: Style.space(40)
            Layout.preferredHeight: Style.space(40)
            source: Qt.resolvedUrl("sovchat.svg")
            sourceSize.width: width
            sourceSize.height: height
            fillMode: Image.PreserveAspectFit
            smooth: false
          }

          ColumnLayout {
            Layout.fillWidth: true
            spacing: Style.space(2)
            Text {
              Layout.fillWidth: true
              text: "SovChat"
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.heading
              font.bold: true
              elide: Text.ElideRight
            }
            Text {
              Layout.fillWidth: true
              text: root.running
                ? "Your private room is one click away"
                : "Voice, chat, and screen sharing"
              color: root.muted
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              elide: Text.ElideRight
            }
          }

          Row {
            Layout.alignment: Qt.AlignVCenter
            spacing: Style.space(6)
            Rectangle {
              anchors.verticalCenter: parent.verticalCenter
              width: Style.space(7)
              height: width
              radius: width / 2
              color: root.stateColor
            }
            Text {
              text: root.stateText
              color: root.stateColor
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
            }
          }
        }

        PanelSeparator {
          foreground: root.foreground
        }

        Column {
          width: parent.width
          spacing: Style.space(4)
          Text {
            width: parent.width
            text: root.errorText !== ""
              ? root.errorText
              : (root.migrationRequired
                ? "This client uses the standalone Linux update channel and cannot receive the Omarchy release. Install the Omarchy edition alongside it. The existing AppImage will not be opened, changed, or removed."
                : (root.running
                  ? "The desktop client is active on this session."
                  : (root.installed
                    ? "The desktop client is installed and ready to open."
                    : "Install the latest Omarchy client or continue in the web app.")))
            color: root.errorText !== "" ? root.urgent : root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            wrapMode: Text.Wrap
          }
          Text {
            visible: root.displayClientPath !== ""
            width: parent.width
            text: root.displayClientPath
            textFormat: Text.PlainText
            color: root.muted
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideMiddle
          }
        }

        RowLayout {
          width: parent.width
          spacing: Style.spacing.controlGap
          Button {
            Layout.fillWidth: true
            text: root.running
              ? "FOCUS CLIENT"
              : (root.installed ? "OPEN CLIENT" : (root.migrationRequired ? "INSTALL OMARCHY EDITION" : "INSTALL CLIENT"))
            bordered: true
            active: root.installed || root.running || root.migrationRequired
            foreground: root.foreground
            background: "transparent"
            accent: root.accent
            fontFamily: root.fontFamily
            fontSize: Style.font.body
            enabled: !root.busy && root.actionsReady
            opacity: enabled ? 1.0 : 0.5
            onClicked: root.launch()
          }
          Button {
            Layout.fillWidth: true
            text: "OPEN WEB APP"
            bordered: true
            foreground: root.foreground
            background: "transparent"
            accent: root.accent
            fontFamily: root.fontFamily
            fontSize: Style.font.body
            onClicked: root.openWeb()
          }
        }

        RowLayout {
          width: parent.width
          spacing: Style.spacing.controlGap
          Button {
            Layout.fillWidth: true
            text: root.migrationRequired ? "NOT NOW" : (root.installed ? "INSTALL / UPDATE" : "RETRY INSTALL")
            foreground: root.muted
            background: "transparent"
            accent: root.accent
            fontFamily: root.fontFamily
            fontSize: Style.font.bodySmall
            enabled: !root.busy && root.actionsReady
            opacity: enabled ? 1.0 : 0.5
            onClicked: root.migrationRequired ? root.close() : root.install()
          }
          Button {
            text: root.busy ? "CHECKING" : "REFRESH"
            foreground: root.muted
            background: "transparent"
            accent: root.accent
            fontFamily: root.fontFamily
            fontSize: Style.font.bodySmall
            enabled: !root.busy
            opacity: enabled ? 1.0 : 0.5
            onClicked: root.refresh()
          }
        }

        PanelSeparator {
          foreground: root.foreground
        }

        RowLayout {
          width: parent.width
          Text {
            Layout.fillWidth: true
            text: root.versionText !== ""
              ? "CLIENT " + root.versionText
              : (root.migrationRequired && root.legacyVersionText !== "" ? "LEGACY CLIENT " + root.legacyVersionText : "CLIENT VERSION UNKNOWN")
            color: root.muted
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }
          Text {
            text: "PLUGIN 0.1.4"
            color: root.muted
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }
      }
    }
  }
}
