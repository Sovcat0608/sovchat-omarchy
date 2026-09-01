export const DEFAULT_DESKTOP_CLIENT_ORIGINS = [
  "app://desktop",
  "http://127.0.0.1:3001",
  "http://localhost:3001"
];

export function getDesktopClientOrigins(value = process.env.SOVCHAT_DESKTOP_CLIENT_ORIGIN) {
  return (value ?? DEFAULT_DESKTOP_CLIENT_ORIGINS.join(","))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function isDesktopReturnPath(pathname: string) {
  return pathname === "/desktop" || pathname === "/desktop/";
}

export function isTrustedDesktopClientReturnUrl(returnTo: string | URL) {
  const url = returnTo instanceof URL ? new URL(returnTo.toString()) : new URL(returnTo);

  if (url.protocol === "app:" && url.hostname === "desktop") {
    return isDesktopReturnPath(url.pathname);
  }

  return isDesktopReturnPath(url.pathname) && getDesktopClientOrigins().includes(url.origin);
}
