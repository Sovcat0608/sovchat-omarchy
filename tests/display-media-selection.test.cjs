const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  createDisplayMediaSelectionController,
  supportsDisplayMediaSystemAudio
} = require("../electron/display-media-selection.cjs");

function pipeWireSource(id = "window:42:0") {
  return {
    id,
    name: "Screen 1",
    display_id: "",
    thumbnail: {},
    appIcon: null
  };
}

test("the PipeWire picker source is granted without a second enumeration", async () => {
  const source = pipeWireSource();
  const calls = [];
  const controller = createDisplayMediaSelectionController({
    getSources: async (options) => {
      calls.push(options);
      return [source];
    },
    platform: "linux"
  });

  const listed = await controller.list({ types: ["screen", "window"] });
  assert.strictEqual(listed[0], source);
  assert.equal(
    controller.prepare({
      id: source.id,
      // PipeWire reports a combined screen/window portal choice as a window.
      // The renderer's classification must not trigger another filtered lookup.
      kind: "screen",
      includeSystemAudio: true
    }),
    true
  );

  const grant = controller.consumeGrant();
  assert.strictEqual(grant?.video, source);
  assert.equal("audio" in grant, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].types, ["screen", "window"]);
  assert.equal(controller.consumeGrant(), null);
});

test("unknown and stale selections cannot grant a cached source", async () => {
  let now = 1_000;
  const source = pipeWireSource();
  const controller = createDisplayMediaSelectionController({
    getSources: async () => [source],
    now: () => now,
    platform: "linux",
    ttlMs: 15_000
  });

  await controller.list({ types: ["screen", "window"] });
  assert.equal(controller.prepare({ id: source.id }), true);
  assert.equal(controller.prepare({ id: "window:missing:0" }), false);
  assert.equal(controller.consumeGrant(), null);

  await controller.list({ types: ["screen", "window"] });
  assert.equal(controller.prepare({ id: source.id }), true);
  now += 15_001;
  assert.equal(controller.consumeGrant(), null);
});

test("a failed refresh clears previously cached and pending sources", async () => {
  const source = pipeWireSource();
  let shouldFail = false;
  const controller = createDisplayMediaSelectionController({
    getSources: async () => {
      if (shouldFail) {
        throw new Error("portal cancelled");
      }
      return [source];
    },
    platform: "linux"
  });

  await controller.list({ types: ["screen", "window"] });
  assert.equal(controller.prepare({ id: source.id }), true);
  shouldFail = true;
  await assert.rejects(controller.list({ types: ["screen", "window"] }), /portal cancelled/u);
  assert.equal(controller.consumeGrant(), null);
  assert.equal(controller.prepare({ id: source.id }), false);
});

test("clearing while the portal is open invalidates its eventual result", async () => {
  const source = pipeWireSource();
  let resolveSources;
  const sourcesPromise = new Promise((resolve) => {
    resolveSources = resolve;
  });
  const controller = createDisplayMediaSelectionController({
    getSources: () => sourcesPromise,
    platform: "linux"
  });

  const listing = controller.list({ types: ["screen", "window"] });
  controller.clear();
  resolveSources([source]);
  assert.deepEqual(await listing, []);

  assert.equal(controller.prepare({ id: source.id }), false);
  assert.equal(controller.consumeGrant(), null);
});

test("an older portal result cannot replace a newer cached source", async () => {
  const olderSource = pipeWireSource("window:older:0");
  const newerSource = pipeWireSource("window:newer:0");
  const pendingListings = [];
  const controller = createDisplayMediaSelectionController({
    getSources: () => new Promise((resolve) => pendingListings.push(resolve)),
    platform: "linux"
  });

  const olderListing = controller.list({ types: ["screen", "window"] });
  const newerListing = controller.list({ types: ["screen", "window"] });
  pendingListings[1]([newerSource]);
  assert.deepEqual(await newerListing, [newerSource]);
  pendingListings[0]([olderSource]);
  assert.deepEqual(await olderListing, []);

  assert.equal(controller.prepare({ id: olderSource.id }), false);
  assert.equal(controller.prepare({ id: newerSource.id }), true);
  assert.strictEqual(controller.consumeGrant()?.video, newerSource);
});

