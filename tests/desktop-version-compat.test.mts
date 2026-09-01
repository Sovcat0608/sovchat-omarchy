import assert from "node:assert/strict";
import test from "node:test";

import {
  getDesktopCompatibilityVersion,
  isDesktopVersionFamilyAllowed,
  isDesktopVersionSupported,
  parseDesktopVersionFamily
} from "../lib/desktop-version-compat.ts";

test("prerelease desktop builds send a header accepted by the legacy middleware", () => {
  const headerVersion = getDesktopCompatibilityVersion("0.3.52-preview.1");

  assert.equal(headerVersion, "0.3.52");
  assert.match(headerVersion, /^v?\d+\.\d+(?:\.\d+)?$/u);
});

test("normalization strips prerelease and build metadata without changing the version core", () => {
  assert.equal(
    getDesktopCompatibilityVersion("v0.3.52-rc.2+build.20260813"),
    "0.3.52"
  );
  assert.equal(getDesktopCompatibilityVersion("0.3+commit.abc123"), "0.3");
});

test("the server family parser accepts stable, prerelease, and build versions", () => {
  assert.deepEqual(parseDesktopVersionFamily("0.3"), { major: 0, minor: 3, label: "0.3" });
  assert.deepEqual(parseDesktopVersionFamily("0.3.52-preview.1"), {
    major: 0,
    minor: 3,
    label: "0.3"
  });
  assert.deepEqual(parseDesktopVersionFamily("v1.4.0+sha.abc123"), {
    major: 1,
    minor: 4,
    label: "1.4"
  });
});

test("compatibility policy compares major and minor families after parsing suffixes", () => {
  const minimumFamily = parseDesktopVersionFamily("0.3");

  assert.equal(isDesktopVersionSupported("0.3.52-preview.1", minimumFamily), true);
  assert.equal(isDesktopVersionSupported("0.2.99+legacy", minimumFamily), false);
  assert.equal(isDesktopVersionSupported("1.0.0-alpha.1", minimumFamily), true);
});

test("malformed versions remain fail-closed when a minimum family is configured", () => {
  const minimumFamily = parseDesktopVersionFamily("0.3");

  assert.equal(parseDesktopVersionFamily("0.3.52/unknown"), null);
  assert.equal(isDesktopVersionSupported("not-a-version", minimumFamily), false);
  assert.equal(getDesktopCompatibilityVersion(" not-a-version "), "not-a-version");
});

test("an exact family gate accepts only the configured major and minor family", () => {
  const requiredFamily = parseDesktopVersionFamily("0.4");

  assert.equal(isDesktopVersionFamilyAllowed("0.4.0-rc.1", requiredFamily), true);
  assert.equal(isDesktopVersionFamilyAllowed("0.4.99", requiredFamily), true);
  assert.equal(isDesktopVersionFamilyAllowed("0.3.99", requiredFamily), false);
  assert.equal(isDesktopVersionFamilyAllowed("0.5.0", requiredFamily), false);
  assert.equal(isDesktopVersionFamilyAllowed("1.0.0", requiredFamily), false);
  assert.equal(isDesktopVersionFamilyAllowed("invalid", requiredFamily), false);
});
