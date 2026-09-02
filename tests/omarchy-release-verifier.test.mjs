import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveOmarchyRelease } from "../scripts/verify-omarchy-release.mjs";

function digest(buffer, encoding) {
  return createHash("sha512").update(buffer).digest(encoding);
}

function createFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "sovchat-release-verifier-"));
  const releaseDir = path.join(root, "release");
  const packagePath = path.join(root, "package.json");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(packagePath, JSON.stringify({ version: "1.2.3" }));
  mkdirSync(releaseDir);

  const appName = "SovChat-Omarchy-1.2.3-x86_64.AppImage";
  const archiveName = "SovChat Omarchy-1.2.3.tar.gz";
  const appImage = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(appImage);
  appImage.writeUInt16LE(62, 18);
  const archive = Buffer.from([0x1f, 0x8b, 0x08, 0x00]);
  const manifest = Buffer.from([
    "version: 1.2.3",
    "files:",
    `  - url: ${appName}`,
    `    sha512: ${digest(appImage, "base64")}`,
    `    size: ${appImage.length}`,
    `path: ${appName}`,
    `sha512: ${digest(appImage, "base64")}`,
    ""
  ].join("\n"));

  writeFileSync(path.join(releaseDir, appName), appImage);
  writeFileSync(path.join(releaseDir, archiveName), archive);
  writeFileSync(path.join(releaseDir, "latest-linux.yml"), manifest);
  writeFileSync(path.join(releaseDir, "SHA512SUMS"), [
    `${digest(appImage, "hex")}  ${appName}`,
    `${digest(archive, "hex")}  ${archiveName}`,
    `${digest(manifest, "hex")}  latest-linux.yml`,
    ""
  ].join("\n"));

  return { appName, packagePath, releaseDir };
}

test("release verifier accepts a coherent x86-64 AppImage release set", (t) => {
  const fixture = createFixture(t);
  const release = resolveOmarchyRelease(fixture);
  assert.equal(release.version, "1.2.3");
  assert.equal(release.appImage.name, fixture.appName);
  assert.equal(release.checksums.name, "SHA512SUMS");
});

test("release verifier rejects a non-ELF AppImage", (t) => {
  const fixture = createFixture(t);
  const appPath = path.join(fixture.releaseDir, fixture.appName);
  const bytes = readFileSync(appPath);
  bytes[0] = 0;
  writeFileSync(appPath, bytes);
  assert.throws(() => resolveOmarchyRelease(fixture), /x86-64 ELF/u);
});

test("release verifier rejects a checksum file that does not match the artifacts", (t) => {
  const fixture = createFixture(t);
  const checksumsPath = path.join(fixture.releaseDir, "SHA512SUMS");
  const checksums = readFileSync(checksumsPath, "utf8");
  writeFileSync(checksumsPath, checksums.replace(/^[a-f0-9]{128}/u, "0".repeat(128)));
  assert.throws(() => resolveOmarchyRelease(fixture), /does not match/u);
});
