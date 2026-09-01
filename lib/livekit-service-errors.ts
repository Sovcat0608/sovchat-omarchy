const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET"
]);

function getErrorChain(error: unknown) {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = error;

  while (current && !seen.has(current) && chain.length < 8) {
    chain.push(current);
    seen.add(current);

    if (typeof current !== "object" || !("cause" in current)) {
      break;
    }

    current = current.cause;
  }

  return chain;
}

function getErrorCode(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code.toUpperCase();
  }

  return "";
}

function getErrorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
}

export function isTransientLiveKitServiceError(error: unknown) {
  return getErrorChain(error).some((entry) => {
    const code = getErrorCode(entry);
    if (TRANSIENT_NETWORK_ERROR_CODES.has(code)) {
      return true;
    }

    const message = getErrorMessage(entry);
    return (
      message.includes("fetch failed") ||
      message.includes("socket hang up") ||
      message.includes("connection refused") ||
      message.includes("connection reset") ||
      message.includes("host unreachable") ||
      message.includes("network is unreachable") ||
      message.includes("service unavailable") ||
      message.includes("bad gateway") ||
      message.includes("gateway timeout") ||
      message.includes("timeout") ||
      message.includes("timed out")
    );
  });
}

export function getLiveKitServiceErrorCode(error: unknown) {
  for (const entry of getErrorChain(error)) {
    const code = getErrorCode(entry);
    if (code) {
      return code;
    }
  }

  return null;
}
