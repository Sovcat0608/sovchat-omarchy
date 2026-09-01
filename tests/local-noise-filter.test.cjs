const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const rootDir = path.resolve(__dirname, "..");
const noiseSuppressorRoot = path.resolve(
  path.dirname(require.resolve("@sapphi-red/web-noise-suppressor", { paths: [rootDir] })),
  ".."
);

function read(relativePath) {
  return readFileSync(path.join(rootDir, ...relativePath.split("/")));
}

test("the voice room uses the local RNNoise processor instead of LiveKit Cloud Krisp", () => {
  const voiceRoom = read("components/voice-room.tsx").toString("utf8");
  const processor = read("lib/audio/local-noise-filter.ts").toString("utf8");

  assert.match(voiceRoom, /import\("@\/lib\/audio\/local-noise-filter"\)/u);
  assert.doesNotMatch(voiceRoom, /import\("@livekit\/krisp-noise-filter"\)/u);
  assert.match(processor, /@sapphi-red\/web-noise-suppressor/u);
  assert.match(processor, /sovchat-local-rnnoise-filter/u);
});

test("packaged RNNoise assets exactly match the installed MIT dependency", () => {
  const assetPairs = [
    [
      "public/audio-worklets/sovchat-rnnoise-processor.js",
      path.join(noiseSuppressorRoot, "dist/rnnoise/workletProcessor.js")
    ],
    [
      "public/audio-models/rnnoise.wasm",
      path.join(noiseSuppressorRoot, "dist/rnnoise.wasm")
    ],
    [
      "public/audio-models/rnnoise_simd.wasm",
      path.join(noiseSuppressorRoot, "dist/rnnoise_simd.wasm")
    ]
  ];

  for (const [packagedPath, dependencyPath] of assetPairs) {
    assert.deepEqual(read(packagedPath), readFileSync(dependencyPath), packagedPath);
  }

  assert.equal(read("public/audio-models/rnnoise.wasm").subarray(0, 4).toString("hex"), "0061736d");
  assert.equal(
    read("public/audio-models/rnnoise_simd.wasm").subarray(0, 4).toString("hex"),
    "0061736d"
  );
});
