export const RELEASE_HIGHLIGHTS_VERSION = "0.4.8";
export const RELEASE_HIGHLIGHTS_RANGE = "Since v0.4.7";
export const RELEASE_HIGHLIGHTS_SUMMARY = "This build focuses on open account registration, release pipeline updates, and interface refinements.";

export const RELEASE_HIGHLIGHTS = [
  {
    "kind": "feature",
    "title": "Open account registration",
    "detail": "Removed the beta access-code field; the service now accepts signups until its server-enforced 500-account capacity is reached."
  },
  {
    "kind": "implementation",
    "title": "Release pipeline updates",
    "detail": "Updated the client build, packaging, and updater workflows for this release."
  },
  {
    "kind": "polish",
    "title": "Interface refinements",
    "detail": "Smoothed visual details, spacing, responsive layout behavior, and interaction timing."
  }
] as const;

export const RELEASE_HIGHLIGHT_NOTES = [
  "Removed the beta access-code field; the service now accepts signups until its server-enforced 500-account capacity is reached",
  "Updated the client build, packaging, and updater workflows for this release",
  "Smoothed visual details, spacing, responsive layout behavior, and interaction timing",
  "Sync marketplace from committed blobs",
  "Prepare polished marketplace package",
  "Guide legacy clients onto Omarchy updates",
  "Publish Omarchy plugin 0.1.4"
] as const;
export const RELEASE_HIGHLIGHT_COMMITS = [
  "Sync marketplace from committed blobs",
  "Prepare polished marketplace package",
  "Guide legacy clients onto Omarchy updates",
  "Publish Omarchy plugin 0.1.4"
] as const;
export const RELEASE_HIGHLIGHT_FILES = [
  ".github/workflows/build-omarchy-client.yml",
  "BarWidget.qml",
  "HANDOVER.md",
  "Panel.qml",
  "README.md",
  "bin/sovchat-control",
  "components/login-form.tsx",
  "lib/validators.ts",
  "manifest.json",
  "package-lock.json",
  "package.json",
  "scripts/build-desktop.mjs",
  "scripts/sync-marketplace-plugin.mjs",
  "scripts/write-release-highlights.mjs",
  "tests/build-pipeline-performance.test.mjs",
  "tests/desktop-update-legacy-compat.test.cjs",
  "tests/open-signup-surface.test.mjs",
  "tests/test_safe_install.py"
] as const;