test("the prepared-source TTL starts when the user chooses a cached source", async () => {
  let now = 1_000;
  const source = pipeWireSource();
  const controller = createDisplayMediaSelectionController({
    getSources: async () => [source],
    now: () => now,
    platform: "linux",
    ttlMs: 15_000
  });

  await controller.list({ types: ["screen", "window"] });
  now += 60_000;
  assert.equal(controller.prepare({ id: source.id }), true);
  now += 15_000;
  assert.strictEqual(controller.consumeGrant()?.video, source);
});

test("loopback audio is granted only on Windows", async () => {
  assert.equal(supportsDisplayMediaSystemAudio("linux"), false);
  assert.equal(supportsDisplayMediaSystemAudio("win32"), true);

  const source = pipeWireSource();
  const windowsController = createDisplayMediaSelectionController({
    getSources: async () => [source],
    platform: "win32"
  });
  await windowsController.list({ types: ["screen", "window"] });
  windowsController.prepare({ id: source.id, includeSystemAudio: true });
  assert.equal(windowsController.consumeGrant()?.audio, "loopback");

  await windowsController.list({ types: ["screen", "window"] });
  windowsController.prepare({ id: source.id, includeSystemAudio: false });
  assert.equal("audio" in windowsController.consumeGrant(), false);
});

test("the Electron display handler does not enumerate sources after preparation", () => {
  const mainSource = readFileSync(path.resolve(__dirname, "../electron/main.cjs"), "utf8");
  const handlerStart = mainSource.indexOf("session.defaultSession.setDisplayMediaRequestHandler(");
  const handlerEnd = mainSource.indexOf("function sendWindowState", handlerStart);
  assert.notEqual(handlerStart, -1);
  assert.notEqual(handlerEnd, -1);

  const handlerSource = mainSource.slice(handlerStart, handlerEnd);
  assert.match(handlerSource, /displayMediaSelectionController\.consumeGrant\(\)/u);
  assert.doesNotMatch(
    handlerSource,
    /desktopCapturer\.getSources|listDisplayMediaSources\s*\(|displayMediaSelectionController\.list\s*\(/u
  );
});

test("production wiring shares one controller and disables Omarchy loopback audio", () => {
  const mainSource = readFileSync(path.resolve(__dirname, "../electron/main.cjs"), "utf8");
  const preloadSource = readFileSync(path.resolve(__dirname, "../electron/preload.cjs"), "utf8");
  const rendererSource = readFileSync(path.resolve(__dirname, "../components/voice-room.tsx"), "utf8");

  assert.match(
    mainSource,
    /const displayMediaSelectionController = createDisplayMediaSelectionController\(\{[\s\S]{0,240}getSources: \(options\) => desktopCapturer\.getSources\(options\),[\s\S]{0,80}platform: process\.platform/u
  );
  assert.match(
    mainSource,
    /async function listDisplayMediaSources\(\)[\s\S]{0,160}displayMediaSelectionController\.list\(/u
  );
  assert.match(
    mainSource,
    /ipcMain\.handle\("desktop:prepare-screen-share-source"[\s\S]{0,600}displayMediaSelectionController\.prepare\(selection\)/u
  );
  assert.match(
    mainSource,
    /ipcMain\.handle\("desktop:clear-screen-share-source"[\s\S]{0,160}displayMediaSelectionController\.clear\(\)/u
  );
  assert.match(preloadSource, /supportsSystemAudioCapture: process\.platform === "win32"/u);
  assert.match(
    rendererSource,
    /const screenShareSystemAudioSupported =\s*!isDesktopShell \|\| desktopBridge\?\.supportsSystemAudioCapture === true/u
  );
  assert.match(
    rendererSource,
    /const shouldCaptureSystemAudio = screenShareSystemAudioSupported && includeSystemAudio/u
  );
  assert.match(rendererSource, /systemAudioSupported=\{screenShareSystemAudioSupported\}/u);
});
