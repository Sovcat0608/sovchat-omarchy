import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  canToggleCompactLayout,
  MOBILE_COMPACT_MEDIA_QUERY,
  resolveCompactLayout
} from "../lib/app-layout-policy.ts";
import { APP_THEMES } from "../lib/theme-store.ts";

test("mobile web defaults to compact while desktop follows its persisted window state", () => {
  assert.equal(MOBILE_COMPACT_MEDIA_QUERY, "(max-width: 767px)");
  assert.equal(
    resolveCompactLayout({ isDesktop: false, desktopCompact: false, mobileViewport: true }),
    true
  );
  assert.equal(
    resolveCompactLayout({ isDesktop: false, desktopCompact: true, mobileViewport: false }),
    false
  );
  assert.equal(
    resolveCompactLayout({ isDesktop: true, desktopCompact: true, mobileViewport: false }),
    true
  );
  assert.equal(canToggleCompactLayout(false), false);
  assert.equal(canToggleCompactLayout(true), true);
});

test("Electron exposes a fixed compact-window path and preserves expanded bounds", async () => {
  const [mainSource, preloadSource, frameSource, globalStyles] = await Promise.all([
    readFile(new URL("../electron/main.cjs", import.meta.url), "utf8"),
    readFile(new URL("../electron/preload.cjs", import.meta.url), "utf8"),
    readFile(new URL("../components/desktop-frame.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8")
  ]);

  assert.match(mainSource, /desktop:window-set-compact/u);
  assert.match(mainSource, /mainWindowExpandedBounds/u);
  assert.match(mainSource, /DESKTOP_COMPACT_WIDTH = 352/u);
  assert.match(mainSource, /setResizable\(false\)/u);
  assert.match(mainSource, /setMaximizable\(false\)/u);
  assert.match(mainSource, /setFullScreenable\(false\)/u);
  assert.match(mainSource, /scheduleLinuxWindowRepaint\(targetWindow\)/u);
  assert.match(mainSource, /targetWindow\.webContents\.invalidate\(\)/u);
  assert.match(preloadSource, /setCompactWindow/u);
  assert.match(frameSource, /desktop-titlebar__layout-button/u);
  assert.match(globalStyles, /\.compact-primary-dock[\s\S]*border-top:/u);
  assert.doesNotMatch(globalStyles, /\.ui-tooltip:focus-within/u);
  assert.match(globalStyles, /\.ui-tooltip:has\(:focus-visible\)/u);
});

test("dock surfaces are remeasured and remounted across compact transitions", async () => {
  const appShellSource = await readFile(
    new URL("../components/app-shell.tsx", import.meta.url),
    "utf8"
  );

  assert.match(appShellSource, /useLayoutEffect\(\(\) => \{/u);
  assert.match(appShellSource, /\[displayName, isCompactLayout, isDockVisible\]/u);
  assert.match(appShellSource, /primary-dock-compact/u);
  assert.match(appShellSource, /primary-dock-expanded/u);
  assert.match(appShellSource, /requestAnimationFrame\(updateDockWidth\)/u);
  assert.match(appShellSource, /element\.offsetWidth \|\| element\.getBoundingClientRect\(\)\.width/u);
});

test("compact stream selection bypasses the in-stage viewer", async () => {
  const voiceRoomSource = await readFile(
    new URL("../components/voice-room.tsx", import.meta.url),
    "utf8"
  );

  assert.match(voiceRoomSource, /if \(compactMode\)/u);
  assert.match(voiceRoomSource, /openStreamPopout/u);
  assert.match(voiceRoomSource, /new URL\("\/desktop-popout"/u);
  assert.match(voiceRoomSource, /!compactMode && showMainPanel/u);
});

test("compact participants expose the persisted per-user volume controller", async () => {
  const voiceRoomSource = await readFile(
    new URL("../components/voice-room.tsx", import.meta.url),
    "utf8"
  );

  assert.match(voiceRoomSource, /compact-participant-volume-editor/u);
  assert.match(voiceRoomSource, /compact-participant-volume-slider/u);
  assert.match(voiceRoomSource, /onParticipantVolumeChange\(\s*volumeIdentity/u);
  assert.match(voiceRoomSource, /PARTICIPANT_VOLUME_SLIDER_MAX/u);
});

test("appearance settings provide six named two-colour themes and a transparent icon", async () => {
  const [settingsSource, iconSource] = await Promise.all([
    readFile(new URL("../components/settings-panel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../images/ico.svg", import.meta.url), "utf8")
  ]);
  const themeIds = new Set(APP_THEMES.map((theme) => theme.id));

  assert.equal(APP_THEMES.length, 6);
  assert.equal(themeIds.size, APP_THEMES.length);
  for (const theme of APP_THEMES) {
    assert.notEqual(theme.primary, theme.secondary);
  }
  assert.match(settingsSource, /id: "appearance", label: "Appearance"/u);
  assert.match(settingsSource, /themeStore\.setTheme\(theme\.id\)/u);
  assert.doesNotMatch(iconSource, /<rect/u);
});

test("the app exposes only the Omarchy interface", async () => {
  const [settingsSource, runtimeSource, globalStyles, voiceRoomSource, omarchyGlyphSource] = await Promise.all([
    readFile(new URL("../components/settings-panel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/theme-runtime.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../components/voice-room.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/omarchy-glyph.tsx", import.meta.url), "utf8")
  ]);

  assert.doesNotMatch(settingsSource, /Interface style|uiModeStore|APP_UI_MODES/u);
  assert.match(runtimeSource, /document\.body\.dataset\.uiMode = "omarchy"/u);
  assert.doesNotMatch(globalStyles, /data-ui-mode="linux"|windows-mode-icon/u);
  assert.match(globalStyles, /body \.desktop-titlebar/u);
  assert.match(globalStyles, /body \.voice-pill/u);
  assert.match(globalStyles, /body \.settings-panel-nav/u);
  assert.match(globalStyles, /body \.compact-primary-dock/u);
  assert.match(globalStyles, /body \.voice-krisp-corner/u);
  assert.match(globalStyles, /body \.compact-participant-lane/u);
  assert.match(globalStyles, /grid-template-columns: repeat\(3, 44px\)/u);
  assert.match(omarchyGlyphSource, /type OmarchyGlyphKind/u);
  assert.match(voiceRoomSource, /kind=\{props\.isSharing \? "share-off" : "share"\}/u);
  assert.doesNotMatch(voiceRoomSource, /windows-mode-icon/u);
  assert.match(globalStyles, /body \.settings-panel-layout-compact \.theme-picker-grid/u);
  assert.match(
    globalStyles,
    /body\[data-app-layout="compact"\] \.compact-primary-dock \.ui-tooltip__bubble/u
  );
});

test("Omarchy styling gives every user dock action its own square-stroke glyph", async () => {
  const [appShellSource, omarchyGlyphSource, globalStyles] = await Promise.all([
    readFile(new URL("../components/app-shell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/omarchy-glyph.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8")
  ]);

  for (const kind of ["chat", "microphone", "microphone-off", "headphones", "headphones-off", "settings"]) {
    assert.match(appShellSource, new RegExp(`kind=.*${kind}`, "u"));
  }
  assert.match(omarchyGlyphSource, /strokeLinecap:\s*"square"/u);
  assert.match(omarchyGlyphSource, /strokeLinejoin:\s*"miter"/u);
  assert.match(globalStyles, /body \.user-dock-action/u);
  assert.match(globalStyles, /\.user-dock-action-danger/u);
});

test("compact Go Live uses a dedicated source grid and anchored controls", async () => {
  const voiceRoomSource = await readFile(
    new URL("../components/voice-room.tsx", import.meta.url),
    "utf8"
  );

  assert.match(voiceRoomSource, /compactMode=\{compactMode\}/u);
  assert.match(voiceRoomSource, /if \(compactMode\) \{[\s\S]*compact-share-picker/u);
  assert.match(voiceRoomSource, /sourceTabs\.filter\(\(tab\) => tab\.id !== "device"\)/u);
  assert.match(voiceRoomSource, /compact-share-source-list min-h-0 flex-1/u);
  assert.match(voiceRoomSource, /compact-share-footer shrink-0/u);
});

test("compact chat keeps the empty composer on one line and uses compact sizing", async () => {
  const [chatViewSource, globalStyles] = await Promise.all([
    readFile(new URL("../components/chat-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8")
  ]);

  assert.match(chatViewSource, /const minimumHeight = compact \? 44 : 56/u);
  assert.match(chatViewSource, /textarea\.value\.length === 0/u);
  assert.match(chatViewSource, /!draft && "chat-composer-empty"/u);
  assert.match(chatViewSource, /window\.addEventListener\("resize", handleWindowResize\)/u);
  assert.doesNotMatch(chatViewSource, /resizeObserver\.observe\(textarea\)/u);
  assert.match(globalStyles, /\.chat-composer-empty[\s\S]*white-space: nowrap/u);
  assert.match(globalStyles, /\.chat-composer-action-slot,[\s\S]*width: 28px/u);
});

test("settings slider labels stay inside narrow compact panels", async () => {
  const settingsSource = await readFile(
    new URL("../components/settings-panel.tsx", import.meta.url),
    "utf8"
  );

  assert.match(settingsSource, /left: `clamp\(24px,[\s\S]*calc\(100% - 24px\)\)`/u);
});
