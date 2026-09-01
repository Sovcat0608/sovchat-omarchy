const assert = require("node:assert/strict");
const test = require("node:test");

const { resolveLinuxDisplayBackend } = require("../electron/linux-display-policy.cjs");

test("Linux defaults to Xwayland for reliable compact window resizing", () => {
  assert.equal(
    resolveLinuxDisplayBackend({ platform: "linux", requested: "", hasExplicitSwitch: false }),
    "x11"
  );
});

test("a deliberate display backend override is respected", () => {
  assert.equal(
    resolveLinuxDisplayBackend({
      platform: "linux",
      requested: "wayland",
      hasExplicitSwitch: false
    }),
    "wayland"
  );
  assert.equal(
    resolveLinuxDisplayBackend({ platform: "linux", requested: "auto", hasExplicitSwitch: false }),
    null
  );
  assert.equal(
    resolveLinuxDisplayBackend({
      platform: "linux",
      requested: "x11",
      hasExplicitSwitch: true
    }),
    null
  );
});

test("non-Linux systems do not receive a Linux display switch", () => {
  assert.equal(
    resolveLinuxDisplayBackend({ platform: "darwin", requested: "", hasExplicitSwitch: false }),
    null
  );
});
