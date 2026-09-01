import {
  recordClientDiagnostic,
  sanitizeClientDiagnosticDetails
} from "@/lib/client-diagnostics";

export type SovChatPerformanceTiming = {
  name: string;
  durationMs: number;
  startedAt: number;
  endedAt: number;
  details?: Record<string, unknown>;
};

declare global {
  interface Window {
    __sovchatPerfTimings?: SovChatPerformanceTiming[];
  }
}

const TIMING_HISTORY_LIMIT = 120;
const VERBOSE_DIAGNOSTICS_STORAGE_KEY = "sovchat.verboseDiagnostics";

export function getPerformanceNow() {
  if (typeof performance === "undefined") {
    return Date.now();
  }

  return performance.now();
}

export function shouldLogVerboseDiagnostics() {
  if (process.env.NEXT_PUBLIC_SOVCHAT_VERBOSE_DIAGNOSTICS === "true") {
    return true;
  }

  if (typeof window === "undefined") {
    return false;
  }

  try {
    return window.localStorage.getItem(VERBOSE_DIAGNOSTICS_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function recordPerformanceTiming(
  name: string,
  startedAt: number,
  details?: Record<string, unknown>
) {
  if (typeof window === "undefined") {
    return;
  }

  const endedAt = getPerformanceNow();
  const timing: SovChatPerformanceTiming = {
    name,
    durationMs: Math.max(0, endedAt - startedAt),
    startedAt,
    endedAt,
    details: details ? sanitizeClientDiagnosticDetails(details) : undefined
  };

  const history = window.__sovchatPerfTimings ?? [];
  history.push(timing);
  window.__sovchatPerfTimings = history.slice(-TIMING_HISTORY_LIMIT);

  recordClientDiagnostic("performance", name, {
    durationMs: timing.durationMs,
    startedAt,
    endedAt,
    ...(timing.details ?? {})
  });

  if (shouldLogVerboseDiagnostics()) {
    console.info("[sovchat:perf]", timing.name, `${Math.round(timing.durationMs)}ms`, details ?? {});
  }
}
