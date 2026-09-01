export const RELEASE_HIGHLIGHTS_VERSION = "0.4.5";
export const RELEASE_HIGHLIGHTS_RANGE = "Independent Omarchy project baseline";
export const RELEASE_HIGHLIGHTS_SUMMARY =
  "This build establishes the SovChat Omarchy app and native plugin as one independent project.";

export const RELEASE_HIGHLIGHTS = [
  {
    kind: "implementation",
    title: "Native Omarchy project",
    detail: "Combined the Omarchy client, plugin surface, secure installer, and release channel."
  },
  {
    kind: "polish",
    title: "Omarchy interface",
    detail: "Made Omarchy presentation and native window behavior the only available interface."
  }
] as const;

export const RELEASE_HIGHLIGHT_NOTES = [
  "Uses the shared SovChat API and LiveKit services with Omarchy-specific access control."
] as const;
export const RELEASE_HIGHLIGHT_COMMITS = [] as const;
export const RELEASE_HIGHLIGHT_FILES = [] as const;
