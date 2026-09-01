export const DEFAULT_KRISP_MODEL_QUALITY = "medium" as const;

export type VoiceConnectionStatus =
  | "idle"
  | "connecting"
  | "preparing-audio"
  | "connected"
  | "degraded"
  | "error";

export type KrispPrewarmState = "idle" | "loading" | "ready" | "degraded";

export type VoiceJoinMicrophoneFailureKind =
  | "permission"
  | "missing-device"
  | "device-busy"
  | "selected-device"
  | "timeout"
  | "publish"
  | "unknown";

export function isVoiceConnectedStatus(status: VoiceConnectionStatus) {
  return status === "connected" || status === "degraded";
}

export function shouldPrewarmKrispAssets(saveData: boolean | undefined) {
  return saveData !== true;
}

export function isPublishedMicrophoneLive(options: {
  publicationExists: boolean;
  publicationMuted: boolean;
  upstreamPaused: boolean;
  mediaReadyState: MediaStreamTrackState | null;
  mediaEnabled: boolean;
}) {
  return (
    options.publicationExists &&
    !options.publicationMuted &&
    !options.upstreamPaused &&
    options.mediaReadyState === "live" &&
    options.mediaEnabled
  );
}

export function shouldTreatJoinFailureAsCancelled(options: {
  explicitCancellation: boolean;
  stageTimeout: boolean;
  signalAborted: boolean;
  attemptActive: boolean;
  roomActive: boolean;
}) {
  return (
    options.explicitCancellation ||
    (!options.stageTimeout &&
      (options.signalAborted || !options.attemptActive || !options.roomActive))
  );
}

function getErrorName(error: unknown) {
  return error && typeof error === "object" && "name" in error && typeof error.name === "string"
    ? error.name.toLowerCase()
    : "";
}

function getErrorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
}

export function classifyVoiceJoinMicrophoneFailure(
  error: unknown
): VoiceJoinMicrophoneFailureKind {
  const name = getErrorName(error);
  const message = getErrorMessage(error);

  if (
    name === "notallowederror" ||
    name === "permissiondeniederror" ||
    name === "securityerror" ||
    message.includes("permission denied") ||
    message.includes("permission dismissed") ||
    message.includes("not allowed")
  ) {
    return "permission";
  }

  if (
    name === "notfounderror" ||
    name === "devicesnotfounderror" ||
    message.includes("no audio capture devices") ||
    message.includes("requested device not found") ||
    message.includes("no microphone")
  ) {
    return "missing-device";
  }

  if (
    name === "notreadableerror" ||
    name === "trackstarterror" ||
    name === "aborterror" ||
    message.includes("could not start audio source") ||
    message.includes("device unavailable") ||
    message.includes("device is busy")
  ) {
    return "device-busy";
  }

  if (
    name === "overconstrainederror" ||
    name === "constraintnotfounderror" ||
    name === "constraintnotsatisfiederror" ||
    message.includes("overconstrained") ||
    message.includes("selected microphone") ||
    message.includes("constraint")
  ) {
    return "selected-device";
  }

  if (message.includes("timeout") || message.includes("timed out")) {
    return "timeout";
  }

  if (
    message.includes("publish") ||
    message.includes("publication") ||
    message.includes("sender") ||
    message.includes("peer connection")
  ) {
    return "publish";
  }

  return "unknown";
}

export function getVoiceJoinMicrophoneFailureMessage(error: unknown, isLinux: boolean) {
  switch (classifyVoiceJoinMicrophoneFailure(error)) {
    case "permission":
      return "You joined voice muted because microphone access is blocked. Allow microphone access in SovChat and your system settings, then click the mic button to retry.";
    case "missing-device":
      return isLinux
        ? "You joined voice muted because Linux did not expose a microphone to SovChat. Select a working input in Omarchy audio settings, then click the mic button to retry."
        : "You joined voice muted because no microphone is available. Connect or enable a microphone, then click the mic button to retry.";
    case "device-busy":
      return isLinux
        ? "You joined voice muted because PipeWire could not open the microphone. Check that the input is enabled and not locked by another app, then click the mic button to retry."
        : "You joined voice muted because the microphone is unavailable or in use. Close any app holding it, then click the mic button to retry.";
    case "selected-device":
      return "You joined voice muted because the selected microphone is no longer available. Choose Default or another input in Audio settings, then click the mic button to retry.";
    case "timeout":
      return "You joined voice muted because the audio service did not respond in time. Check the microphone in system audio settings, then click the mic button to retry.";
    case "publish":
      return "You joined voice, but SovChat could not publish your microphone. Click the mic button to retry; if it repeats, leave and rejoin voice.";
    default:
      return "You joined voice, but the microphone could not start. Check Audio settings, then click the mic button to retry.";
  }
}

export function getVoiceJoinPlaybackFailureMessage() {
  return "You joined voice, but speaker playback is waiting for permission. Click once anywhere in SovChat to resume audio.";
}
