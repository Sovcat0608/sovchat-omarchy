export type DesktopVersionFamily = {
  major: number;
  minor: number;
  label: string;
};

type ParsedDesktopVersion = DesktopVersionFamily & {
  patch: number | null;
  core: string;
};

const DESKTOP_VERSION_PATTERN =
  /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function parseDesktopVersion(value: string | null | undefined): ParsedDesktopVersion | null {
  const match = value?.trim().match(DESKTOP_VERSION_PATTERN);

  if (!match) {
    return null;
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = match[3] === undefined ? null : Number(match[3]);

  if (![major, minor, patch].every((part) => part === null || Number.isSafeInteger(part))) {
    return null;
  }

  return {
    major,
    minor,
    patch,
    core: patch === null ? `${major}.${minor}` : `${major}.${minor}.${patch}`,
    label: `${major}.${minor}`
  };
}

/**
 * Returns the numeric version core understood by both legacy and current
 * desktop compatibility middleware. The full build semver remains available
 * through build metadata; only the request compatibility header is normalized.
 */
export function getDesktopCompatibilityVersion(value: string) {
  return parseDesktopVersion(value)?.core ?? value.trim();
}

export function parseDesktopVersionFamily(
  value: string | null | undefined
): DesktopVersionFamily | null {
  const parsed = parseDesktopVersion(value);

  if (!parsed) {
    return null;
  }

  return {
    major: parsed.major,
    minor: parsed.minor,
    label: parsed.label
  };
}

export function isDesktopVersionSupported(
  clientVersion: string | null | undefined,
  minimumFamily: DesktopVersionFamily | null
) {
  if (!minimumFamily) {
    return true;
  }

  const clientFamily = parseDesktopVersionFamily(clientVersion);

  if (!clientFamily) {
    return false;
  }

  if (clientFamily.major !== minimumFamily.major) {
    return clientFamily.major > minimumFamily.major;
  }

  return clientFamily.minor >= minimumFamily.minor;
}

export function isDesktopVersionFamilyAllowed(
  clientVersion: string | null | undefined,
  requiredFamily: DesktopVersionFamily | null
) {
  if (!requiredFamily) {
    return true;
  }

  const clientFamily = parseDesktopVersionFamily(clientVersion);

  return (
    clientFamily?.major === requiredFamily.major &&
    clientFamily.minor === requiredFamily.minor
  );
}
