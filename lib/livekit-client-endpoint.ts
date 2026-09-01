export type LiveKitEndpointDetails = {
  host: string;
  protocol: "ws" | "wss";
  deployment: "cloud" | "self-hosted" | "local";
};

function isLoopbackHost(hostname: string) {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "[::1]";
}

export function normalizeLiveKitServerUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    const url = new URL(value.trim());

    if (url.protocol === "https:") {
      url.protocol = "wss:";
    } else if (url.protocol === "http:") {
      url.protocol = "ws:";
    }

    if (url.protocol !== "wss:" && url.protocol !== "ws:") {
      return null;
    }

    if (url.username || url.password || url.search || url.hash) {
      return null;
    }

    if (url.protocol === "ws:" && !isLoopbackHost(url.hostname)) {
      return null;
    }

    return url.toString().replace(/\/$/u, "");
  } catch {
    return null;
  }
}

export function resolveLiveKitServerUrl(serverUrl: unknown, fallbackUrl: unknown) {
  const resolved =
    normalizeLiveKitServerUrl(serverUrl) ?? normalizeLiveKitServerUrl(fallbackUrl);

  if (!resolved) {
    throw new Error("SovChat did not provide a valid LiveKit server URL.");
  }

  return resolved;
}

export function getLiveKitEndpointDetails(value: unknown): LiveKitEndpointDetails | null {
  const normalized = normalizeLiveKitServerUrl(value);
  if (!normalized) {
    return null;
  }

  const url = new URL(normalized);
  const host = url.hostname.toLowerCase();
  const isCloud = host.endsWith(".livekit.cloud") || host.endsWith(".livekit.run");

  return {
    host,
    protocol: url.protocol === "wss:" ? "wss" : "ws",
    deployment: isLoopbackHost(host) ? "local" : isCloud ? "cloud" : "self-hosted"
  };
}
