const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isDesktopPermissionAllowed,
  isTrustedDesktopRendererUrl
} = require("../electron/permission-policy.cjs");

test("packaged permissions are limited to SovChat's secure custom origin", () => {
  assert.equal(isTrustedDesktopRendererUrl("app://desktop/desktop", true), true);
  assert.equal(isTrustedDesktopRendererUrl("https://sovchat.com/desktop", true), false);
  assert.equal(isTrustedDesktopRendererUrl("https://example.com", true), false);
});

test("development permissions allow loopback without trusting remote pages", () => {
  assert.equal(isTrustedDesktopRendererUrl("http://127.0.0.1:3001/desktop", false), true);
  assert.equal(isTrustedDesktopRendererUrl("http://localhost:3001/desktop", false), true);
  assert.equal(isTrustedDesktopRendererUrl("https://example.com", false), false);
});

test("microphone and speaker access are allowed while camera access is denied", () => {
  const base = {
    requestingUrl: "app://desktop/desktop",
    packaged: true
  };

  assert.equal(
    isDesktopPermissionAllowed({
      ...base,
      permission: "media",
      details: { mediaTypes: ["audio"] }
    }),
    true
  );
  assert.equal(
    isDesktopPermissionAllowed({
      ...base,
      permission: "media",
      details: { mediaTypes: ["audio", "video"] }
    }),
    false
  );
  assert.equal(
    isDesktopPermissionAllowed({ ...base, permission: "speaker-selection" }),
    true
  );
});

test("unneeded privileged APIs are denied", () => {
  assert.equal(
    isDesktopPermissionAllowed({
      requestingUrl: "app://desktop/desktop",
      packaged: true,
      permission: "geolocation"
    }),
    false
  );
});
