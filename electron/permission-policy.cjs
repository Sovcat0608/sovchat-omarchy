const TRUSTED_DESKTOP_PERMISSIONS = new Set([
  "clipboard-read",
  "clipboard-sanitized-write",
  "display-capture",
  "fullscreen",
  "media",
  "speaker-selection"
]);

function isTrustedDesktopRendererUrl(value, packaged) {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol === "app:" && url.hostname === "desktop") {
      return true;
    }

    return (
      !packaged &&
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function getRequestedMediaTypes(details = {}) {
  const mediaTypes = Array.isArray(details.mediaTypes) ? [...details.mediaTypes] : [];
  if (typeof details.mediaType === "string") {
    mediaTypes.push(details.mediaType);
  }

  return mediaTypes.map((value) => String(value).toLowerCase());
}

function isDesktopPermissionAllowed(options = {}) {
  if (
    !TRUSTED_DESKTOP_PERMISSIONS.has(options.permission) ||
    !isTrustedDesktopRendererUrl(options.requestingUrl, Boolean(options.packaged))
  ) {
    return false;
  }

  if (options.permission !== "media") {
    return true;
  }

  const mediaTypes = getRequestedMediaTypes(options.details);
  return !mediaTypes.includes("video");
}

module.exports = {
  isDesktopPermissionAllowed,
  isTrustedDesktopRendererUrl
};
