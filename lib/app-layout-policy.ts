export const MOBILE_COMPACT_MEDIA_QUERY = "(max-width: 767px)";

export function resolveCompactLayout({
  isDesktop,
  desktopCompact,
  mobileViewport
}: {
  isDesktop: boolean;
  desktopCompact: boolean;
  mobileViewport: boolean;
}) {
  return isDesktop ? desktopCompact : mobileViewport;
}

export function canToggleCompactLayout(isDesktop: boolean) {
  return isDesktop;
}
