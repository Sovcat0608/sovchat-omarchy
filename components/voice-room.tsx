"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  CSSProperties,
  Dispatch,
  MutableRefObject,
  ReactNode,
  RefObject,
  SetStateAction
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { Transition } from "framer-motion";
import {
  Ban,
  Dock,
  Expand,
  HeadphoneOff,
  LoaderCircle,
  MessageSquareText,
  Minimize,
  Monitor,
  MonitorUp,
  MicOff,
  PanelTop,
  PictureInPicture2,
  VolumeX,
  Volume2,
  ScreenShare,
  Undo2,
  X
} from "lucide-react";
import {
  AudioPresets,
  LocalParticipant,
  LocalVideoTrack,
  Participant,
  RemoteParticipant,
  Room,
  RoomEvent,
  Track,
  VideoQuality,
  createLocalAudioTrack,
  type LocalTrack,
  type LocalAudioTrack,
  type LocalTrackPublication,
  type RemoteAudioTrack,
  type RemoteTrack,
  type RemoteTrackPublication,
  type ScreenShareCaptureOptions,
  ScreenSharePresets,
  type AudioProcessorOptions,
  type TrackPublishOptions,
  type TrackProcessor,
  type VideoTrack
} from "livekit-client";
import { advancedSettingsStore } from "@/lib/advanced-settings-store";
import { audioSettingsStore } from "@/lib/audio-settings-store";
import {
  STABLE_MAX_OUTPUT_VOLUME,
  STABLE_MAX_PARTICIPANT_VOLUME,
  STABLE_MAX_STREAM_VOLUME,
  isNoiseFilterProfile,
  resolveAudioMode
} from "@/lib/audio/audio-modes";
import {
  publishAudioDiagnosticsSnapshot,
  recordAudioDiagnosticEvent
} from "@/lib/audio/audio-diagnostics";
import {
  buildMicrophoneCaptureOptions,
  getMediaTrackSettings
} from "@/lib/audio/local-microphone-controller";
import { RemoteOutputRouter } from "@/lib/audio/remote-output-router";
import {
  classifyVoiceJoinMicrophoneFailure,
  DEFAULT_KRISP_MODEL_QUALITY,
  getVoiceJoinMicrophoneFailureMessage,
  getVoiceJoinPlaybackFailureMessage,
  isPublishedMicrophoneLive,
  isVoiceConnectedStatus,
  shouldPrewarmKrispAssets,
  shouldTreatJoinFailureAsCancelled,
  type KrispPrewarmState,
  type VoiceConnectionStatus
} from "@/lib/audio/voice-join-policy";
import type {
  KrispLifecycleState,
  NoiseFilterRuntimeState,
  SovChatAudioMode,
  SovChatAudioProfile,
  VoiceGateRuntimeState
} from "@/lib/audio/audio-types";
import { apiFetch, resolveApiUrl } from "@/lib/api-client";
import { HARD_IDLE_DISCONNECT_MINUTES } from "@/lib/media-limits";
import {
  getLiveKitEndpointDetails,
  resolveLiveKitServerUrl
} from "@/lib/livekit-client-endpoint";
import {
  installLiveKitClientDiagnostics
} from "@/lib/livekit-client-diagnostics";
import {
  getLiveKitErrorDetails,
  getLiveKitErrorMessage
} from "@/lib/livekit-client-error-details";
import { HoverTooltip } from "@/components/hover-tooltip";
import { OmarchyGlyph } from "@/components/omarchy-glyph";
import { PrimaryPanelShell } from "@/components/primary-panel-shell";
import {
  DESKTOP_UPDATE_INSTALL_STAGE_EVENT,
  getDesktopBridge,
  type DesktopDisplayMediaSource,
  type DesktopUpdateInstallStageDetail
} from "@/lib/desktop";
import {
  getPerformanceNow,
  recordPerformanceTiming,
  shouldLogVerboseDiagnostics
} from "@/lib/performance-diagnostics";
import { useAppFocusState } from "@/lib/use-app-focus-state";
import { cn } from "@/lib/utils";
import type {
  LiveKitTokenResponse,
  PresenceResponse,
  WhisperTarget,
  VoicePresenceParticipant,
  VoicePresenceResponse
} from "@/types";

type ParticipantView = {
  participantId: string;
  userId?: string | null;
  identity: string;
  displayName: string;
  isSpeaking: boolean;
  voiceLevel: number;
  isLocal: boolean;
  isStreaming: boolean;
  isSelfMuted?: boolean;
  isSelfDeafened?: boolean;
  isAfk?: boolean;
  avatarSrc?: string;
};

type ParticipantMetadata = {
  userId?: string;
  nickname?: string;
  selfMuted?: boolean;
  selfDeafened?: boolean;
  isAfk?: boolean;
  avatarId?: string;
  avatarDataUrl?: string;
  role?: string;
  hidden?: boolean;
};

type MuteDebugEntry = {
  timestamp: string;
  event: string;
  details?: Record<string, unknown>;
};

type DisplayAudioConstraints = MediaTrackConstraints & {
  restrictOwnAudio?: boolean;
  suppressLocalAudioPlayback?: boolean;
};

declare global {
  interface MediaTrackSupportedConstraints {
    restrictOwnAudio?: boolean;
    suppressLocalAudioPlayback?: boolean;
  }

  interface Window {
    __sovchatStreamStats?: StreamStatsSnapshot[];
    documentPictureInPicture?: {
      requestWindow: (options?: { width?: number; height?: number }) => Promise<Window>;
    };
  }
}

function parseParticipantMetadata(metadata?: string): ParticipantMetadata {
  if (!metadata) {
    return {};
  }

  try {
    const parsed = JSON.parse(metadata) as ParticipantMetadata;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function getParticipantDisplayName(participant: {
  identity: string;
  name?: string;
  metadata?: string;
}) {
  const parsed = parseParticipantMetadata(participant.metadata);
  if (typeof parsed.nickname === "string" && parsed.nickname.trim()) {
    return parsed.nickname.trim();
  }

  if (typeof participant.name === "string" && participant.name.trim()) {
    return participant.name.trim();
  }

  return participant.identity;
}

function getParticipantAvatarSrc(metadata: ParticipantMetadata) {
  if (typeof metadata.avatarDataUrl === "string" && metadata.avatarDataUrl.trim()) {
    return metadata.avatarDataUrl.trim();
  }

  if (typeof metadata.avatarId === "string" && metadata.avatarId.trim()) {
    return `/avatars/${metadata.avatarId.trim()}.png`;
  }

  return undefined;
}

function isHiddenParticipantMetadata(metadata: ParticipantMetadata) {
  return metadata.hidden === true || metadata.role === "stream-popout";
}

type VoiceRoomProps = {
  roomId?: string | null;
  userId: string;
  nickname: string;
  roomName: string;
  fillerMode: boolean;
  localAvatarSrc?: string;
  localAvatarId?: string;
  localAvatarDataUrl?: string | null;
  showMainPanel?: boolean;
  compactMode?: boolean;
  fallbackContent?: ReactNode;
  isChatPanelOpen?: boolean;
  chatPanelContent?: ReactNode;
  onWhisperParticipant?: (target: WhisperTarget) => void;
  onPrimaryOverlayChange?: (isOverlayOpen: boolean) => void;
};

type StageUser = {
  identity: string;
  displayName: string;
  userId?: string | null;
  participantId?: string;
  volumeKey?: string;
  avatarSrc?: string;
  isSpeaking: boolean;
  voiceLevel: number;
  isLocal: boolean;
  lane: "voice" | "lobby";
  isStreaming?: boolean;
  isSelfMuted?: boolean;
  isSelfDeafened?: boolean;
  isAfk?: boolean;
  isThirdPartyMuted?: boolean;
  thirdPartyVolume?: number;
  isTransitioning?: boolean;
};

type DemoStageUser = {
  identity: string;
  isSpeaking?: boolean;
  isStreaming?: boolean;
  isSelfMuted?: boolean;
  isSelfDeafened?: boolean;
  isAfk?: boolean;
  isThirdPartyMuted?: boolean;
};

type FrontPillSnapshot = Pick<
  StageUser,
  | "isStreaming"
  | "isSelfMuted"
  | "isSelfDeafened"
  | "isThirdPartyMuted"
  | "thirdPartyVolume"
  | "voiceLevel"
>;
type PillPosition = {
  x: number;
  y: number;
  opacity?: number;
};
type VoiceStageProps = {
  roomName: string;
  nickname: string;
  status: VoiceConnectionStatus;
  error: string | null;
  isSharing: boolean;
  participants: ParticipantView[];
  onlineNicknames: string[];
  onlineProfiles: PresenceResponse["profiles"];
  transitionLobbyNicknames: string[];
  lingeringNicknames: string[];
  selfMuted: boolean;
  selfDeafened: boolean;
  thirdPartyMutedIds: Set<string>;
  participantVolumes: Record<string, number>;
  suppressLayoutMotion: boolean;
  selectedStreamLabel: string | null;
  selectedStreamIsPlaceholder: boolean;
  selectedStreamIsPending: boolean;
  isStreamViewerOpen: boolean;
  isUpdateInstallStageActive: boolean;
  isChatPanelOpen: boolean;
  chatPanelContent: ReactNode;
  isRemoteFullscreen: boolean;
  outputMuted: boolean;
  outputVolume: number;
  showStreamStats: boolean;
  streamStats: StreamStatsSnapshot | null;
  hubRef: RefObject<HTMLDivElement | null>;
  ringRef: RefObject<HTMLDivElement | null>;
  onWhisperParticipant?: (target: WhisperTarget) => void;
  onToggleThirdPartyMute: (identity: string) => void;
  onParticipantVolumeChange: (identity: string, volume: number) => void;
  onInspectStream: (identity: string) => void;
  dockedStreamStageRef: RefObject<HTMLDivElement | null>;
  dockedScreenContainerRef: RefObject<HTMLDivElement | null>;
  onCloseStreamViewer: () => void;
  onPopOutStream: () => void;
  onToggleRemoteFullscreen: () => void;
  onToggleStreamOutputMuted: () => void;
  onOutputVolumeChange: (nextVolume: number) => void;
  localAvatarSrc?: string;
  knownAvatarSources: Partial<Record<string, string>>;
  onJoin: () => void;
  onPrimeJoin: (reason: string) => void;
  onCancelJoin: () => void;
  onLeave: () => void;
  onToggleScreenShare: () => void;
  fillerMode: boolean;
  performanceMode: boolean;
  krispSupported: boolean;
  krispFailed: boolean;
  krispPrewarmState: KrispPrewarmState;
  noiseFilterEnabled: boolean;
  onToggleNoiseFilter: () => void;
};
type FlowParticle = {
  key: string;
  variant: 0 | 1 | 2;
  isAmber: boolean;
  durationMs: number;
  expiresAt: number;
  sizePx: number;
  alpha: number;
  glow: number;
  amberAlpha: number;
  inboundStartX: number;
  inboundBaseMidX: number;
  inboundMidX: number;
  inboundLateX: number;
  inboundEndX: number;
  inboundStartY: number;
  inboundBaseMidY: number;
  inboundMidY: number;
  inboundLateY: number;
  inboundEndY: number;
  outboundStartX: number;
  outboundBaseMidX: number;
  outboundMidX: number;
  outboundLateX: number;
  outboundEndX: number;
  outboundStartY: number;
  outboundBaseMidY: number;
  outboundMidY: number;
  outboundLateY: number;
  outboundEndY: number;
};
type ScreenShareSourcePickerProps = {
  isOpen: boolean;
  isLoading: boolean;
  sources: DesktopDisplayMediaSource[];
  compactMode: boolean;
  includeSystemAudio: boolean;
  systemAudioSupported: boolean;
  streamQualityMode: StreamQualityMode;
  onToggleIncludeSystemAudio: (nextValue: boolean) => void;
  onStreamQualityModeChange: (nextMode: StreamQualityMode) => void;
  onClose: () => void;
  onSelect: (source: DesktopDisplayMediaSource) => void;
};

type ScreenShareSession = {
  videoTrack: LocalVideoTrack;
  audioTrack: LocalAudioTrack | null;
  videoPublication: LocalTrackPublication;
  audioPublication: LocalTrackPublication | null;
  mode: StreamQualityMode;
  cleanup: () => void;
};

const STREAM_QUALITY_OPTIONS = ["auto", "720p", "1080p", "1440p"] as const;
type StreamQualityMode = (typeof STREAM_QUALITY_OPTIONS)[number];

type StreamStatsSnapshot = {
  direction: "send" | "receive";
  mode: StreamQualityMode;
  timestamp: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  renderFps: number | null;
  bitrateKbps: number | null;
  targetBitrateKbps: number | null;
  packetsLost: number | null;
  jitterMs: number | null;
  roundTripMs: number | null;
  framesDropped: number | null;
  framesEncoded: number | null;
  framesDecoded: number | null;
  qualityLimitationReason: string | null;
  codec: string | null;
};

type StreamStatsSample = {
  timestamp: number;
  bytes: number;
  frames: number;
};

type LocalAudioStatsSnapshot = {
  timestamp: number;
  source: string;
  codec: string | null;
  bitrateKbps: number | null;
  packetsSent: number | null;
  maxBitrate: number | null;
  dtx: boolean;
  red: boolean;
  forceStereo: boolean;
};

type AudioStatsSample = {
  timestamp: number;
  bytes: number;
};

type ParticipantVoiceActivity = {
  level: number;
  lastActiveAt: number;
};

type KrispNoiseFilterProcessor = TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> & {
  setEnabled: (enable: boolean) => Promise<boolean | void>;
  isEnabled: () => boolean;
  processedTrack?: MediaStreamTrack;
};

type KrispNoiseFilterModule = {
  KrispNoiseFilter: (options?: { quality?: "low" | "medium" | "high" }) => KrispNoiseFilterProcessor;
  isKrispNoiseFilterSupported?: () => boolean;
  prewarm?: (signal?: AbortSignal) => Promise<void>;
};

const RING_BAR_COUNT = 56;
const VOICE_PILL_HEIGHT = 64;
const VOICE_PILL_GAP = 14;
const VOICE_PILL_COLUMN_GAP = 18;
const VOICE_PILL_VERTICAL_PADDING = 32;
const CHAT_STAGE_VERTICAL_SETTLE_MS = 420;
const MAIN_BUTTON_CENTER_OFFSET = 32;
const STAGE_EDGE_INSET = 28;
const STAGE_METRIC_SETTLE_FRAMES = 8;
const PILL_METRIC_SETTLE_FRAMES = 8;
const PILL_ACTIVE_WIDTH_GROW_THRESHOLD = 4;
const PILL_HOVER_OPEN_SETTLE_MS = 380;
const PILL_HOVER_CLOSE_DELAY_MS = 500;
const STREAM_STAGE_GAP = 34;
const STREAM_STAGE_MIN_WIDTH = 340;
const STREAM_STAGE_MAX_WIDTH = 720;
const CORE_OUTER_RADIUS = 94;
const SHARE_BUTTON_TOP_OFFSET = 173;
const SHARE_BUTTON_SIZE = 64;
const SHARE_BUTTON_CENTER_OFFSET = SHARE_BUTTON_TOP_OFFSET + SHARE_BUTTON_SIZE / 2;
const SHARE_FLOW_BRIDGE_TOP_OFFSET = MAIN_BUTTON_CENTER_OFFSET + CORE_OUTER_RADIUS;
const HUB_PILL_CLEARANCE = 42;
const RAIL_INNER_GAP = 132;
const DEMO_SPEAKING_WINDOW_MS = 3000;
const DEMO_SPEAKING_CYCLE_MS = 5000;
const DEMO_ACTIVITY_TICK_MS = 500;
const AFK_SLEEP_BADGE_MINUTES = 5;
const AFK_SLEEP_BADGE_MS = AFK_SLEEP_BADGE_MINUTES * 60 * 1000;
let voiceFlowSessionSeed: number | null = null;

function getVoiceFlowSessionSeed() {
  if (voiceFlowSessionSeed === null) {
    voiceFlowSessionSeed = Math.floor(Math.random() * 100000);
  }

  return voiceFlowSessionSeed;
}

function createFlowRng(seed: number) {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
const MAX_SPEAKER_VOLUME_PERCENT = STABLE_MAX_OUTPUT_VOLUME * 100;
const MAX_MICROPHONE_GAIN_PERCENT = 100;
const MAX_STREAM_VOLUME_PERCENT = STABLE_MAX_STREAM_VOLUME * 100;
const MAX_PARTICIPANT_VOLUME_PERCENT = STABLE_MAX_PARTICIPANT_VOLUME * 100;
const PARTICIPANT_VOLUME_SLIDER_MAX = 200;
const PARTICIPANT_VOLUME_SNAP_PERCENT = 100;
const PARTICIPANT_VOLUME_SNAP_THRESHOLD = 6;
const PARTICIPANT_VOLUME_STORAGE_KEY = "sovchat.participant-volumes.v1";
const STREAM_STATS_INTERVAL_MS = 1200;
const SCREEN_SHARE_USAGE_REPORT_INTERVAL_MS = 15_000;
const PARTICIPANT_REFRESH_INTERVAL_MS = 120;
const PARTICIPANT_VOICE_ACTIVE_THRESHOLD = 0.018;
const PARTICIPANT_VOICE_HOLD_MS = 620;
const PARTICIPANT_VOICE_ATTACK = 0.72;
const PARTICIPANT_VOICE_RELEASE = 0.28;
const VOICE_RING_ANALYSER_FFT_SIZE = 512;
const VOICE_RING_VISUAL_NOISE_FLOOR_RMS = 0.006;
const VOICE_RING_VISUAL_GAIN = 17;
const VOICE_RING_VISUAL_CURVE = 0.72;
const VOICE_RING_VISUAL_ATTACK = 0.26;
const VOICE_RING_VISUAL_RELEASE = 0.11;
const LEGACY_MIC_ANALYSER_RECOVERY_ENABLED = false;
const WHITE_NOISE_GUARD_WINDOW_MS = 2400;
const WHITE_NOISE_GUARD_COOLDOWN_MS = 45_000;
const NOISE_FLOOR_WARNING_RMS = 0.045;
const NOISE_FLOOR_WARNING_WINDOW_MS = 8000;
const NOISE_FLOOR_WARNING_COOLDOWN_MS = 60_000;
const STREAM_AFK_STOP_MINUTES = 15;
const STREAM_AFK_STOP_MS = STREAM_AFK_STOP_MINUTES * 60 * 1000;
const DESKTOP_LOCAL_AUDIO_PROCESSORS_ENABLED = false;
const CUSTOM_INPUT_GAIN_PROCESSORS_ENABLED = false;
const KRISP_MODEL_REGISTRY_URL = "https://integrations.livekit.io/enc/v2";
const KRISP_PROXY_MODEL_ASSETS = ["model8", "low", "medium", "high", "modelBVC"] as const;
const KRISP_PREWARM_MODEL_ASSETS = [DEFAULT_KRISP_MODEL_QUALITY] as const;
const KRISP_PROCESSOR_ATTACH_TIMEOUT_MS = 10_000;
const KRISP_PROCESSOR_ENABLE_TIMEOUT_MS = 7000;
const KRISP_PROCESSOR_STOP_TIMEOUT_MS = 1200;
const KRISP_PREWARM_TIMEOUT_MS = 12_000;
const JOIN_KRISP_PREPARE_TIMEOUT_MS = 9000;
const JOIN_TOKEN_TIMEOUT_MS = 12_000;
const JOIN_ROOM_CONNECT_TIMEOUT_MS = 15_000;
const JOIN_AUDIO_START_TIMEOUT_MS = 6000;
const AUDIO_DEVICE_SYNC_TIMEOUT_MS = 24_000;
const JOIN_AUDIO_READY_TIMEOUT_MS = AUDIO_DEVICE_SYNC_TIMEOUT_MS + 5000;
const VOICE_TOKEN_PREFETCH_DELAY_MS = 350;
const VOICE_TOKEN_PREFETCH_MAX_AGE_MS = 30_000;

type KrispModelAsset = (typeof KRISP_PROXY_MODEL_ASSETS)[number];

type KrispModelRegistry = {
  modelPaths?: Partial<Record<KrispModelAsset, string>>;
  bvcDevices?: string;
};

type LiveKitVoiceTokenPayload = LiveKitTokenResponse & { error?: string };

type PrefetchedVoiceToken = {
  roomId: string;
  createdAt: number;
  payload: LiveKitVoiceTokenPayload;
};

type VoiceTokenPrefetchRequest = {
  roomId: string;
  startedAt: number;
  promise: Promise<LiveKitVoiceTokenPayload | null>;
  abort: () => void;
};

type PreparedJoinMicrophone = {
  localTrack: LocalAudioTrack;
  usedDefaultInputFallback: boolean;
};

let krispFetchProxyDepth = 0;
let originalKrispFetch: typeof fetch | null = null;
let krispNoiseFilterModulePromise: Promise<KrispNoiseFilterModule | null> | null = null;
let krispModelAssetPrewarmPromise: Promise<void> | null = null;
const VOICE_GATE_WORKLET_URL = "/audio-worklets/sovchat-voice-gate-processor.js";
const VOICE_GATE_WORKLET_NAME = "sovchat-voice-gate";
const VOICE_GATE_SCRIPT_PROCESSOR_BUFFER_SIZE = 2048;
const voiceGateWorkletLoaders = new WeakMap<AudioContext, Promise<boolean>>();

const STREAM_QUALITY_LABELS: Record<StreamQualityMode, string> = {
  auto: "Auto",
  "720p": "720p",
  "1080p": "1080p",
  "1440p": "1440p"
};
const SCREEN_SHARE_PICKER_QUALITY_OPTIONS = ["720p", "1080p"] as const satisfies readonly StreamQualityMode[];

const STREAM_QUALITY_DESCRIPTIONS: Record<StreamQualityMode, string> = {
  auto: "Adapts from 720p60 when CPU or bandwidth gets tight.",
  "720p": "1280x720 at 60 fps.",
  "1080p": "1920x1080 at 60 fps.",
  "1440p": "2560x1440 at 60 fps."
};

type VoiceGateExperiment = "off" | "soft" | "strong";

type VoiceGateConfig = {
  label: string;
  minOpenRms: number;
  minCloseRms: number;
  openNoiseMultiplier: number;
  closeNoiseMultiplier: number;
  peakOpen: number;
  holdMs: number;
  attackMs: number;
  releaseMs: number;
  closedGain: number;
  noiseFloorRise: number;
  noiseFloorFall: number;
};

type VoiceGateStats = {
  profile: VoiceGateExperiment;
  source: VoiceGateRuntimeState["source"];
  gateOpen: boolean;
  rms: number;
  noiseFloor: number;
  openThreshold: number;
  closeThreshold: number;
  gain: number;
  closedGain: number;
  updatedAt: string;
};

const DEFAULT_VOICE_GATE_EXPERIMENT: VoiceGateExperiment = "soft";
const EMPTY_VOICE_GATE_DIAGNOSTICS: VoiceGateRuntimeState = {
  profile: DEFAULT_VOICE_GATE_EXPERIMENT,
  enabled: false,
  processorActive: false,
  source: "none",
  gateOpen: null,
  rms: null,
  noiseFloor: null,
  openThreshold: null,
  closeThreshold: null,
  gain: null,
  closedGain: null,
  updatedAt: null
};

function getVoiceGateConfig(experiment: VoiceGateExperiment): VoiceGateConfig | null {
  switch (experiment) {
    case "soft":
      return {
        label: "Soft",
        minOpenRms: 0.012,
        minCloseRms: 0.007,
        openNoiseMultiplier: 2.8,
        closeNoiseMultiplier: 1.7,
        peakOpen: 0.055,
        holdMs: 180,
        attackMs: 8,
        releaseMs: 120,
        closedGain: 0.006,
        noiseFloorRise: 0.03,
        noiseFloorFall: 0.12
      };
    case "strong":
      return {
        label: "Strong",
        minOpenRms: 0.018,
        minCloseRms: 0.011,
        openNoiseMultiplier: 3.3,
        closeNoiseMultiplier: 1.9,
        peakOpen: 0.075,
        holdMs: 140,
        attackMs: 6,
        releaseMs: 95,
        closedGain: 0,
        noiseFloorRise: 0.025,
        noiseFloorFall: 0.14
      };
    case "off":
    default:
      return null;
  }
}

function loadVoiceGateWorklet(audioContext: AudioContext) {
  if (
    typeof window === "undefined" ||
    typeof AudioWorkletNode === "undefined" ||
    !audioContext.audioWorklet?.addModule
  ) {
    return Promise.resolve(false);
  }

  const existingLoader = voiceGateWorkletLoaders.get(audioContext);
  if (existingLoader) {
    return existingLoader;
  }

  const loader = audioContext.audioWorklet
    .addModule(VOICE_GATE_WORKLET_URL)
    .then(() => true)
    .catch((error) => {
      console.warn("[sovchat:audio] Voice gate AudioWorklet unavailable; using fallback.", {
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    });
  voiceGateWorkletLoaders.set(audioContext, loader);
  return loader;
}

type MicrophonePublishPlan = {
  options: TrackPublishOptions;
  diagnostics: {
    publishProfile: "dtx-off";
    publishAudioPreset: string;
    publishMaxBitrate: number | null;
    dtx: boolean | null;
    red: boolean | null;
    forceStereo: boolean | null;
  };
};

function buildMicrophonePublishPlan(): MicrophonePublishPlan {
  const options: TrackPublishOptions = {
    source: Track.Source.Microphone,
    audioPreset: AudioPresets.speech,
    dtx: false,
    forceStereo: false
  };

  return {
    options,
    diagnostics: {
      publishProfile: "dtx-off",
      publishAudioPreset: "AudioPresets.speech",
      publishMaxBitrate: options.audioPreset?.maxBitrate ?? null,
      dtx: options.dtx ?? null,
      red: options.red ?? null,
      forceStereo: options.forceStereo ?? null
    }
  };
}

const SCREEN_SHARE_AUDIO_PUBLISH_OPTIONS = {
  source: Track.Source.ScreenShareAudio,
  audioPreset: AudioPresets.musicHighQualityStereo,
  dtx: false,
  forceStereo: true,
  red: true
} satisfies TrackPublishOptions;

const STREAM_QUALITY_PROFILES: Record<
  StreamQualityMode,
  {
    width: number;
    height: number;
    frameRate: number;
    maxBitrate: number;
    codec: "vp8" | "h264";
    contentHint: "motion" | "detail" | "text";
    degradationPreference: RTCDegradationPreference;
  }
> = {
  auto: {
    width: 1280,
    height: 720,
    frameRate: 60,
    maxBitrate: 6_000_000,
    codec: "vp8",
    contentHint: "motion",
    degradationPreference: "balanced"
  },
  "720p": {
    width: 1280,
    height: 720,
    frameRate: 60,
    maxBitrate: 6_000_000,
    codec: "vp8",
    contentHint: "motion",
    degradationPreference: "balanced"
  },
  "1080p": {
    width: 1920,
    height: 1080,
    frameRate: 60,
    maxBitrate: 12_000_000,
    codec: "vp8",
    contentHint: "motion",
    degradationPreference: "balanced"
  },
  "1440p": {
    width: 2560,
    height: 1440,
    frameRate: 60,
    maxBitrate: 18_000_000,
    codec: "vp8",
    contentHint: "motion",
    degradationPreference: "balanced"
  }
};

function getStreamVolumePercent(volume: number) {
  return Math.max(0, Math.min(100, Math.round((volume * 100 / MAX_STREAM_VOLUME_PERCENT) * 100)));
}

function getClampedMediaVolume(volume: number) {
  return Math.max(0, Math.min(1, volume));
}

function getClampedGainVolume(volume: number, maxPercent: number) {
  return Math.max(0, Math.min(maxPercent / 100, volume));
}

function getEffectiveBoostGain(volume: number, maxPercent: number) {
  const uiGain = getClampedGainVolume(volume, maxPercent);

  if (maxPercent <= 100 || uiGain <= 1) {
    return uiGain;
  }

  return 1 + (uiGain - 1) * 2;
}

function getParticipantVolumeSliderValue(volume: number) {
  const clampedVolume = getClampedGainVolume(volume, MAX_PARTICIPANT_VOLUME_PERCENT);

  if (clampedVolume <= 1) {
    return Math.round(clampedVolume * 100);
  }

  return Math.round(
    PARTICIPANT_VOLUME_SNAP_PERCENT +
      ((clampedVolume - 1) / Math.max(0.001, STABLE_MAX_PARTICIPANT_VOLUME - 1)) *
        PARTICIPANT_VOLUME_SNAP_PERCENT
  );
}

function getParticipantVolumeFromSliderValue(value: number) {
  const clamped = Math.max(0, Math.min(PARTICIPANT_VOLUME_SLIDER_MAX, value));
  const snapped =
    Math.abs(clamped - PARTICIPANT_VOLUME_SNAP_PERCENT) <= PARTICIPANT_VOLUME_SNAP_THRESHOLD
    ? PARTICIPANT_VOLUME_SNAP_PERCENT
    : clamped;

  if (snapped <= PARTICIPANT_VOLUME_SNAP_PERCENT) {
    return snapped / 100;
  }

  return (
    1 +
    ((snapped - PARTICIPANT_VOLUME_SNAP_PERCENT) / PARTICIPANT_VOLUME_SNAP_PERCENT) *
      (STABLE_MAX_PARTICIPANT_VOLUME - 1)
  );
}

function readStoredParticipantVolumes() {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(PARTICIPANT_VOLUME_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const nextVolumes: Record<string, number> = {};

    for (const [identity, value] of Object.entries(parsed)) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        continue;
      }
      nextVolumes[identity] = getClampedGainVolume(value, MAX_PARTICIPANT_VOLUME_PERCENT);
    }

    return nextVolumes;
  } catch {
    return {};
  }
}

function getStableParticipantVolumeKey(participantId: string | undefined, userId?: string | null) {
  const stableUserId = typeof userId === "string" ? userId.trim() : "";
  return stableUserId || participantId || "";
}

function getStoredParticipantVolume(
  volumes: Record<string, number>,
  volumeKey: string,
  fallbackKey?: string
) {
  return volumes[volumeKey] ?? (fallbackKey ? volumes[fallbackKey] : undefined) ?? 1;
}

function isStoredParticipantMuted(
  mutedIds: Set<string>,
  volumes: Record<string, number>,
  volumeKey: string,
  fallbackKey?: string
) {
  return (
    mutedIds.has(volumeKey) ||
    (fallbackKey ? mutedIds.has(fallbackKey) : false) ||
    getStoredParticipantVolume(volumes, volumeKey, fallbackKey) <= 0
  );
}

function persistParticipantVolumes(volumes: Record<string, number>) {
  if (typeof window === "undefined") {
    return;
  }

  const cleanedEntries = Object.entries(volumes).filter(([, volume]) => Math.abs(volume - 1) > 0.001);

  if (cleanedEntries.length === 0) {
    window.localStorage.removeItem(PARTICIPANT_VOLUME_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(
    PARTICIPANT_VOLUME_STORAGE_KEY,
    JSON.stringify(Object.fromEntries(cleanedEntries))
  );
}

function getCaptureConstraintDiagnostics(constraints: MediaTrackConstraints) {
  const extendedConstraints = constraints as MediaTrackConstraints & {
    voiceIsolation?: ConstrainBoolean;
  };

  return {
    deviceId: constraints.deviceId ? "selected" : null,
    echoCancellation: constraints.echoCancellation ?? null,
    noiseSuppression: constraints.noiseSuppression ?? null,
    autoGainControl: constraints.autoGainControl ?? null,
    channelCount: constraints.channelCount ?? null,
    voiceIsolation: extendedConstraints.voiceIsolation ?? null
  };
}

function getAudioTrackSettingsDiagnostics(
  settings:
    | (MediaTrackSettings & {
        echoCancellation?: boolean;
        noiseSuppression?: boolean;
        autoGainControl?: boolean;
        latency?: number;
        sampleRate?: number;
        sampleSize?: number;
        voiceIsolation?: boolean;
      })
    | null
) {
  return {
    deviceId: settings?.deviceId ?? null,
    echoCancellation: settings?.echoCancellation ?? null,
    noiseSuppression: settings?.noiseSuppression ?? null,
    autoGainControl: settings?.autoGainControl ?? null,
    channelCount: settings?.channelCount ?? null,
    sampleRate: settings?.sampleRate ?? null,
    sampleSize: settings?.sampleSize ?? null,
    latency: settings?.latency ?? null,
    voiceIsolation: settings?.voiceIsolation ?? null
  };
}

function getParticipantVoiceLevel(audioLevel: number, isSpeaking: boolean) {
  if (!isSpeaking) {
    return 0;
  }

  return Math.min(1, 0.18 + Math.pow(Math.min(1, audioLevel * 4.2), 0.42) * 0.82);
}

function resolveParticipantVoiceActivity(
  previousActivity: ParticipantVoiceActivity | undefined,
  audioLevel: number,
  liveKitSpeaking: boolean,
  now: number
) {
  const rawActive = liveKitSpeaking || audioLevel > PARTICIPANT_VOICE_ACTIVE_THRESHOLD;
  const lastActiveAt = rawActive ? now : previousActivity?.lastActiveAt ?? 0;
  const isSpeaking = rawActive || now - lastActiveAt < PARTICIPANT_VOICE_HOLD_MS;
  const targetLevel = getParticipantVoiceLevel(audioLevel, rawActive);
  const previousLevel = previousActivity?.level ?? 0;
  const smoothing = targetLevel >= previousLevel ? PARTICIPANT_VOICE_ATTACK : PARTICIPANT_VOICE_RELEASE;
  const voiceLevel = isSpeaking
    ? Math.max(rawActive ? 0.2 : 0.12, previousLevel + (targetLevel - previousLevel) * smoothing)
    : 0;

  return {
    activity: {
      level: voiceLevel,
      lastActiveAt
    },
    isSpeaking,
    voiceLevel
  };
}

function asFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function getStatsCodec(report: RTCStatsReport, stats: Record<string, unknown>) {
  const codecId = typeof stats.codecId === "string" ? stats.codecId : "";
  const codec = codecId ? (report.get(codecId) as Record<string, unknown> | undefined) : undefined;
  const mimeType = typeof codec?.mimeType === "string" ? codec.mimeType : null;

  return mimeType?.replace(/^(audio|video)\//i, "") ?? null;
}

function getStreamBitrateKbps(
  stats: Record<string, unknown>,
  previous: StreamStatsSample | null,
  byteKey: "bytesSent" | "bytesReceived"
) {
  const timestamp = asFiniteNumber(stats.timestamp) ?? Date.now();
  const bytes = asFiniteNumber(stats[byteKey]) ?? 0;

  if (!previous || timestamp <= previous.timestamp || bytes < previous.bytes) {
    return null;
  }

  return Math.max(0, ((bytes - previous.bytes) * 8) / (timestamp - previous.timestamp));
}

function pickStatsByType(report: RTCStatsReport, type: string): Record<string, unknown> | null {
  let picked: Record<string, unknown> | null = null;

  report.forEach((entry) => {
    const stats = entry as Record<string, unknown>;
    if (stats.type !== type) {
      return;
    }

    const kind = stats.kind ?? stats.mediaType;
    if (kind !== "video") {
      return;
    }

    if (stats.isRemote === true) {
      return;
    }

    picked = stats;
  });

  return picked;
}

function getRemoteInboundStats(report: RTCStatsReport): Record<string, unknown> | null {
  let picked: Record<string, unknown> | null = null;

  report.forEach((entry) => {
    const stats = entry as Record<string, unknown>;
    if (stats.type !== "remote-inbound-rtp") {
      return;
    }

    const kind = stats.kind ?? stats.mediaType;
    if (kind === "video") {
      picked = stats;
    }
  });

  return picked;
}

function pickOutboundAudioStats(report: RTCStatsReport): Record<string, unknown> | null {
  let picked: Record<string, unknown> | null = null;

  report.forEach((entry) => {
    const stats = entry as Record<string, unknown>;
    if (stats.type !== "outbound-rtp") {
      return;
    }

    const kind = stats.kind ?? stats.mediaType;
    if (kind !== "audio" || stats.isRemote === true) {
      return;
    }

    picked = stats;
  });

  return picked;
}

function getAudioBitrateKbps(stats: Record<string, unknown>, previous: AudioStatsSample | null) {
  const timestamp = asFiniteNumber(stats.timestamp) ?? Date.now();
  const bytes = asFiniteNumber(stats.bytesSent) ?? 0;

  if (!previous || timestamp <= previous.timestamp || bytes < previous.bytes) {
    return null;
  }

  return Math.max(0, ((bytes - previous.bytes) * 8) / (timestamp - previous.timestamp));
}

function buildLocalAudioStats(
  report: RTCStatsReport,
  source: Track.Source,
  options: TrackPublishOptions,
  previous: AudioStatsSample | null
) {
  const outbound = pickOutboundAudioStats(report);
  if (!outbound) {
    return null;
  }

  const timestamp = asFiniteNumber(outbound.timestamp) ?? Date.now();
  const bytes = asFiniteNumber(outbound.bytesSent) ?? 0;

  return {
    snapshot: {
      timestamp,
      source,
      codec: getStatsCodec(report, outbound),
      bitrateKbps: getAudioBitrateKbps(outbound, previous),
      packetsSent: asFiniteNumber(outbound.packetsSent),
      maxBitrate: options.audioPreset?.maxBitrate ?? null,
      dtx: Boolean(options.dtx),
      red: Boolean(options.red),
      forceStereo: Boolean(options.forceStereo)
    } satisfies LocalAudioStatsSnapshot,
    sample: { timestamp, bytes } satisfies AudioStatsSample
  };
}

function buildOutboundStreamStats(
  report: RTCStatsReport,
  mode: StreamQualityMode,
  previous: StreamStatsSample | null
) {
  const outbound = pickStatsByType(report, "outbound-rtp");
  if (!outbound) {
    return null;
  }

  const timestamp = asFiniteNumber(outbound.timestamp) ?? Date.now();
  const bytes = asFiniteNumber(outbound.bytesSent) ?? 0;
  const frames = asFiniteNumber(outbound.framesEncoded) ?? 0;
  const remoteInbound = getRemoteInboundStats(report);
  const targetBitrate = asFiniteNumber(outbound.targetBitrate);

  return {
    snapshot: {
      direction: "send" as const,
      mode,
      timestamp,
      width: asFiniteNumber(outbound.frameWidth),
      height: asFiniteNumber(outbound.frameHeight),
      fps: asFiniteNumber(outbound.framesPerSecond),
      renderFps: null,
      bitrateKbps: getStreamBitrateKbps(outbound, previous, "bytesSent"),
      targetBitrateKbps: targetBitrate === null ? null : targetBitrate / 1000,
      packetsLost: asFiniteNumber(remoteInbound?.packetsLost),
      jitterMs: null,
      roundTripMs:
        asFiniteNumber(remoteInbound?.roundTripTime) === null
          ? null
          : (asFiniteNumber(remoteInbound?.roundTripTime) ?? 0) * 1000,
      framesDropped: null,
      framesEncoded: frames,
      framesDecoded: null,
      qualityLimitationReason:
        typeof outbound.qualityLimitationReason === "string"
          ? outbound.qualityLimitationReason
          : null,
      codec: getStatsCodec(report, outbound)
    } satisfies StreamStatsSnapshot,
    sample: { timestamp, bytes, frames } satisfies StreamStatsSample
  };
}

function buildInboundStreamStats(
  report: RTCStatsReport,
  mode: StreamQualityMode,
  previous: StreamStatsSample | null
) {
  const inbound = pickStatsByType(report, "inbound-rtp");
  if (!inbound) {
    return null;
  }

  const timestamp = asFiniteNumber(inbound.timestamp) ?? Date.now();
  const bytes = asFiniteNumber(inbound.bytesReceived) ?? 0;
  const frames = asFiniteNumber(inbound.framesDecoded) ?? 0;
  const jitter = asFiniteNumber(inbound.jitter);

  return {
    snapshot: {
      direction: "receive" as const,
      mode,
      timestamp,
      width: asFiniteNumber(inbound.frameWidth),
      height: asFiniteNumber(inbound.frameHeight),
      fps: asFiniteNumber(inbound.framesPerSecond),
      renderFps: null,
      bitrateKbps: getStreamBitrateKbps(inbound, previous, "bytesReceived"),
      targetBitrateKbps: null,
      packetsLost: asFiniteNumber(inbound.packetsLost),
      jitterMs: jitter === null ? null : jitter * 1000,
      roundTripMs: null,
      framesDropped: asFiniteNumber(inbound.framesDropped),
      framesEncoded: null,
      framesDecoded: frames,
      qualityLimitationReason: null,
      codec: getStatsCodec(report, inbound)
    } satisfies StreamStatsSnapshot,
    sample: { timestamp, bytes, frames } satisfies StreamStatsSample
  };
}

async function loadKrispNoiseFilterModule(): Promise<KrispNoiseFilterModule | null> {
  if (!krispNoiseFilterModulePromise) {
    krispNoiseFilterModulePromise = import("@/lib/audio/local-noise-filter")
      .then((module) => ({
        KrispNoiseFilter: () => new module.LocalNoiseFilterProcessor(),
        isKrispNoiseFilterSupported: module.isLocalNoiseFilterSupported,
        prewarm: module.prewarmLocalNoiseFilter
      }))
      .catch((error) => {
        krispNoiseFilterModulePromise = null;
        recordAudioDiagnosticEvent("krisp-module-load-failed", {
          error: error instanceof Error ? error.message : String(error)
        });
        return null;
      });
  }

  return krispNoiseFilterModulePromise;
}

function isKrispModelRegistryRequest(input: RequestInfo | URL) {
  const url = getRequestUrl(input);

  return Boolean(url && url.toString().replace(/\/$/u, "") === KRISP_MODEL_REGISTRY_URL);
}

function getRequestUrl(input: RequestInfo | URL) {
  try {
    if (typeof Request !== "undefined" && input instanceof Request) {
      return new URL(input.url);
    }

    if (typeof URL !== "undefined" && input instanceof URL) {
      return input;
    }

    return new URL(String(input), typeof window !== "undefined" ? window.location.href : undefined);
  } catch {
    return null;
  }
}

function isLiveKitKrispIntegrationRequest(input: RequestInfo | URL) {
  const url = getRequestUrl(input);

  return url?.hostname === "integrations.livekit.io";
}

function isSovChatKrispProxyRequest(input: RequestInfo | URL) {
  const url = getRequestUrl(input);

  return url?.pathname === "/api/krisp-noise-filter/model";
}

function getKrispRuntimeKind() {
  if (typeof window === "undefined") {
    return "server";
  }

  const desktopBridge = getDesktopBridge();

  if (desktopBridge?.isDesktop && window.location.protocol === "app:") {
    return "packaged-desktop";
  }

  if (desktopBridge?.isDesktop) {
    return "desktop-dev";
  }

  const hostname = window.location.hostname;

  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") {
    return "local-web-dev";
  }

  return "hosted-web";
}

function getKrispBackendApiBase() {
  if (typeof window === "undefined") {
    return "";
  }

  const desktopBridge = getDesktopBridge();

  if (desktopBridge?.isDesktop) {
    return desktopBridge.apiBaseUrl ?? desktopBridge.remoteAppUrl ?? "";
  }

  return window.location.origin;
}

function getKrispProxyUrlDiagnostics(proxyUrl: string, asset?: string) {
  const resolvedUrl =
    typeof window === "undefined" ? proxyUrl : new URL(proxyUrl, window.location.href).toString();

  return {
    runtime: getKrispRuntimeKind(),
    backendApiBase: getKrispBackendApiBase(),
    proxyUrl: resolvedUrl,
    asset: asset ?? null
  };
}

function getProxiedKrispAssetUrl(asset: KrispModelAsset | "bvcDevices") {
  const proxyPath = `/api/krisp-noise-filter/model?asset=${encodeURIComponent(asset)}`;
  const proxyUrl = resolveApiUrl(proxyPath);

  if (typeof window === "undefined") {
    return proxyUrl;
  }

  const absoluteProxyUrl = new URL(proxyUrl, window.location.href).toString();

  recordAudioDiagnosticEvent(
    "krisp-proxy-url-resolved",
    getKrispProxyUrlDiagnostics(absoluteProxyUrl, asset)
  );
  return absoluteProxyUrl;
}

function shouldPrewarmKrispAssetsForCurrentConnection() {
  if (typeof navigator === "undefined") {
    return false;
  }

  const connection = (
    navigator as Navigator & {
      connection?: {
        saveData?: boolean;
        effectiveType?: string;
      };
    }
  ).connection;
  return shouldPrewarmKrispAssets(connection?.saveData);
}

async function prewarmKrispModelAssets(reason: string, signal?: AbortSignal) {
  if (!shouldPrewarmKrispAssetsForCurrentConnection()) {
    recordAudioDiagnosticEvent("krisp-model-prewarm-skipped", {
      reason,
      saveData: true
    });
    return false;
  }

  if (krispModelAssetPrewarmPromise) {
    await krispModelAssetPrewarmPromise;
    return true;
  }

  krispModelAssetPrewarmPromise = (async () => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timeoutId = window.setTimeout(abort, KRISP_PREWARM_TIMEOUT_MS);

    try {
      const module = await loadKrispNoiseFilterModule();
      if (!module?.prewarm) {
        throw new Error("Local noise filter prewarm is unavailable.");
      }
      await module.prewarm(controller.signal);
      recordAudioDiagnosticEvent("krisp-model-prewarm-complete", {
        reason,
        engine: "local-rnnoise"
      });
    } catch (error) {
      recordAudioDiagnosticEvent("krisp-model-prewarm-failed", {
        reason,
        engine: "local-rnnoise",
        aborted: controller.signal.aborted,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      window.clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abort);
    }
  })().finally(() => {
    krispModelAssetPrewarmPromise = null;
  });

  await krispModelAssetPrewarmPromise;
  return true;
}

function preconnectToUrl(urlString: string | undefined, key: string) {
  if (typeof document === "undefined" || !urlString) {
    return;
  }

  try {
    const url = new URL(urlString, window.location.href);
    const href =
      url.protocol === "wss:" || url.protocol === "ws:"
        ? `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`
        : url.origin;

    if (document.querySelector(`link[data-sovchat-preconnect="${key}"]`)) {
      return;
    }

    const dnsPrefetch = document.createElement("link");
    dnsPrefetch.rel = "dns-prefetch";
    dnsPrefetch.href = `//${url.host}`;
    dnsPrefetch.dataset.sovchatPreconnect = `${key}:dns`;
    document.head.appendChild(dnsPrefetch);

    const preconnect = document.createElement("link");
    preconnect.rel = "preconnect";
    preconnect.href = href;
    preconnect.crossOrigin = "anonymous";
    preconnect.dataset.sovchatPreconnect = key;
    document.head.appendChild(preconnect);
  } catch {
    // Ignore invalid or unset development URLs.
  }
}

function buildProxiedKrispRegistry(registry: KrispModelRegistry) {
  const modelPaths = { ...(registry.modelPaths ?? {}) };

  for (const asset of KRISP_PROXY_MODEL_ASSETS) {
    modelPaths[asset] = getProxiedKrispAssetUrl(asset);
  }

  return {
    ...registry,
    modelPaths,
    bvcDevices: getProxiedKrispAssetUrl("bvcDevices")
  };
}

async function fetchKrispProxyWithDiagnostics(
  originalFetch: typeof fetch,
  input: RequestInfo | URL,
  init?: RequestInit
) {
  const requestUrl = getRequestUrl(input);
  const asset = requestUrl?.searchParams.get("asset") ?? undefined;
  const diagnostics = getKrispProxyUrlDiagnostics(requestUrl?.toString() ?? String(input), asset);

  try {
    const response = await originalFetch(input, init);
    recordAudioDiagnosticEvent("krisp-proxy-fetch-result", {
      ...diagnostics,
      status: response.status,
      ok: response.ok
    });
    return response;
  } catch (error) {
    recordAudioDiagnosticEvent("krisp-proxy-fetch-error", {
      ...diagnostics,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

async function withKrispModelProxy<T>(task: () => Promise<T>) {
  if (typeof window === "undefined" || typeof window.fetch !== "function") {
    return await task();
  }

  if (krispFetchProxyDepth === 0) {
    originalKrispFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const originalFetch = originalKrispFetch ?? window.fetch.bind(window);
      const requestUrl = getRequestUrl(input);

      if (isKrispModelRegistryRequest(input)) {
        recordAudioDiagnosticEvent("krisp-model-registry-proxied", {
          runtime: getKrispRuntimeKind(),
          backendApiBase: getKrispBackendApiBase(),
          directIntegrationsRequestIntercepted: true,
          directNetworkRequest: false,
          registryUrl: requestUrl?.toString() ?? KRISP_MODEL_REGISTRY_URL
        });
        return new Response(JSON.stringify(buildProxiedKrispRegistry({})), {
          status: 200,
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "application/json"
          }
        });
      }

      if (isSovChatKrispProxyRequest(input)) {
        return await fetchKrispProxyWithDiagnostics(originalFetch, input, init);
      }

      if (isLiveKitKrispIntegrationRequest(input)) {
        recordAudioDiagnosticEvent("krisp-direct-livekit-fetch-attempted", {
          runtime: getKrispRuntimeKind(),
          url: requestUrl?.toString() ?? "https://integrations.livekit.io",
          proxied: false,
          blocked: true
        });
        return new Response(JSON.stringify({ error: "Direct Krisp integration fetch blocked." }), {
          status: 502,
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "application/json"
          }
        });
      }

      return await originalFetch(input, init);
    };
  }

  krispFetchProxyDepth += 1;

  try {
    return await task();
  } finally {
    krispFetchProxyDepth = Math.max(0, krispFetchProxyDepth - 1);

    if (krispFetchProxyDepth === 0 && originalKrispFetch) {
      window.fetch = originalKrispFetch;
      originalKrispFetch = null;
    }
  }
}

type TimedAudioOperationResult<T> =
  | { status: "ok"; value: T }
  | { status: "timeout" }
  | { status: "error"; error: unknown };

function runTimedAudioOperation<T>(
  operation: Promise<T>,
  timeoutMs: number,
  eventName: string,
  details: Record<string, unknown> = {}
): Promise<TimedAudioOperationResult<T>> {
  let settled = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      recordAudioDiagnosticEvent(eventName, {
        ...details,
        timeoutMs
      });
      resolve({ status: "timeout" });
    }, timeoutMs);

    operation
      .then((value) => {
        if (settled) {
          return;
        }

        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        resolve({ status: "ok", value });
      })
      .catch((error) => {
        if (settled) {
          return;
        }

        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        resolve({ status: "error", error });
    });
  });
}

type JoinStage = "token" | "connect" | "audio-playback" | "audio-ready";

class JoinStageTimeoutError extends Error {
  constructor(
    readonly stage: JoinStage,
    readonly timeoutMs: number
  ) {
    super(getJoinStageTimeoutMessage(stage, timeoutMs));
    this.name = "JoinStageTimeoutError";
  }
}

class JoinCancelledError extends Error {
  constructor() {
    super("Voice connection cancelled.");
    this.name = "JoinCancelledError";
  }
}

function getJoinStageTimeoutMessage(stage: JoinStage, timeoutMs: number) {
  const seconds = Math.round(timeoutMs / 1000);

  switch (stage) {
    case "token":
      return `Voice connection timed out while waiting for SovChat to issue a LiveKit token after ${seconds}s. The server may be restarting or unreachable.`;
    case "connect":
      return `Voice connection timed out while connecting to LiveKit after ${seconds}s.`;
    case "audio-playback":
      return `Voice connected, but audio playback did not become ready after ${seconds}s.`;
    case "audio-ready":
      return `Voice connected, but microphone/audio setup did not finish after ${seconds}s.`;
  }
}

function isJoinCancelledError(error: unknown) {
  return error instanceof JoinCancelledError;
}

function isAbortError(error: unknown) {
  return (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError"
  ) || (
    error instanceof Error && error.name === "AbortError"
  );
}

function runTimedJoinOperation<T>(
  operation: Promise<T>,
  stage: JoinStage,
  timeoutMs: number,
  details: Record<string, unknown> = {},
  onTimeout?: () => void
): Promise<T> {
  const startedAt = getPerformanceNow();
  let settled = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      onTimeout?.();
      recordAudioDiagnosticEvent("voice-join-stage-timeout", {
        ...details,
        stage,
        timeoutMs
      });
      recordPerformanceTiming("voice.join.stage", startedAt, {
        ...details,
        stage,
        status: "timeout",
        timeoutMs
      });
      reject(new JoinStageTimeoutError(stage, timeoutMs));
    }, timeoutMs);

    operation
      .then((value) => {
        if (settled) {
          return;
        }

        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        recordPerformanceTiming("voice.join.stage", startedAt, {
          ...details,
          stage,
          status: "success"
        });
        resolve(value);
      })
      .catch((error) => {
        if (settled) {
          return;
        }

        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        recordPerformanceTiming("voice.join.stage", startedAt, {
          ...details,
          stage,
          status: isAbortError(error) ? "aborted" : "error",
          ...getLiveKitErrorDetails(error)
        });
        reject(error);
      });
  });
}

const DEMO_IGN_POOL = [
  "ShadowVex",
  "SniperKid",
  "GhostRush",
  "ToxicByte",
  "ClutchOps",
  "ReaperX",
  "SavageAim",
  "FrostZX",
  "BlazeKid",
  "ViperMain",
  "RogueShot",
  "StormPulse",
  "HexScope",
  "VenomYT",
  "TurboLive",
  "NightHunter",
  "SkullTV",
  "NovaStrike",
  "ChaosPlays",
  "DriftAce",
  "FlameBurst",
  "WraithGG",
  "PixelRaider",
  "ZeroChill",
  "FragDaddy",
  "NoScopez",
  "QuickPeek",
  "TiltProof",
  "Respawned",
  "CrackedAF"
] as const;
const DEMO_USER_COUNT = 8;

function createDemoSeedNames(count: number) {
  const names = new Set<string>();
  let seed = Date.now() % 9973;

  while (names.size < count) {
    seed = (seed * 48271 + 31) % 2147483647;
    const ign = DEMO_IGN_POOL[seed % DEMO_IGN_POOL.length];
    names.add(ign);
  }

  return Array.from(names);
}

const GENERATED_DEMO_NAMES = createDemoSeedNames(DEMO_USER_COUNT);
const DEMO_VOICE_USERS: DemoStageUser[] = [
  { identity: GENERATED_DEMO_NAMES[0], isAfk: true },
  { identity: GENERATED_DEMO_NAMES[1], isSelfMuted: true },
  { identity: GENERATED_DEMO_NAMES[2], isStreaming: true },
  { identity: GENERATED_DEMO_NAMES[3], isThirdPartyMuted: true },
  { identity: GENERATED_DEMO_NAMES[4], isSelfMuted: true, isSelfDeafened: true }
];
const DEMO_LOBBY_USERS: DemoStageUser[] = [
  { identity: GENERATED_DEMO_NAMES[5] },
  { identity: GENERATED_DEMO_NAMES[6] },
  { identity: GENERATED_DEMO_NAMES[7] }
];
const DEMO_AFK_IDENTITIES = new Set(
  [...DEMO_VOICE_USERS, ...DEMO_LOBBY_USERS]
    .filter((user) => user.isAfk)
    .map((user) => user.identity)
);
const DEMO_PRIMARY_SPEAKER_IDENTITY = DEMO_VOICE_USERS[0]?.identity ?? "Seeded Speaker";
const DEMO_STREAM_PLACEHOLDERS = new Set(
  DEMO_VOICE_USERS.filter((user) => user.isStreaming).map((user) => user.identity)
);
const SEEDED_AVATAR_IDENTITIES = [...DEMO_VOICE_USERS, ...DEMO_LOBBY_USERS].map(
  (user) => user.identity
);
const SEEDED_AVATAR_SOURCES = new Map(
  SEEDED_AVATAR_IDENTITIES.map((identity, index) => [identity, `/avatars/avatar-${index + 1}.png`])
);
const DEMO_PRESET_THIRD_PARTY_MUTED_IDS = new Set(
  DEMO_VOICE_USERS.filter((user) => user.isThirdPartyMuted).map((user) => user.identity)
);
const VOICE_RING_BAR_BASE = [0.74, 1.14, 0.89, 1.42, 0.7, 1.27, 0.84, 1.5] as const;
const VOICE_RING_BAR_WAVE = [0.34, 0.52, 0.88, 1.16, 1.28, 0.96, 0.62, 0.4] as const;
const VOICE_RING_BAR_REACTIVITY = [0.7, 1.14, 0.82, 1.56, 0.64, 1.28, 0.78, 1.72] as const;
const VOICE_RING_BARS = Array.from({ length: RING_BAR_COUNT }, (_, index) => ({
  key: index,
  style: {
    "--rotation": `${(360 / RING_BAR_COUNT) * index}deg`,
    "--delay": `${index * -70}ms`,
    "--bar-base": VOICE_RING_BAR_BASE[index % VOICE_RING_BAR_BASE.length],
    "--bar-wave": VOICE_RING_BAR_WAVE[index % VOICE_RING_BAR_WAVE.length],
    "--bar-reactivity": VOICE_RING_BAR_REACTIVITY[index % VOICE_RING_BAR_REACTIVITY.length]
  } as CSSProperties
}));

const SCREEN_SHARE_FOCUSED_DIMENSIONS = {
  width: 1920,
  height: 1080
};

type ScreenShareProfile = {
  capture: ScreenShareCaptureOptions;
  videoPublish: TrackPublishOptions;
  audioPublish: TrackPublishOptions;
  sender: {
    maxBitrate: number;
    degradationPreference: RTCDegradationPreference;
    maxFramerate: number;
  };
};

function getScreenShareProfile(mode: StreamQualityMode): ScreenShareProfile {
  const profile = STREAM_QUALITY_PROFILES[mode];

  return {
    capture: {
      audio: true,
      resolution: {
        width: profile.width,
        height: profile.height,
        frameRate: profile.frameRate
      },
      contentHint: profile.contentHint,
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
      systemAudio: "include"
    },
    videoPublish: {
      source: Track.Source.ScreenShare,
      simulcast: false,
      screenShareEncoding: {
        maxBitrate: profile.maxBitrate,
        maxFramerate: profile.frameRate
      },
      screenShareSimulcastLayers: [],
      videoCodec: profile.codec,
      degradationPreference: profile.degradationPreference
    },
    audioPublish: {
      ...SCREEN_SHARE_AUDIO_PUBLISH_OPTIONS
    },
    sender: {
      maxBitrate: profile.maxBitrate,
      degradationPreference: profile.degradationPreference,
      maxFramerate: profile.frameRate
    }
  };
}

function getScreenShareAudioConstraints(): DisplayAudioConstraints {
  const supportedConstraints =
    typeof navigator !== "undefined" && navigator.mediaDevices?.getSupportedConstraints
      ? navigator.mediaDevices.getSupportedConstraints()
      : {};

  const constraints: DisplayAudioConstraints = {
    autoGainControl: false,
    echoCancellation: false,
    noiseSuppression: false,
    channelCount: 2
  };

  if (supportedConstraints.restrictOwnAudio) {
    constraints.restrictOwnAudio = true;
  }

  if (supportedConstraints.suppressLocalAudioPlayback) {
    constraints.suppressLocalAudioPlayback = false;
  }

  return constraints;
}

function getConcreteDeviceId(deviceId: string) {
  return deviceId === "default" ? "" : deviceId;
}

function getMediaDeviceConstraintId(deviceId: string) {
  return getConcreteDeviceId(deviceId) || undefined;
}

function getAudioErrorName(caughtError: unknown) {
  return getLiveKitErrorDetails(caughtError).errorName ?? "";
}

function getAudioErrorMessage(caughtError: unknown) {
  return getLiveKitErrorMessage(caughtError, "Unknown audio error.");
}

function isLinuxAudioRuntime() {
  return typeof navigator !== "undefined" && /Linux/iu.test(navigator.userAgent);
}

async function recordVoiceJoinEnvironment(attemptId: number) {
  const mediaDevicesAvailable = Boolean(navigator.mediaDevices);
  let audioInputCount = 0;
  let audioOutputCount = 0;
  let permissionGranted = false;
  let permissionDenied = false;
  let permissionPrompt = false;

  try {
    const devices = await navigator.mediaDevices?.enumerateDevices?.();
    audioInputCount = devices?.filter((device) => device.kind === "audioinput").length ?? 0;
    audioOutputCount = devices?.filter((device) => device.kind === "audiooutput").length ?? 0;
  } catch {
    // Device enumeration is diagnostic-only and must never block joining voice.
  }

  try {
    const permission = await navigator.permissions?.query({ name: "microphone" as PermissionName });
    permissionGranted = permission?.state === "granted";
    permissionDenied = permission?.state === "denied";
    permissionPrompt = permission?.state === "prompt";
  } catch {
    // Chromium versions differ in microphone permission-query support.
  }

  recordAudioDiagnosticEvent("voice-join-environment", {
    attemptId,
    isDesktop: Boolean(getDesktopBridge()?.isDesktop),
    isLinux: isLinuxAudioRuntime(),
    isWindows: typeof navigator !== "undefined" && /Windows/iu.test(navigator.userAgent),
    mediaDevicesAvailable,
    secureContext: window.isSecureContext,
    audioInputCount,
    audioOutputCount,
    permissionGranted,
    permissionDenied,
    permissionPrompt
  });
}

function isSelectedInputDeviceFailure(caughtError: unknown) {
  const name = getAudioErrorName(caughtError).toLowerCase();
  const message = getAudioErrorMessage(caughtError).toLowerCase();

  return (
    name === "notfounderror" ||
    name === "devicesnotfounderror" ||
    name === "overconstrainederror" ||
    name === "constraintnotfounderror" ||
    name === "constraintnotsatisfiederror" ||
    name === "notreadableerror" ||
    name === "trackstarterror" ||
    message.includes("not found") ||
    message.includes("overconstrained") ||
    message.includes("constraint") ||
    message.includes("device unavailable") ||
    message.includes("could not start audio source")
  );
}

function SleepStatusIcon() {
  return (
    <svg
      className="voice-pill-sleep-icon"
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <g fill="currentColor">
        <path
          className="voice-pill-sleep-z voice-pill-sleep-z-large"
          d="M1 6h8v1.55L4.25 12H9v2H1v-1.55L5.75 8H1V6Z"
        />
        <path
          className="voice-pill-sleep-z voice-pill-sleep-z-small"
          d="M9.5 1h6v1.25L12.1 6h3.4v1.5h-6V6.25l3.4-3.75H9.5V1Z"
        />
      </g>
    </svg>
  );
}

function VoiceChannelGlyph({ connected }: { connected: boolean }) {
  return (
    <OmarchyGlyph
      kind="voice"
      className={cn("omarchy-mode-icon h-10 w-10", connected && "voice-channel-glyph-connected")}
    />
  );
}

function UpdateInstallHourglass() {
  return (
    <div className="voice-update-install-context" role="status" aria-live="polite">
      <div className="voice-update-hourglass" aria-hidden="true">
        <span className="voice-update-hourglass-frame voice-update-hourglass-frame-top" />
        <span className="voice-update-hourglass-frame voice-update-hourglass-frame-bottom" />
        <span className="voice-update-hourglass-neck" />
        <span className="voice-update-hourglass-sand voice-update-hourglass-sand-top" />
        <span className="voice-update-hourglass-sand voice-update-hourglass-sand-bottom" />
        <span className="voice-update-hourglass-stream" />
      </div>
      <div className="voice-update-install-title">
        Please wait while we install this update
      </div>
      <div className="voice-update-install-copy">
        SovChat will restart automatically.
      </div>
    </div>
  );
}

const VoiceRing = memo(function VoiceRing({
  ringRef
}: {
  ringRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div ref={ringRef} className="voice-ring" aria-hidden="true" style={{ "--voice-energy": "0.000" } as CSSProperties}>
      {VOICE_RING_BARS.map((bar) => (
        <span key={bar.key} className="voice-ring-spoke" style={bar.style}>
          <span className="voice-ring-bar" />
        </span>
      ))}
    </div>
  );
});

const StreamVolumeControl = memo(function StreamVolumeControl({
  outputMuted,
  outputVolume,
  onToggleOutputMuted,
  onOutputVolumeChange,
  className
}: {
  outputMuted: boolean;
  outputVolume: number;
  onToggleOutputMuted: () => void;
  onOutputVolumeChange: (nextVolume: number) => void;
  className?: string;
}) {
  const clampedOutputVolume = getClampedGainVolume(outputVolume, MAX_STREAM_VOLUME_PERCENT);
  const sliderFill = getStreamVolumePercent(clampedOutputVolume);
  const tooltipLeft = `calc(${sliderFill}% + ${(0.5 - sliderFill / 100) * 18}px)`;

  return (
    <div className={cn("flex items-center gap-3", className)}>
      <button
        type="button"
        onClick={onToggleOutputMuted}
        className="ui-button stream-stage-icon-button inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white"
        aria-label={outputMuted ? "Unmute stream audio" : "Mute stream audio"}
        title={outputMuted ? "Unmute stream audio" : "Mute stream audio"}
      >
        {outputMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
      </button>
      <div className="relative flex-1 px-1 pt-1">
        <div
          className="pointer-events-none absolute bottom-[calc(100%+8px)] z-10 -translate-x-1/2 rounded-[10px] bg-[#1b272a] px-2 py-1 text-[11px] leading-none text-[#f4f7f7eb] opacity-0 shadow-[0_10px_24px_rgba(0,0,0,0.2)] transition-opacity duration-150 peer-hover:opacity-100 peer-focus-within:opacity-100"
          style={{ left: tooltipLeft }}
        >
          {Math.round(clampedOutputVolume * 100)}%
        </div>
        <input
          type="range"
          min={0}
          max={MAX_STREAM_VOLUME_PERCENT}
          value={Math.round(clampedOutputVolume * 100)}
          onChange={(event) => onOutputVolumeChange(Number(event.target.value) / 100)}
          className="peer h-[8px] w-full cursor-pointer appearance-none rounded-full bg-[linear-gradient(90deg,var(--accent)_0,var(--accent)_var(--slider-fill),rgba(36,53,58,0.96)_var(--slider-fill),rgba(36,53,58,0.96)_100%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_0_0_1px_rgba(255,255,255,0.08)] [&::-webkit-slider-thumb]:h-[18px] [&::-webkit-slider-thumb]:w-[18px] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-0 [&::-webkit-slider-thumb]:bg-[var(--accent)] [&::-webkit-slider-thumb]:shadow-[0_8px_18px_rgba(255,202,42,0.28),0_0_0_5px_rgba(255,202,42,0.08)] [&::-moz-range-thumb]:h-[18px] [&::-moz-range-thumb]:w-[18px] [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-[var(--accent)] [&::-moz-range-thumb]:shadow-[0_8px_18px_rgba(255,202,42,0.28),0_0_0_5px_rgba(255,202,42,0.08)] [&::-moz-range-track]:h-[8px] [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-[rgba(36,53,58,0.96)]"
          style={{ "--slider-fill": `${sliderFill}%` } as CSSProperties}
          aria-label="Stream volume"
        />
      </div>
    </div>
  );
});

function formatNullableNumber(value: number | null, suffix = "") {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)}${suffix}` : "-";
}

function monitorVideoRenderFps(
  element: HTMLVideoElement,
  onUpdate: (fps: number | null) => void
) {
  if (typeof element.requestVideoFrameCallback !== "function") {
    onUpdate(null);
    return () => undefined;
  }

  let cancelled = false;
  let baselineTime = performance.now();
  let baselineFrames: number | null = null;
  let fallbackFrames = 0;
  let callbackId = 0;

  const handleFrame: VideoFrameRequestCallback = (now, metadata) => {
    if (cancelled) {
      return;
    }

    const presentedFrames =
      typeof metadata.presentedFrames === "number" ? metadata.presentedFrames : null;

    if (baselineFrames === null) {
      baselineFrames = presentedFrames ?? 0;
      fallbackFrames = 0;
      baselineTime = now;
    } else {
      fallbackFrames += 1;
    }

    const elapsedMs = now - baselineTime;
    if (elapsedMs >= 1000) {
      const frameDelta =
        presentedFrames !== null && baselineFrames !== null
          ? presentedFrames - baselineFrames
          : fallbackFrames;

      onUpdate(Math.max(0, (frameDelta * 1000) / elapsedMs));
      baselineFrames = presentedFrames ?? 0;
      fallbackFrames = 0;
      baselineTime = now;
    }

    callbackId = element.requestVideoFrameCallback(handleFrame);
  };

  callbackId = element.requestVideoFrameCallback(handleFrame);

  return () => {
    cancelled = true;
    element.cancelVideoFrameCallback?.(callbackId);
    onUpdate(null);
  };
}

const StreamStatsBadge = memo(function StreamStatsBadge({
  stats,
  className
}: {
  stats: StreamStatsSnapshot | null;
  className?: string;
}) {
  if (!stats) {
    return null;
  }

  const size = stats.width && stats.height ? `${stats.width}x${stats.height}` : "-";
  const qualityReason =
    stats.qualityLimitationReason && stats.qualityLimitationReason !== "none"
      ? stats.qualityLimitationReason
      : "ok";

  return (
    <div
      className={cn(
        "pointer-events-none absolute left-3 top-3 z-20 rounded-lg border border-white/10 bg-[rgba(8,14,16,0.74)] px-3 py-2 font-mono text-[10px] leading-4 text-white/78 shadow-[0_12px_28px_rgba(0,0,0,0.28)] backdrop-blur-md",
        className
      )}
    >
      <div className="mb-1 font-sans text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--accent)]">
        {stats.direction === "send" ? "Sending" : "Receiving"} {STREAM_QUALITY_LABELS[stats.mode]}
      </div>
      <div>size {size}</div>
      <div>fps {formatNullableNumber(stats.fps)}</div>
      <div>render {formatNullableNumber(stats.renderFps)}</div>
      <div>bitrate {formatNullableNumber(stats.bitrateKbps, " kbps")}</div>
      <div>target {formatNullableNumber(stats.targetBitrateKbps, " kbps")}</div>
      <div>limit {qualityReason}</div>
      {stats.codec ? <div>codec {stats.codec}</div> : null}
      {stats.roundTripMs !== null ? <div>rtt {formatNullableNumber(stats.roundTripMs, " ms")}</div> : null}
      {stats.jitterMs !== null ? <div>jitter {formatNullableNumber(stats.jitterMs, " ms")}</div> : null}
    </div>
  );
});

const StreamControllerDock = memo(function StreamControllerDock({
  outputMuted,
  outputVolume,
  canPopOut,
  isFullscreen,
  isStreamPoppedOut,
  onToggleOutputMuted,
  onOutputVolumeChange,
  onToggleFullscreen,
  onPopOut,
  onPopBackIn,
  onStopWatching,
  onMouseEnter,
  className
}: {
  outputMuted: boolean;
  outputVolume: number;
  canPopOut: boolean;
  isFullscreen: boolean;
  isStreamPoppedOut: boolean;
  onToggleOutputMuted: () => void;
  onOutputVolumeChange: (nextVolume: number) => void;
  onToggleFullscreen: () => void;
  onPopOut: () => void;
  onPopBackIn: () => void;
  onStopWatching: () => void;
  onMouseEnter?: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "stream-controller-dock pointer-events-auto flex items-center gap-3 rounded-xl border border-white/10 bg-[rgba(12,20,23,0.82)] px-4 py-3 text-white shadow-[0_18px_42px_rgba(0,0,0,0.34),inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-xl",
        className
      )}
      onMouseEnter={onMouseEnter}
    >
      <StreamVolumeControl
        outputMuted={outputMuted}
        outputVolume={outputVolume}
        onToggleOutputMuted={onToggleOutputMuted}
        onOutputVolumeChange={onOutputVolumeChange}
        className="min-w-[180px] flex-1"
      />
      <div className="flex items-center gap-2">
        <HoverTooltip label={isFullscreen ? "Leave full screen" : "Enter full screen"}>
          <button
            type="button"
            onClick={onToggleFullscreen}
            className="ui-button stream-stage-icon-button inline-flex h-10 w-10 items-center justify-center rounded-full text-white"
            aria-label={isFullscreen ? "Leave full screen" : "Enter full screen"}
          >
            {isFullscreen ? <Minimize className="h-4 w-4" /> : <Expand className="h-4 w-4" />}
          </button>
        </HoverTooltip>
        {isStreamPoppedOut ? (
          <HoverTooltip label="Return stream to stage">
            <button
              type="button"
              onClick={onPopBackIn}
              className="ui-button stream-stage-icon-button inline-flex h-10 w-10 items-center justify-center rounded-full text-white"
              aria-label="Return stream to stage"
            >
              <Dock className="h-4 w-4" />
            </button>
          </HoverTooltip>
        ) : (
          <HoverTooltip label="Open stream in popout">
            <button
              type="button"
              onClick={onPopOut}
              disabled={!canPopOut}
              className="ui-button stream-stage-icon-button inline-flex h-10 w-10 items-center justify-center rounded-full text-white disabled:cursor-not-allowed disabled:opacity-45"
              aria-label="Open stream in popout"
            >
              <PictureInPicture2 className="h-4 w-4" />
            </button>
          </HoverTooltip>
        )}
        <HoverTooltip label="Stop watching stream">
          <button
            type="button"
            onClick={onStopWatching}
            className="ui-button stream-stage-icon-button inline-flex h-10 w-10 items-center justify-center rounded-full text-white"
            aria-label="Stop watching stream"
          >
            <X className="h-4 w-4" />
          </button>
        </HoverTooltip>
      </div>
    </div>
  );
});

const StreamViewerOverlay = memo(function StreamViewerOverlay({
  isOpen,
  selectedStreamLabel,
  selectedStreamIsPlaceholder,
  selectedStreamIsPending,
  isRemoteFullscreen,
  isStreamPoppedOut,
  outputMuted,
  outputVolume,
  showStreamStats,
  streamStats,
  onClose,
  onPopOut,
  onPopBackIn,
  onToggleOutputMuted,
  onOutputVolumeChange,
  onToggleRemoteFullscreen,
  fullscreenStreamStageRef,
  fullscreenScreenContainerRef
}: {
  isOpen: boolean;
  selectedStreamLabel: string | null;
  selectedStreamIsPlaceholder: boolean;
  selectedStreamIsPending: boolean;
  isRemoteFullscreen: boolean;
  isStreamPoppedOut: boolean;
  outputMuted: boolean;
  outputVolume: number;
  showStreamStats: boolean;
  streamStats: StreamStatsSnapshot | null;
  onClose: () => void;
  onPopOut: () => void;
  onPopBackIn: () => void;
  onToggleOutputMuted: () => void;
  onOutputVolumeChange: (nextVolume: number) => void;
  onToggleRemoteFullscreen: () => void;
  fullscreenStreamStageRef: RefObject<HTMLDivElement | null>;
  fullscreenScreenContainerRef: RefObject<HTMLDivElement | null>;
}) {
  const [dockVisible, setDockVisible] = useState(true);
  const dockHideTimeoutRef = useRef(0);
  const canPopOut = !selectedStreamIsPlaceholder && !selectedStreamIsPending;

  const showFullscreenDock = useCallback(() => {
    setDockVisible(true);
    if (dockHideTimeoutRef.current) {
      window.clearTimeout(dockHideTimeoutRef.current);
    }

    dockHideTimeoutRef.current = window.setTimeout(() => {
      setDockVisible(false);
      dockHideTimeoutRef.current = 0;
    }, 3000);
  }, []);

  useEffect(() => {
    if (!isOpen || !isRemoteFullscreen) {
      if (dockHideTimeoutRef.current) {
        window.clearTimeout(dockHideTimeoutRef.current);
        dockHideTimeoutRef.current = 0;
      }
      setDockVisible(true);
      return;
    }

    showFullscreenDock();

    return () => {
      if (dockHideTimeoutRef.current) {
        window.clearTimeout(dockHideTimeoutRef.current);
        dockHideTimeoutRef.current = 0;
      }
    };
  }, [isOpen, isRemoteFullscreen, showFullscreenDock]);

  if (!isOpen || !selectedStreamLabel) {
    return null;
  }

  return (
    <AnimatePresence>
      <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center px-6 py-24">
        <motion.button
          type="button"
          onClick={onClose}
          className="pointer-events-auto absolute inset-0 bg-[rgba(5,10,12,0.42)] backdrop-blur-[2px]"
          aria-label="Close stream viewer"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
        />
        <motion.section
          className="pointer-events-auto w-full max-w-[860px] rounded-[1rem] border border-white/7 bg-[rgba(34,48,52,0.58)] px-4 py-4 shadow-[0_18px_50px_rgba(0,0,0,0.28),inset_0_1px_0_rgba(255,255,255,0.03)] backdrop-blur-xl"
          initial={{ opacity: 0, scale: 0.88, y: 18 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.92, y: 12 }}
          transition={{
            opacity: { duration: 0.2, ease: "easeOut" },
            scale: { type: "spring", stiffness: 320, damping: 24 },
            y: { type: "spring", stiffness: 280, damping: 26 }
          }}
        >
          <div className="mb-2 flex items-center justify-between gap-3 text-sm text-[var(--muted)]">
            <div className="flex items-center gap-2">
              <MonitorUp className="h-4 w-4 text-[var(--accent)]" />
              {selectedStreamLabel} is sharing
            </div>
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onToggleRemoteFullscreen}
                  className="ui-button stream-stage-action-button inline-flex items-center gap-2 rounded-xl px-3 py-2 text-white"
                >
                  {isRemoteFullscreen ? <Minimize className="h-4 w-4" /> : <Expand className="h-4 w-4" />}
                  {isRemoteFullscreen ? "Leave full screen" : "Full screen"}
                </button>
                <button
                  type="button"
                  onClick={onPopOut}
                  disabled={!canPopOut}
                  className="ui-button stream-stage-action-button inline-flex items-center gap-2 rounded-xl px-3 py-2 text-white disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <PictureInPicture2 className="h-4 w-4" />
                  Pop out
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="ui-button stream-stage-action-button inline-flex items-center gap-2 rounded-xl px-3 py-2 text-white"
                >
                  <X className="h-4 w-4" />
                  Close
                </button>
              </div>
            </div>
          </div>
          <div className="mb-3 flex items-center gap-3 px-1">
            <div className="min-w-[52px] text-[11px] uppercase tracking-[0.24em] text-[var(--muted)]">
              Audio
            </div>
            <StreamVolumeControl
              outputMuted={outputMuted}
              outputVolume={outputVolume}
              onToggleOutputMuted={onToggleOutputMuted}
              onOutputVolumeChange={onOutputVolumeChange}
              className="min-w-0 flex-1"
            />
          </div>
          <div
            ref={fullscreenStreamStageRef}
            className="relative h-[42vh] min-h-[280px] w-full overflow-hidden rounded-[1.1rem]"
            onMouseMove={isRemoteFullscreen ? showFullscreenDock : undefined}
          >
            {showStreamStats ? <StreamStatsBadge stats={streamStats} /> : null}
            {selectedStreamIsPlaceholder ? (
              <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[1.1rem] border border-white/8 bg-[radial-gradient(circle_at_25%_20%,rgba(84,221,229,0.2),transparent_28%),radial-gradient(circle_at_78%_22%,rgba(255,202,42,0.16),transparent_26%),linear-gradient(180deg,rgba(16,27,31,0.96),rgba(13,21,24,0.98))]">
                <div className="absolute inset-0 bg-[linear-gradient(transparent_0%,transparent_78%,rgba(255,255,255,0.04)_78%,rgba(255,255,255,0.04)_79%,transparent_79%),linear-gradient(90deg,transparent_0%,transparent_82%,rgba(255,255,255,0.04)_82%,rgba(255,255,255,0.04)_83%,transparent_83%)] opacity-70" />
                <div className="relative flex max-w-[520px] flex-col items-center text-center">
                  <div className="mb-5 flex h-18 w-18 items-center justify-center rounded-[1.4rem] border border-[rgba(255,202,42,0.24)] bg-[rgba(255,202,42,0.08)] shadow-[0_18px_40px_rgba(0,0,0,0.2)]">
                    <PanelTop className="h-8 w-8 text-[var(--accent)]" />
                  </div>
                  <div className="text-[0.72rem] uppercase tracking-[0.32em] text-[var(--accent)]">
                    Demo Stream
                  </div>
                  <h3 className="mt-3 text-2xl font-semibold text-white">
                    Placeholder broadcast for {selectedStreamLabel}
                  </h3>
                  <p className="mt-3 max-w-[420px] text-sm leading-6 text-white/70">
                    This seeded streamer opens a placeholder stage so we can test the
                    stream-viewing flow before a live user starts an actual screen share.
                  </p>
                </div>
              </div>
            ) : selectedStreamIsPending ? (
              <div className="flex h-full w-full items-center justify-center rounded-[1.1rem] border border-white/8 bg-[linear-gradient(180deg,rgba(16,27,31,0.96),rgba(13,21,24,0.98))] text-center text-white/72">
                <div className="flex flex-col items-center gap-3">
                  <LoaderCircle className="h-7 w-7 animate-spin text-[var(--accent)]" />
                  <div className="text-sm">Waiting for {selectedStreamLabel}&apos;s stream…</div>
                </div>
              </div>
            ) : (
              <div
                ref={fullscreenScreenContainerRef}
                className="h-full w-full overflow-hidden rounded-[1.1rem]"
              />
            )}
            {isRemoteFullscreen ? (
              <StreamControllerDock
                outputMuted={outputMuted}
                outputVolume={outputVolume}
                canPopOut={canPopOut}
                isFullscreen={isRemoteFullscreen}
                isStreamPoppedOut={isStreamPoppedOut}
                onToggleOutputMuted={onToggleOutputMuted}
                onOutputVolumeChange={onOutputVolumeChange}
                onToggleFullscreen={onToggleRemoteFullscreen}
                onPopOut={onPopOut}
                onPopBackIn={onPopBackIn}
                onStopWatching={onClose}
                className={cn(
                  "absolute bottom-4 left-1/2 z-30 w-[min(calc(100vw_-_2rem),760px)] -translate-x-1/2 transition duration-200",
                  dockVisible ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0"
                )}
                onMouseEnter={showFullscreenDock}
              />
            ) : null}
          </div>
        </motion.section>
      </div>
    </AnimatePresence>
  );
});

const ScreenShareSourcePicker = memo(function ScreenShareSourcePicker({
  isOpen,
  isLoading,
  sources,
  compactMode,
  includeSystemAudio,
  systemAudioSupported,
  streamQualityMode,
  onToggleIncludeSystemAudio,
  onStreamQualityModeChange,
  onClose,
  onSelect
}: ScreenShareSourcePickerProps) {
  const [activeTab, setActiveTab] = useState<"window" | "screen" | "device">("window");
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const sourceCounts = useMemo(
    () => ({
      window: sources.filter((source) => source.kind === "window").length,
      screen: sources.filter((source) => source.kind === "screen").length,
      device: 0
    }),
    [sources]
  );
  const sourceTabs = [
    { id: "window", label: "Windows", count: sourceCounts.window },
    { id: "screen", label: "Screens", count: sourceCounts.screen },
    { id: "device", label: "Devices", count: sourceCounts.device }
  ] as const;
  const visibleSources = useMemo(
    () =>
      sources.filter((source) =>
        activeTab === "window" ? source.kind === "window" : activeTab === "screen" ? source.kind === "screen" : false
      ),
    [activeTab, sources]
  );
  const selectedSource =
    visibleSources.find((source) => source.id === selectedSourceId) ?? visibleSources[0] ?? null;
  const systemAudioChecked = systemAudioSupported && includeSystemAudio;

  useEffect(() => {
    if (!isOpen) {
      setSelectedSourceId(null);
      return;
    }

    setSelectedSourceId((currentId) => {
      if (currentId && visibleSources.some((source) => source.id === currentId)) {
        return currentId;
      }

      return visibleSources[0]?.id ?? null;
    });
  }, [isOpen, visibleSources]);

  useEffect(() => {
    if (
      isOpen &&
      !SCREEN_SHARE_PICKER_QUALITY_OPTIONS.some((mode) => mode === streamQualityMode)
    ) {
      onStreamQualityModeChange("720p");
    }
  }, [isOpen, onStreamQualityModeChange, streamQualityMode]);

  useEffect(() => {
    if (compactMode && activeTab === "device") {
      setActiveTab("window");
    }
  }, [activeTab, compactMode]);

  if (!isOpen) {
    return null;
  }

  if (compactMode) {
    return (
      <PrimaryPanelShell
        compact
        onClose={onClose}
        eyebrow="Go Live"
        title={null}
        closeLabel="Close screen share picker"
        bodyClassName="h-full min-h-0 overflow-hidden"
        widthClassName="h-full w-full"
      >
        <div className="compact-share-picker flex h-full min-h-0 flex-col overflow-hidden">
          <div
            className="grid h-11 shrink-0 grid-cols-2 border-b border-white/7 px-2"
            role="tablist"
            aria-label="Stream source type"
          >
            {sourceTabs.filter((tab) => tab.id !== "device").map((tab) => {
              const isActive = activeTab === tab.id;
              const Icon = tab.id === "window" ? PanelTop : Monitor;

              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    "relative flex min-w-0 items-center justify-center gap-2 text-xs font-semibold transition",
                    isActive ? "text-[var(--accent)]" : "text-white/48 hover:text-white/78"
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{tab.label}</span>
                  <span className={cn("text-[10px]", isActive ? "text-[var(--accent)]/70" : "text-white/28")}>
                    {tab.count}
                  </span>
                  {isActive ? <span className="absolute inset-x-3 bottom-0 h-0.5 bg-[var(--accent)]" /> : null}
                </button>
              );
            })}
          </div>

          <div className="compact-share-source-list min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-2">
            {isLoading ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-white/62">
                <LoaderCircle className="h-6 w-6 animate-spin text-[var(--accent)]" />
                <span className="text-xs">Finding windows and screens...</span>
              </div>
            ) : visibleSources.length === 0 ? (
              <div className="flex h-full items-center justify-center px-6 text-center">
                <div>
                  <div className="text-sm font-semibold text-white">No {activeTab === "screen" ? "screens" : "windows"} found</div>
                  <p className="mt-1.5 text-xs leading-5 text-white/48">
                    {activeTab === "screen"
                      ? "No display is currently available to capture."
                      : "Open a window, then reopen Go Live to refresh the list."}
                  </p>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {visibleSources.map((source) => {
                  const isSelected = selectedSource?.id === source.id;
                  const SourceIcon = source.kind === "screen" ? Monitor : PanelTop;

                  return (
                    <button
                      key={source.id}
                      type="button"
                      onClick={() => setSelectedSourceId(source.id)}
                      onDoubleClick={() => onSelect(source)}
                      className={cn(
                        "compact-share-source min-w-0 overflow-hidden rounded-md border text-left transition",
                        isSelected
                          ? "border-[var(--accent)] bg-[rgba(245,208,32,0.09)]"
                          : "border-white/8 bg-white/[0.025] hover:border-white/18 hover:bg-white/[0.045]"
                      )}
                      aria-pressed={isSelected}
                    >
                      <span className="relative flex aspect-video w-full items-center justify-center overflow-hidden bg-black/28">
                        {source.thumbnailDataUrl ? (
                          <img
                            src={source.thumbnailDataUrl}
                            alt=""
                            className="h-full w-full object-cover"
                            aria-hidden="true"
                          />
                        ) : (
                          <SourceIcon className="h-7 w-7 text-white/32" aria-hidden="true" />
                        )}
                        {isSelected ? (
                          <span className="absolute right-1.5 top-1.5 rounded bg-[var(--accent)] px-1.5 py-0.5 text-[9px] font-bold uppercase text-[#10211f]">
                            Selected
                          </span>
                        ) : null}
                      </span>
                      <span className="flex min-w-0 items-center gap-1.5 px-2 py-2">
                        {source.appIconDataUrl ? (
                          <img src={source.appIconDataUrl} alt="" className="h-3.5 w-3.5 shrink-0 rounded-[3px]" aria-hidden="true" />
                        ) : (
                          <SourceIcon className="h-3.5 w-3.5 shrink-0 text-white/38" aria-hidden="true" />
                        )}
                        <span className="truncate text-[11px] font-medium text-white/82">{source.name}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="compact-share-footer shrink-0 border-t border-white/8 bg-[rgba(14,32,36,0.98)] p-2.5">
            <div className="mb-2 flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-[9px] font-semibold uppercase tracking-[0.18em] text-white/32">Selected</span>
              <span className="truncate text-xs font-medium text-white/78">{selectedSource?.name ?? "Choose a source"}</span>
            </div>

            <div className="mb-2 flex items-center gap-2">
              <div className="grid min-w-0 flex-1 grid-cols-3 rounded-md bg-white/[0.045] p-0.5" aria-label="Stream resolution">
                {SCREEN_SHARE_PICKER_QUALITY_OPTIONS.map((mode) => {
                  const isActive = streamQualityMode === mode;

                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => onStreamQualityModeChange(mode)}
                      className={cn(
                        "h-7 rounded text-[10px] font-semibold transition",
                        isActive ? "bg-[rgba(245,208,32,0.2)] text-[var(--accent)]" : "text-white/42 hover:text-white/72"
                      )}
                      title={STREAM_QUALITY_DESCRIPTIONS[mode]}
                    >
                      {STREAM_QUALITY_LABELS[mode]}
                    </button>
                  );
                })}
              </div>

              <label
                className={cn(
                  "flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[10px] font-medium text-white/62",
                  systemAudioSupported ? "cursor-pointer bg-white/[0.04]" : "cursor-not-allowed opacity-45"
                )}
                title={systemAudioSupported ? "Include system audio" : "System audio capture is not available in the Omarchy app"}
              >
                <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Audio</span>
                <input
                  type="checkbox"
                  checked={systemAudioChecked}
                  disabled={!systemAudioSupported}
                  onChange={(event) => onToggleIncludeSystemAudio(event.target.checked)}
                  className="sr-only"
                />
                <span className={cn("relative h-4 w-7 rounded-full bg-white/12 transition", systemAudioChecked && "bg-[var(--accent)]")}>
                  <span className={cn("absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-white/82 transition", systemAudioChecked && "translate-x-3 bg-[#12292d]")} />
                </span>
              </label>
            </div>

            <button
              type="button"
              onClick={() => {
                if (selectedSource) {
                  onSelect(selectedSource);
                }
              }}
              disabled={!selectedSource || isLoading}
              className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-[var(--accent)] px-4 text-sm font-semibold text-[#10211f] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <MonitorUp className="h-4 w-4" aria-hidden="true" />
              Start sharing
            </button>
          </div>
        </div>
      </PrimaryPanelShell>
    );
  }

  return (
    <PrimaryPanelShell
      onClose={onClose}
      eyebrow="Screen Share"
      title={null}
      closeLabel="Close screen share picker"
      bodyClassName="h-full min-h-0 max-h-full overflow-hidden"
      headerClassName="pb-4"
      widthClassName="w-full max-w-[min(100%,80rem)]"
    >
      <div className="grid h-full min-h-0 grid-cols-1 overflow-hidden lg:grid-cols-[10.75rem_minmax(0,1fr)_18.75rem]">
        <aside className="border-b border-white/7 p-3 lg:border-b-0 lg:border-r">
          <div className="mb-3 px-2 text-[10px] font-semibold uppercase tracking-[0.28em] text-white/38">
            Source type
          </div>
          <div className="flex gap-2 overflow-x-auto lg:flex-col lg:overflow-visible" role="tablist" aria-label="Stream source type">
            {sourceTabs.map((tab) => {
              const isActive = activeTab === tab.id;
              const Icon = tab.id === "window" ? PanelTop : tab.id === "screen" ? Monitor : Dock;

              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    "flex h-10 min-w-[9.75rem] items-center justify-between gap-3 rounded-md px-3 text-sm transition lg:min-w-0",
                    isActive
                      ? "bg-[rgba(245,208,32,0.16)] text-white shadow-[inset_3px_0_0_var(--accent)]"
                      : "text-white/70 hover:bg-white/[0.04] hover:text-white"
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Icon
                      className={cn("h-4 w-4 shrink-0", isActive ? "text-[var(--accent)]" : "text-white/48")}
                      aria-hidden="true"
                    />
                    <span className="truncate">{tab.label}</span>
                  </span>
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[10px] font-semibold",
                      isActive ? "bg-[rgba(245,208,32,0.24)] text-[var(--accent)]" : "bg-white/8 text-white/42"
                    )}
                  >
                    {tab.count}
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        <div className="flex min-h-0 flex-col border-b border-white/7 lg:border-b-0 lg:border-r">
          <div className="grid grid-cols-[minmax(12rem,1.2fr)_minmax(12rem,1fr)_4rem] gap-4 border-b border-white/7 px-5 py-3 text-[10px] font-semibold uppercase tracking-[0.28em] text-white/34">
            <span>Source</span>
            <span>Title</span>
            <span>Res</span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {isLoading ? (
              <div className="flex h-full items-center justify-center">
              <div className="flex flex-col items-center gap-3 text-white/76">
                <LoaderCircle className="h-6 w-6 animate-spin text-[var(--accent)]" />
                <div className="text-sm">Scanning displays and windows...</div>
              </div>
            </div>
            ) : activeTab === "device" ? (
              <div className="flex h-full items-center justify-center px-6 text-center text-white/70">
                <div className="max-w-[420px]">
                  <div className="text-lg font-medium text-white">No device sources wired yet</div>
                  <p className="mt-2 text-sm leading-6">
                    Electron screen capture currently returns windows and displays. Devices can be added here once that input path is wired.
                  </p>
                </div>
              </div>
            ) : visibleSources.length === 0 ? (
              <div className="flex h-full items-center justify-center px-6 text-center text-white/70">
                <div className="max-w-[360px]">
                  <div className="text-lg font-medium text-white">No sources were found</div>
                  <p className="mt-2 text-sm leading-6">
                    Electron did not return any capturable {activeTab === "screen" ? "screens" : "windows"}.
                    Try opening a window and then retry sharing.
                  </p>
                </div>
              </div>
            ) : (
              <div className="py-1">
                {visibleSources.map((source) => {
                  const isSelected = selectedSource?.id === source.id;
                  const SourceIcon = source.kind === "screen" ? Monitor : PanelTop;

                  return (
                  <button
                    key={source.id}
                    type="button"
                    onClick={() => setSelectedSourceId(source.id)}
                    onDoubleClick={() => onSelect(source)}
                    className={cn(
                      "grid w-full grid-cols-[minmax(12rem,1.2fr)_minmax(12rem,1fr)_4rem] items-center gap-4 px-5 py-3 text-left transition",
                      isSelected
                        ? "bg-[rgba(245,208,32,0.12)] text-white shadow-[inset_3px_0_0_var(--accent)]"
                        : "text-white/72 hover:bg-white/[0.035] hover:text-white"
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <span className="flex h-8 w-10 shrink-0 items-center justify-center overflow-hidden rounded bg-black/24">
                        {source.thumbnailDataUrl ? (
                          <img
                            src={source.thumbnailDataUrl}
                            alt=""
                            className="h-full w-full object-cover"
                            aria-hidden="true"
                          />
                        ) : (
                          <SourceIcon className="h-4 w-4 text-white/48" aria-hidden="true" />
                        )}
                      </span>
                      {source.appIconDataUrl ? (
                        <img
                          src={source.appIconDataUrl}
                          alt=""
                          className="h-4 w-4 shrink-0 rounded-[4px]"
                          aria-hidden="true"
                        />
                      ) : (
                        <SourceIcon className="h-4 w-4 shrink-0 text-white/48" aria-hidden="true" />
                      )}
                      <span className="truncate text-sm font-medium">{source.name}</span>
                    </span>
                    <span className="truncate font-mono text-xs text-white/58">
                      {source.kind === "screen" ? source.displayId ?? "Display" : source.name}
                    </span>
                    <span className="font-mono text-xs text-white/36">-</span>
                  </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <aside className="flex min-h-[26rem] flex-col p-5">
          <div className="mb-4 text-[10px] font-semibold uppercase tracking-[0.28em] text-white/38">
            Preview
          </div>
          <div className="overflow-hidden rounded-md border border-white/8 bg-black/32">
            <div className="flex aspect-video items-center justify-center">
              {selectedSource?.thumbnailDataUrl ? (
                <img
                  src={selectedSource.thumbnailDataUrl}
                  alt={`${selectedSource.name} preview`}
                  className="h-full w-full object-contain"
                />
              ) : selectedSource ? (
                <Monitor className="h-10 w-10 text-white/42" aria-hidden="true" />
              ) : (
                <div className="px-4 text-center text-sm text-white/42">Select a source</div>
              )}
            </div>
          </div>

          <div className="mt-3 min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-white">
              {selectedSource?.appIconDataUrl ? (
                <img
                  src={selectedSource.appIconDataUrl}
                  alt=""
                  className="h-4 w-4 shrink-0 rounded-[4px]"
                  aria-hidden="true"
                />
              ) : selectedSource?.kind === "screen" ? (
                <Monitor className="h-4 w-4 shrink-0 text-[var(--accent)]" aria-hidden="true" />
              ) : (
                <PanelTop className="h-4 w-4 shrink-0 text-[var(--accent)]" aria-hidden="true" />
              )}
              <span className="truncate">{selectedSource?.name ?? "No source selected"}</span>
            </div>
            <div className="mt-1 truncate font-mono text-[11px] text-white/42">
              {selectedSource
                ? selectedSource.kind === "screen"
                  ? selectedSource.displayId ?? "Display capture"
                  : "Window capture"
                : "Choose a source to broadcast."}
            </div>
          </div>

          <div className="mt-6 border-t border-white/7 pt-4">
            <div className="mb-4 text-[10px] font-semibold uppercase tracking-[0.28em] text-white/38">
              Stream settings
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm text-white">Resolution</div>
                <div className="inline-flex rounded-md bg-white/[0.045] p-1" aria-label="Stream resolution">
                  {SCREEN_SHARE_PICKER_QUALITY_OPTIONS.map((mode) => {
                    const isActive = streamQualityMode === mode;

                    return (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => onStreamQualityModeChange(mode)}
                        className={cn(
                          "rounded px-2 py-1 text-[11px] font-semibold transition",
                          isActive
                            ? "bg-[rgba(245,208,32,0.22)] text-[var(--accent)]"
                            : "text-white/50 hover:bg-white/8 hover:text-white"
                        )}
                        title={STREAM_QUALITY_DESCRIPTIONS[mode]}
                      >
                        {STREAM_QUALITY_LABELS[mode]}
                      </button>
                    );
                  })}
                </div>
              </div>

              <label
                className={cn(
                  "flex items-center justify-between gap-3 text-sm text-white transition",
                  systemAudioSupported ? "cursor-pointer" : "cursor-not-allowed opacity-52"
                )}
                title={
                  systemAudioSupported
                    ? "Include system audio"
                    : "System audio capture is not available in the Omarchy app"
                }
              >
                <span>System audio</span>
                <input
                  type="checkbox"
                  checked={systemAudioChecked}
                  disabled={!systemAudioSupported}
                  onChange={(event) => onToggleIncludeSystemAudio(event.target.checked)}
                  className="sr-only"
                />
                <span
                  className={cn(
                    "relative h-5 w-9 rounded-full bg-white/12 shadow-[inset_0_1px_2px_rgba(0,0,0,0.3)] transition",
                    systemAudioChecked && "bg-[rgba(245,208,32,0.86)]"
                  )}
                >
                  <span
                    className={cn(
                      "absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white/88 shadow-[0_2px_6px_rgba(0,0,0,0.28)] transition",
                      systemAudioChecked && "translate-x-4 bg-[#12292d]"
                    )}
                  />
                </span>
              </label>
            </div>
          </div>

          <div className="mt-auto flex items-center gap-2 pt-6">
            <button
              type="button"
              onClick={onClose}
              className="ui-button inline-flex h-10 flex-1 items-center justify-center rounded-full px-4 text-sm font-medium text-white/82 transition hover:bg-white/7 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                if (selectedSource) {
                  onSelect(selectedSource);
                }
              }}
              disabled={!selectedSource || isLoading}
              className="inline-flex h-10 flex-[1.55] items-center justify-center rounded-full bg-[var(--accent)] px-4 text-sm font-semibold text-[#10211f] shadow-[0_10px_28px_rgba(245,208,32,0.16)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
            >
              Start sharing
            </button>
          </div>
        </aside>
      </div>
    </PrimaryPanelShell>
  );
});

const VoiceStagePill = memo(function VoiceStagePill({
  user,
  nickname,
  localAvatarSrc,
  position,
  hasPlayedEntry,
  lockVerticalMotion,
  suppressLayoutMotion,
  reduceMotion,
  setPillLayoutWidths,
  onToggleThirdPartyMute,
  onParticipantVolumeChange,
  onWhisperParticipant,
  onInspectStream
}: {
  user: StageUser;
  nickname: string;
  localAvatarSrc?: string;
  position: PillPosition;
  hasPlayedEntry: boolean;
  lockVerticalMotion: boolean;
  suppressLayoutMotion: boolean;
  reduceMotion: boolean;
  setPillLayoutWidths: Dispatch<SetStateAction<Record<string, number>>>;
  onToggleThirdPartyMute: (identity: string) => void;
  onParticipantVolumeChange: (identity: string, volume: number) => void;
  onWhisperParticipant?: (target: WhisperTarget) => void;
  onInspectStream: (identity: string) => void;
}) {
  const pillRef = useRef<HTMLDivElement>(null);
  const widthMeasureRef = useRef<HTMLDivElement>(null);
  const layoutWidthMeasureRef = useRef<HTMLDivElement>(null);
  const previousLaneRef = useRef(user.lane);
  const hoverOpenTimerRef = useRef<number | null>(null);
  const hoverCloseTimerRef = useRef<number | null>(null);
  const hoverFullyOpenRef = useRef(false);
  const [hoveredSnapshot, setHoveredSnapshot] = useState<FrontPillSnapshot | null>(null);
  const [volumeEditorOpen, setVolumeEditorOpen] = useState(false);
  const [renderedWidth, setRenderedWidth] = useState<number | undefined>(undefined);
  const label = user.isLocal ? nickname : user.displayName;
  const frontState = hoveredSnapshot ?? user;
  const isRemoteUser = !user.isLocal;
  const showWhisperAction = isRemoteUser && Boolean(user.userId);
  const showVolumeAction = user.lane === "voice" && isRemoteUser;
  const showStreamAction = Boolean(user.isStreaming);
  const showHoverAction = showWhisperAction || showVolumeAction || showStreamAction;
  const activeFaceOpen = volumeEditorOpen || Boolean(hoveredSnapshot);
  const hasPassiveContextStatus = Boolean(frontState.isSelfDeafened || frontState.isSelfMuted);
  const hasPersistentVolumeAction = frontState.isThirdPartyMuted && showVolumeAction;
  const hasWhisperAction = showWhisperAction && Boolean(user.userId);
  const hasHoverOnlyVolumeAction = showVolumeAction && !hasPersistentVolumeAction;
  const hasHoverOnlyActions = hasWhisperAction || hasHoverOnlyVolumeAction;
  const participantIdentity = user.participantId ?? user.identity;
  const participantVolumeKey = user.volumeKey ?? participantIdentity;
  const participantVolume = user.isThirdPartyMuted
    ? 0
    : getClampedGainVolume(user.thirdPartyVolume ?? 1, MAX_PARTICIPANT_VOLUME_PERCENT);
  const participantVolumePercent = Math.round(participantVolume * 100);
  const participantVolumeSliderValue = getParticipantVolumeSliderValue(participantVolume);
  const participantVolumeFill = Math.max(
    0,
    Math.min(100, (participantVolumeSliderValue / PARTICIPANT_VOLUME_SLIDER_MAX) * 100)
  );
  const seededAvatarStyle = getSeededAvatarStyle(user.identity);
  const animatedPosition = { ...position, opacity: position.opacity ?? 1 };
  const laneChanged = previousLaneRef.current !== user.lane;
  const driftMotion = useMemo(
    () => getPillDrift(user.identity, user.lane, reduceMotion),
    [user.identity, user.lane, reduceMotion]
  );
  const pillTweenDuration = suppressLayoutMotion && !laneChanged ? 0 : 0.72;
  const pillTween = useMemo(
    () =>
      ({
        type: "tween" as const,
        duration: pillTweenDuration,
        ease: [0.2, 0.9, 0.22, 1] as const
      }),
    [pillTweenDuration]
  );
  const pillTransition = useMemo(
    () =>
      ({
        x: pillTween,
        y: lockVerticalMotion ? { duration: 0 } : pillTween,
        opacity: { duration: Math.min(pillTweenDuration, 0.2) }
      }) as const,
    [lockVerticalMotion, pillTween, pillTweenDuration]
  );

  const clearHoverOpenTimer = useCallback(() => {
    if (hoverOpenTimerRef.current === null) {
      return;
    }

    window.clearTimeout(hoverOpenTimerRef.current);
    hoverOpenTimerRef.current = null;
  }, []);

  const clearHoverCloseTimer = useCallback(() => {
    if (hoverCloseTimerRef.current === null) {
      return;
    }

    window.clearTimeout(hoverCloseTimerRef.current);
    hoverCloseTimerRef.current = null;
  }, []);

  const clearHoverTimers = useCallback(() => {
    clearHoverOpenTimer();
    clearHoverCloseTimer();
  }, [clearHoverCloseTimer, clearHoverOpenTimer]);

  const setPillHoverSnapshot = useCallback(() => {
    setHoveredSnapshot({
      isStreaming: user.isStreaming,
      isSelfMuted: user.isSelfMuted,
      isSelfDeafened: user.isSelfDeafened,
      isThirdPartyMuted: user.isThirdPartyMuted,
      thirdPartyVolume: user.thirdPartyVolume,
      voiceLevel: user.voiceLevel
    });
  }, [
    user.isSelfDeafened,
    user.isSelfMuted,
    user.isStreaming,
    user.isThirdPartyMuted,
    user.thirdPartyVolume,
    user.voiceLevel
  ]);

  const openPillHoverState = useCallback(() => {
    clearHoverCloseTimer();

    if (!hoveredSnapshot) {
      hoverFullyOpenRef.current = false;
      setPillHoverSnapshot();
    }

    if (hoverOpenTimerRef.current === null && !hoverFullyOpenRef.current) {
      hoverOpenTimerRef.current = window.setTimeout(() => {
        hoverOpenTimerRef.current = null;
        hoverFullyOpenRef.current = true;
      }, PILL_HOVER_OPEN_SETTLE_MS);
    }
  }, [clearHoverCloseTimer, hoveredSnapshot, setPillHoverSnapshot]);

  const closePillHoverState = useCallback(
    (delayIfFullyOpen = true) => {
      clearHoverOpenTimer();
      clearHoverCloseTimer();

      if (!hoveredSnapshot) {
        hoverFullyOpenRef.current = false;
        return;
      }

      if (delayIfFullyOpen && hoverFullyOpenRef.current) {
        hoverCloseTimerRef.current = window.setTimeout(() => {
          hoverCloseTimerRef.current = null;
          hoverFullyOpenRef.current = false;
          setHoveredSnapshot(null);
        }, PILL_HOVER_CLOSE_DELAY_MS);
        return;
      }

      hoverFullyOpenRef.current = false;
      setHoveredSnapshot(null);
    },
    [clearHoverCloseTimer, clearHoverOpenTimer, hoveredSnapshot]
  );

  useEffect(() => {
    previousLaneRef.current = user.lane;
  }, [user.lane]);

  useEffect(() => {
    return () => {
      clearHoverTimers();
    };
  }, [clearHoverTimers]);

  useLayoutEffect(() => {
    let cancelled = false;
    let settleFrameId = 0;
    let settleFramesRemaining = 0;

    const readWidth = (node: HTMLElement | null) => {
      if (!node) {
        return 0;
      }

      return Math.ceil(node.offsetWidth || node.scrollWidth || node.getBoundingClientRect().width);
    };

    const commitWidth = (
      nextWidth: number,
      setWidths: Dispatch<SetStateAction<Record<string, number>>>
    ) => {
      if (nextWidth <= 0) {
        return;
      }

      setWidths((previous) =>
        previous[user.identity] === nextWidth
          ? previous
          : {
              ...previous,
              [user.identity]: nextWidth
            }
      );
    };
    const commitRenderedWidth = (nextWidth: number) => {
      if (nextWidth <= 0) {
        return;
      }

      setRenderedWidth((previous) => (previous === nextWidth ? previous : nextWidth));
    };

    const updateWidths = () => {
      const activeFaceWidth = readWidth(widthMeasureRef.current ?? pillRef.current);
      const restingFaceWidth = readWidth(layoutWidthMeasureRef.current);
      const shouldGrowForHoverActions =
        activeFaceOpen &&
        hasHoverOnlyActions &&
        !hasPassiveContextStatus &&
        restingFaceWidth > 0 &&
        activeFaceWidth > restingFaceWidth + PILL_ACTIVE_WIDTH_GROW_THRESHOLD;
      const renderedWidth =
        volumeEditorOpen && activeFaceWidth > 0
          ? activeFaceWidth
          : shouldGrowForHoverActions
            ? activeFaceWidth
            : restingFaceWidth > 0
              ? restingFaceWidth
              : activeFaceWidth;

      commitRenderedWidth(renderedWidth);
      commitWidth(restingFaceWidth, setPillLayoutWidths);
    };

    const scheduleSettledWidths = (frames = PILL_METRIC_SETTLE_FRAMES) => {
      settleFramesRemaining = Math.max(settleFramesRemaining, frames);

      if (settleFrameId) {
        return;
      }

      const tick = () => {
        settleFrameId = 0;
        if (cancelled) {
          return;
        }

        updateWidths();
        settleFramesRemaining -= 1;

        if (settleFramesRemaining > 0) {
          settleFrameId = window.requestAnimationFrame(tick);
        }
      };

      settleFrameId = window.requestAnimationFrame(tick);
    };

    const handleMetricInvalidation = () => {
      updateWidths();
      scheduleSettledWidths(2);
    };

    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(handleMetricInvalidation);
    const measuredWidthNode = widthMeasureRef.current ?? pillRef.current;
    const layoutWidthNode = layoutWidthMeasureRef.current;

    updateWidths();
    scheduleSettledWidths();
    if (measuredWidthNode) {
      observer?.observe(measuredWidthNode);
    }
    if (layoutWidthNode && layoutWidthNode !== measuredWidthNode) {
      observer?.observe(layoutWidthNode);
    }
    window.addEventListener("resize", handleMetricInvalidation);
    void document.fonts?.ready.then(() => {
      if (!cancelled) {
        handleMetricInvalidation();
      }
    });

    return () => {
      cancelled = true;
      if (settleFrameId) {
        window.cancelAnimationFrame(settleFrameId);
      }
      observer?.disconnect();
      window.removeEventListener("resize", handleMetricInvalidation);
    };
  }, [
    label,
    setPillLayoutWidths,
    activeFaceOpen,
    hasPassiveContextStatus,
    hasHoverOnlyActions,
    showHoverAction,
    showStreamAction,
    showVolumeAction,
    showWhisperAction,
    frontState.isStreaming,
    frontState.isThirdPartyMuted,
    frontState.isSelfDeafened,
    frontState.isSelfMuted,
    user.identity,
    volumeEditorOpen
  ]);

  function renderStreamActionButton(key = "stream", arrives = false) {
    return (
      <HoverTooltip
        key={key}
        label={user.isLocal ? "Open your stream" : `Watch ${label}'s stream`}
        className={arrives ? "voice-pill-arrive-action" : undefined}
      >
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onInspectStream(participantIdentity);
          }}
          className="voice-pill-action voice-pill-action-stream voice-pill-context-action"
          aria-label={user.isLocal ? "Open your stream" : `Watch ${label}'s stream`}
        >
          <Monitor className="voice-pill-stream-icon h-[17px] w-[17px] shrink-0" strokeWidth={2.2} />
        </button>
      </HoverTooltip>
    );
  }

  function renderVolumeActionButton(key = "volume", arrives = false) {
    return (
      <HoverTooltip
        key={key}
        label={`Volume for ${label}`}
        className={arrives ? "voice-pill-arrive-action" : undefined}
      >
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            event.currentTarget.blur();
            setVolumeEditorOpen(true);
          }}
          className={cn(
            "voice-pill-action voice-pill-context-action",
            user.isThirdPartyMuted && "voice-pill-action-muted"
          )}
          aria-label={`Adjust ${label} volume`}
        >
          {user.isThirdPartyMuted ? (
            <VolumeX className="h-[18px] w-[18px] shrink-0" strokeWidth={2.1} />
          ) : (
            <Volume2 className="h-[18px] w-[18px] shrink-0" strokeWidth={2.1} />
          )}
        </button>
      </HoverTooltip>
    );
  }

  const streamStatusIcon = frontState.isStreaming ? renderStreamActionButton("stream") : null;
  const volumeStatusIcon =
    hasPersistentVolumeAction
      ? renderVolumeActionButton("volume")
      : frontState.isThirdPartyMuted ? (
        <span key="muted" className="voice-pill-context-slot" aria-hidden="true">
          <VolumeX className="h-[18px] w-[18px] shrink-0 text-white" strokeWidth={2.25} />
        </span>
      ) : null;
  function renderPassiveStatusIcons(hidden = false) {
    return [
      frontState.isSelfDeafened ? (
        <span
          key="deafened"
          className={cn("voice-pill-context-slot", hidden && "voice-pill-context-slot-hidden")}
          aria-hidden="true"
        >
          <HeadphoneOff
            className="h-[18px] w-[18px] shrink-0 text-white/54"
            strokeWidth={2.1}
          />
        </span>
      ) : null,
      frontState.isSelfMuted ? (
        <span
          key="self-muted"
          className={cn("voice-pill-context-slot", hidden && "voice-pill-context-slot-hidden")}
          aria-hidden="true"
        >
          <MicOff
            className="h-[18px] w-[18px] shrink-0 text-white/54"
            strokeWidth={2.1}
          />
        </span>
      ) : null
    ].filter(Boolean);
  }
  const passiveStatusIcons = renderPassiveStatusIcons();
  const passiveHiddenStatusIcons = renderPassiveStatusIcons(true);
  const statusIcons = [streamStatusIcon, volumeStatusIcon, ...passiveStatusIcons].filter(Boolean);

  function renderActionControls() {
    const controls: ReactNode[] = [];

    if (showStreamAction) {
      controls.push(renderStreamActionButton("stream"));
    }

    if (hasPersistentVolumeAction) {
      controls.push(renderVolumeActionButton("volume"));
    }

    controls.push(...passiveHiddenStatusIcons);

    if (hasWhisperAction) {
      controls.push(
        <HoverTooltip key="whisper" label={`Whisper to ${label}`} className="voice-pill-arrive-action">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              event.currentTarget.blur();
              closePillHoverState(false);
              setVolumeEditorOpen(false);
              onWhisperParticipant?.({
                userId: user.userId ?? "",
                nickname: label
              });
            }}
            className="voice-pill-action voice-pill-action-whisper"
            aria-label={`Whisper to ${label}`}
          >
            <MessageSquareText className="h-[18px] w-[18px] shrink-0" strokeWidth={2.15} />
          </button>
        </HoverTooltip>
      );
    }

    if (hasHoverOnlyVolumeAction) {
      controls.push(renderVolumeActionButton("volume", !frontState.isThirdPartyMuted));
    }

    return controls;
  }

  function renderAvatar() {
    const avatarImageSrc = user.isLocal ? localAvatarSrc : user.avatarSrc;

    return (
      <>
        <span
          className={cn(
            "voice-pill-avatar",
            (avatarImageSrc || seededAvatarStyle) && "voice-pill-avatar-image"
          )}
          style={avatarImageSrc ? undefined : seededAvatarStyle ?? getAvatarStyle(label)}
          aria-hidden="true"
        >
          {avatarImageSrc ? (
            <img src={avatarImageSrc} alt="" className="voice-pill-avatar-img" />
          ) : seededAvatarStyle ? null : (
            <span className="voice-pill-avatar-label">{getAvatarLabel(label)}</span>
          )}
        </span>
        {user.isAfk ? (
          <span className="voice-pill-sleep-badge" aria-hidden="true">
            <SleepStatusIcon />
          </span>
        ) : null}
      </>
    );
  }

  function renderVolumeFace(className: string) {
    const handleParticipantVolumeChange = (value: number) => {
      onParticipantVolumeChange(participantVolumeKey, getParticipantVolumeFromSliderValue(value));
    };

    return (
      <div className={cn(className, "voice-pill-face-volume-only")}>
        <div
          className={cn(
            "voice-pill-user-volume",
            participantVolumePercent <= 0 && "voice-pill-user-volume-muted"
          )}
          style={{ "--pill-user-volume-fill": `${participantVolumeFill}%` } as CSSProperties}
        >
          <span className="voice-pill-user-volume-mark voice-pill-user-volume-mark-mid" aria-hidden="true" />
          <input
            type="range"
            min={0}
            max={PARTICIPANT_VOLUME_SLIDER_MAX}
            step={1}
            value={participantVolumeSliderValue}
            onChange={(event) => handleParticipantVolumeChange(Number(event.target.value))}
            className="voice-pill-user-volume-slider"
            aria-label={`Volume for ${label}: ${participantVolumePercent}%`}
          />
        </div>
        <HoverTooltip label="Back">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setVolumeEditorOpen(false);
            }}
            className="voice-pill-action voice-pill-volume-return"
            aria-label={`Close volume for ${label}`}
          >
            <Undo2 className="h-[20px] w-[20px] shrink-0" strokeWidth={2.35} />
          </button>
        </HoverTooltip>
      </div>
    );
  }

  function renderPillFace(mode: "rest" | "actions" | "volume", className = "voice-pill-face") {
    if (mode === "volume") {
      return renderVolumeFace(className);
    }

    const actionControls = mode === "actions" ? renderActionControls() : [];
    const rowClassName = cn(
      "voice-pill-inline-row",
      mode === "actions" ? "voice-pill-action-row" : "voice-pill-status-row"
    );

    return (
      <div
        className={cn(
          className,
          mode === "actions" && hasHoverOnlyActions && "voice-pill-face-actions",
          mode === "actions" && hasPassiveContextStatus && "voice-pill-face-retain-rest-width"
        )}
      >
        <span className="voice-pill-name">{label}</span>
        {mode === "actions" && actionControls.length ? (
          <span className={rowClassName}>{actionControls}</span>
        ) : statusIcons.length ? (
          <span className={rowClassName}>{statusIcons}</span>
        ) : null}
      </div>
    );
  }

  const contentMode = volumeEditorOpen ? "volume" : activeFaceOpen ? "actions" : "rest";
  const pillSizer = (
    <div ref={widthMeasureRef} className="voice-pill-measure">
      {renderPillFace(contentMode, "voice-pill-face")}
    </div>
  );
  const layoutSizer = (
    <div ref={layoutWidthMeasureRef} className="voice-pill-measure">
      {renderPillFace("rest", "voice-pill-face")}
    </div>
  );

  useEffect(() => {
    if (!volumeEditorOpen) {
      return undefined;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (pillRef.current?.contains(event.target as Node)) {
        return;
      }

      setVolumeEditorOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setVolumeEditorOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [volumeEditorOpen]);

  return (
    <motion.div
      initial={
        hasPlayedEntry
          ? false
          : {
              ...position,
              opacity: 0,
              scale: 0.96,
              y: position.y + 10
            }
      }
      animate={animatedPosition}
      transition={pillTransition}
      className="voice-pill-motion-layer absolute left-0 top-0 z-10"
    >
      <motion.div animate={driftMotion.animate} transition={driftMotion.transition}>
        <div
          ref={pillRef}
          style={
            {
              ...(renderedWidth ? { width: `${renderedWidth}px` } : undefined),
              "--pill-voice-level": user.voiceLevel.toFixed(3)
            } as CSSProperties
          }
          className={cn(
            "voice-pill rounded-full",
            user.lane === "voice" ? "voice-pill-active" : "voice-pill-lobby",
            user.isSpeaking && user.lane === "voice" && "voice-pill-speaking",
            user.isTransitioning && "voice-pill-transitioning",
            user.isStreaming && "voice-pill-streaming-live",
            (user.isSelfMuted || user.isSelfDeafened) && "voice-pill-ghosted",
            user.isAfk && "voice-pill-afk",
            user.isThirdPartyMuted && "voice-pill-muted",
            showHoverAction && "voice-pill-interactive",
            Boolean(hoveredSnapshot) && "voice-pill-hover-open",
            volumeEditorOpen && "voice-pill-volume-open"
          )}
          data-speaking={user.isSpeaking && user.lane === "voice" ? "true" : undefined}
          onMouseEnter={showHoverAction ? openPillHoverState : undefined}
          onMouseLeave={showHoverAction ? () => closePillHoverState(true) : undefined}
        >
          {showHoverAction ? (
            <div className={cn("voice-pill-button", volumeEditorOpen && "voice-pill-button-volume")}>
              <span className="voice-pill-sizer" aria-hidden="true">
                {pillSizer}
              </span>
              <span className="voice-pill-layout-sizer" aria-hidden="true">
                {layoutSizer}
              </span>
              {volumeEditorOpen ? null : renderAvatar()}
              <span className="voice-pill-content-shell">
                {renderPillFace("rest", "voice-pill-face voice-pill-face-front")}
                {renderPillFace(
                  volumeEditorOpen ? "volume" : "actions",
                  "voice-pill-face voice-pill-face-back"
                )}
              </span>
            </div>
          ) : (
            <div className="voice-pill-static">
              <span className="voice-pill-static-sizer" aria-hidden="true">
                {pillSizer}
              </span>
              {renderAvatar()}
              {renderPillFace("rest", "voice-pill-face")}
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}, (previous, next) =>
  previous.nickname === next.nickname &&
  previous.localAvatarSrc === next.localAvatarSrc &&
  previous.hasPlayedEntry === next.hasPlayedEntry &&
  previous.lockVerticalMotion === next.lockVerticalMotion &&
  previous.suppressLayoutMotion === next.suppressLayoutMotion &&
  previous.reduceMotion === next.reduceMotion &&
  previous.position.x === next.position.x &&
  previous.position.y === next.position.y &&
  (previous.position.opacity ?? 1) === (next.position.opacity ?? 1) &&
  previous.user.identity === next.user.identity &&
  previous.user.userId === next.user.userId &&
  previous.user.displayName === next.user.displayName &&
  previous.user.participantId === next.user.participantId &&
  previous.user.volumeKey === next.user.volumeKey &&
  previous.user.avatarSrc === next.user.avatarSrc &&
  previous.user.lane === next.user.lane &&
  previous.user.isSpeaking === next.user.isSpeaking &&
  previous.user.voiceLevel === next.user.voiceLevel &&
  previous.user.isLocal === next.user.isLocal &&
  previous.user.isTransitioning === next.user.isTransitioning &&
  previous.user.isStreaming === next.user.isStreaming &&
  previous.user.isSelfMuted === next.user.isSelfMuted &&
  previous.user.isSelfDeafened === next.user.isSelfDeafened &&
  previous.user.isThirdPartyMuted === next.user.isThirdPartyMuted &&
  previous.user.isAfk === next.user.isAfk &&
  previous.user.thirdPartyVolume === next.user.thirdPartyVolume
);

function ShareGlyph({ active }: { active: boolean }) {
  return (
    <OmarchyGlyph
      kind={active ? "share-off" : "share"}
      className="omarchy-mode-icon h-[18px] w-[18px]"
    />
  );
}

function getTrackPublication(participant: Participant, source: Track.Source) {
  for (const publication of participant.trackPublications.values()) {
    if (publication.source === source) {
      return publication;
    }
  }

  return undefined;
}

function getScreenTrack(participant: Participant) {
  const publication = getTrackPublication(participant, Track.Source.ScreenShare);
  return publication?.track && publication.track.kind === Track.Kind.Video
    ? (publication.track as VideoTrack)
    : null;
}

function getScreenSharePublication(participant: Participant) {
  const publication = getTrackPublication(participant, Track.Source.ScreenShare);
  return publication instanceof Object ? (publication as RemoteTrackPublication) : undefined;
}

function isParticipantStreaming(participant: Participant) {
  const publication = getTrackPublication(participant, Track.Source.ScreenShare);
  return Boolean(publication && !publication.isMuted);
}

function getTrackSettingsSnapshot(track: MediaStreamTrack | undefined | null) {
  if (!track || typeof track.getSettings !== "function") {
    return null;
  }

  const settings = track.getSettings();
  return {
    width: typeof settings.width === "number" ? settings.width : undefined,
    height: typeof settings.height === "number" ? settings.height : undefined,
    frameRate: typeof settings.frameRate === "number" ? settings.frameRate : undefined,
    displaySurface:
      typeof settings.displaySurface === "string" ? settings.displaySurface : undefined
  };
}

function getMicrophoneTrack(participant: Participant | null) {
  const publication = participant
    ? getTrackPublication(participant, Track.Source.Microphone)
    : undefined;

  return publication?.track && publication.track.kind === Track.Kind.Audio
    ? (publication.track as LocalAudioTrack)
    : null;
}

function getLocalMicrophonePublication(participant: LocalParticipant) {
  const publication = getTrackPublication(participant, Track.Source.Microphone);
  return publication ? (publication as LocalTrackPublication) : undefined;
}

function getTrackMediaStreamTrack(track: LocalAudioTrack | null) {
  return (track as { mediaStreamTrack?: MediaStreamTrack } | null)?.mediaStreamTrack ?? null;
}

function getTrackSourceMediaStreamTrack(track: LocalAudioTrack | null) {
  return (
    (track as { _mediaStreamTrack?: MediaStreamTrack } | null)?._mediaStreamTrack ??
    getTrackMediaStreamTrack(track)
  );
}

function wait(milliseconds: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

function getMicrophoneDebugSnapshot(participant: LocalParticipant | null) {
  if (!participant) {
    return {
      hasParticipant: false
    };
  }

  const publication = getLocalMicrophonePublication(participant);
  const track = publication?.audioTrack ?? getMicrophoneTrack(participant);
  const mediaStreamTrack = getTrackMediaStreamTrack(track);

  return {
    hasParticipant: true,
    hasPublication: Boolean(publication),
    publicationMuted: publication?.isMuted ?? null,
    publicationSource: publication?.source ?? null,
    hasTrack: Boolean(track),
    trackMuted: track?.isMuted ?? null,
    upstreamPaused: publication?.isUpstreamPaused ?? null,
    mediaEnabled: mediaStreamTrack?.enabled ?? null,
    mediaMuted: mediaStreamTrack?.muted ?? null,
    mediaReadyState: mediaStreamTrack?.readyState ?? null,
    mediaLabel: mediaStreamTrack?.label ?? null
  };
}

async function ensureLocalMicrophoneUnmuted(
  participant: LocalParticipant,
  publication?: LocalTrackPublication
) {
  const microphonePublication = publication ?? getLocalMicrophonePublication(participant);
  const track = microphonePublication?.audioTrack ?? getMicrophoneTrack(participant);

  const mediaStreamTrack = getTrackSourceMediaStreamTrack(track);
  if (mediaStreamTrack && mediaStreamTrack.readyState === "live") {
    mediaStreamTrack.enabled = true;
  }

  await microphonePublication?.unmute().catch(() => undefined);
  await track?.unmute().catch(() => undefined);

  await microphonePublication?.resumeUpstream().catch(() => undefined);
  if (!microphonePublication) {
    await track?.resumeUpstream().catch(() => undefined);
  }

  const activeMediaStreamTrack = getTrackMediaStreamTrack(track);
  if (activeMediaStreamTrack && activeMediaStreamTrack.readyState === "live") {
    activeMediaStreamTrack.enabled = true;
  }
}

async function ensureLocalMicrophoneMuted(
  participant: LocalParticipant,
  publication?: LocalTrackPublication
) {
  const microphonePublication = publication ?? getLocalMicrophonePublication(participant);
  const track = microphonePublication?.audioTrack ?? getMicrophoneTrack(participant);
  const sourceMediaStreamTrack = getTrackSourceMediaStreamTrack(track);
  const activeMediaStreamTrack = getTrackMediaStreamTrack(track);

  if (sourceMediaStreamTrack && sourceMediaStreamTrack.readyState === "live") {
    sourceMediaStreamTrack.enabled = true;
  }
  if (activeMediaStreamTrack && activeMediaStreamTrack.readyState === "live") {
    activeMediaStreamTrack.enabled = true;
  }

  await microphonePublication?.unmute().catch(() => undefined);
  await track?.unmute().catch(() => undefined);

  await microphonePublication?.pauseUpstream().catch(() => undefined);
  if (!microphonePublication) {
    await track?.pauseUpstream().catch(() => undefined);
  }
}

function getSelfMutedState(participant: Participant, metadata: ParticipantMetadata) {
  const microphonePublication = getTrackPublication(participant, Track.Source.Microphone);

  return Boolean(metadata.selfMuted) || Boolean(microphonePublication?.isMuted);
}

function getSelfDeafenedState(metadata: ParticipantMetadata) {
  return Boolean(metadata.selfDeafened);
}

function syncRemoteTrackSubscriptions(
  activeRoom: Room,
  selectedStreamIdentity: string | null,
  nativePopoutStreamIdentity: string | null = null
) {
  for (const participant of activeRoom.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      const isScreenShare =
        publication.source === Track.Source.ScreenShare ||
        publication.source === Track.Source.ScreenShareAudio;
      const shouldSubscribe = isScreenShare
        ? participant.identity === selectedStreamIdentity
        : true;

      if (publication.isDesired !== shouldSubscribe) {
        publication.setSubscribed(shouldSubscribe);
      }

      if (publication.isEnabled !== shouldSubscribe) {
        publication.setEnabled(shouldSubscribe);
      }

      if (shouldSubscribe && publication.source === Track.Source.ScreenShare) {
        publication.setVideoQuality(VideoQuality.HIGH);
        publication.setVideoDimensions(SCREEN_SHARE_FOCUSED_DIMENSIONS);
      }
    }
  }
}

function getActiveRemoteStreamIdentity(activeRoom: Room) {
  for (const participant of activeRoom.remoteParticipants.values()) {
    if (isParticipantStreaming(participant)) {
      return participant.identity;
    }
  }

  return null;
}

class MicrophoneGainProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = "sovchat-microphone-gain";
  processedTrack?: MediaStreamTrack;
  private sourceNode?: MediaStreamAudioSourceNode;
  private gainNode?: GainNode;
  private destinationNode?: MediaStreamAudioDestinationNode;
  private activeInputTrack?: MediaStreamTrack;

  constructor(private gainValue: number) {}

  setGain(nextGain: number) {
    this.gainValue = nextGain;
    this.gainNode?.gain.setValueAtTime(
      nextGain,
      this.gainNode.context.currentTime
    );
  }

  async init(opts: AudioProcessorOptions) {
    this.activeInputTrack = opts.track;
    this.sourceNode = opts.audioContext.createMediaStreamSource(new MediaStream([opts.track]));
    this.gainNode = opts.audioContext.createGain();
    this.destinationNode = opts.audioContext.createMediaStreamDestination();
    this.gainNode.gain.setValueAtTime(this.gainValue, opts.audioContext.currentTime);
    this.sourceNode.connect(this.gainNode);
    this.gainNode.connect(this.destinationNode);
    this.processedTrack = this.destinationNode.stream.getAudioTracks()[0] ?? opts.track;
  }

  async restart(opts: AudioProcessorOptions) {
    await this.destroy();
    await this.init(opts);
  }

  async destroy() {
    this.sourceNode?.disconnect();
    this.gainNode?.disconnect();
    if (this.processedTrack && this.processedTrack !== this.activeInputTrack) {
      this.processedTrack.stop();
    }
    this.sourceNode = undefined;
    this.gainNode = undefined;
    this.destinationNode = undefined;
    this.activeInputTrack = undefined;
    this.processedTrack = undefined;
  }
}

class KrispMicrophoneGainProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = "sovchat-krisp-microphone-gain";
  processedTrack?: MediaStreamTrack;
  private sourceNode?: MediaStreamAudioSourceNode;
  private gainNode?: GainNode;
  private destinationNode?: MediaStreamAudioDestinationNode;
  private activeKrispTrack?: MediaStreamTrack;

  constructor(
    private readonly krispProcessor: KrispNoiseFilterProcessor,
    private gainValue: number
  ) {}

  get krisp() {
    return this.krispProcessor;
  }

  setGain(nextGain: number) {
    this.gainValue = nextGain;
    this.gainNode?.gain.setValueAtTime(nextGain, this.gainNode.context.currentTime);
  }

  async setEnabled(enable: boolean) {
    return await this.krispProcessor.setEnabled(enable);
  }

  isEnabled() {
    return this.krispProcessor.isEnabled();
  }

  async init(opts: AudioProcessorOptions) {
    await this.krispProcessor.init(opts);
    this.connectGain(opts.audioContext, this.krispProcessor.processedTrack ?? opts.track);
  }

  async restart(opts: AudioProcessorOptions) {
    await this.krispProcessor.restart(opts);
    this.connectGain(opts.audioContext, this.krispProcessor.processedTrack ?? opts.track);
  }

  async destroy() {
    this.disconnectGain();
    await this.krispProcessor.destroy();
  }

  private connectGain(audioContext: AudioContext, track: MediaStreamTrack) {
    this.disconnectGain();
    this.activeKrispTrack = track;
    this.sourceNode = audioContext.createMediaStreamSource(new MediaStream([track]));
    this.gainNode = audioContext.createGain();
    this.destinationNode = audioContext.createMediaStreamDestination();
    this.gainNode.gain.setValueAtTime(this.gainValue, audioContext.currentTime);
    this.sourceNode.connect(this.gainNode);
    this.gainNode.connect(this.destinationNode);
    this.processedTrack = this.destinationNode.stream.getAudioTracks()[0] ?? track;
  }

  private disconnectGain() {
    this.sourceNode?.disconnect();
    this.gainNode?.disconnect();
    if (this.processedTrack && this.processedTrack !== this.activeKrispTrack) {
      this.processedTrack.stop();
    }
    this.sourceNode = undefined;
    this.gainNode = undefined;
    this.destinationNode = undefined;
    this.activeKrispTrack = undefined;
    this.processedTrack = undefined;
  }
}

class VoiceGateNodeChain {
  processedTrack?: MediaStreamTrack;
  private sourceNode?: MediaStreamAudioSourceNode;
  private processorNode?: ScriptProcessorNode;
  private workletNode?: AudioWorkletNode;
  private destinationNode?: MediaStreamAudioDestinationNode;
  private activeInputTrack?: MediaStreamTrack;
  private currentGain = 1;
  private gateOpen = true;
  private noiseFloor = 0.006;
  private holdSamples = 0;
  private lastStatsAt = 0;
  private connectVersion = 0;

  constructor(
    private profile: Exclude<VoiceGateExperiment, "off">,
    private config: VoiceGateConfig,
    private readonly source: VoiceGateRuntimeState["source"],
    private readonly onStats: (stats: VoiceGateStats) => void
  ) {}

  setProfile(profile: Exclude<VoiceGateExperiment, "off">, config: VoiceGateConfig) {
    this.profile = profile;
    this.config = config;
    this.workletNode?.port.postMessage({
      type: "configure",
      profile,
      config,
      source: this.source
    });
  }

  async connect(audioContext: AudioContext, track: MediaStreamTrack) {
    this.disconnectNodes();
    const connectVersion = ++this.connectVersion;
    this.activeInputTrack = track;
    this.sourceNode = audioContext.createMediaStreamSource(new MediaStream([track]));
    this.destinationNode = audioContext.createMediaStreamDestination();

    if (await this.connectWorklet(audioContext, connectVersion)) {
      return;
    }

    if (!this.isCurrentConnect(connectVersion)) {
      return;
    }

    this.processorNode = audioContext.createScriptProcessor(
      VOICE_GATE_SCRIPT_PROCESSOR_BUFFER_SIZE,
      1,
      1
    );
    this.processorNode.onaudioprocess = (event) => {
      this.processAudio(event, audioContext.sampleRate);
    };
    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.destinationNode);
    this.processedTrack = this.destinationNode.stream.getAudioTracks()[0] ?? track;
  }

  disconnect() {
    this.connectVersion += 1;
    this.disconnectNodes();
  }

  private disconnectNodes() {
    if (this.processorNode) {
      this.processorNode.onaudioprocess = null;
    }
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
    }
    this.sourceNode?.disconnect();
    this.processorNode?.disconnect();
    this.workletNode?.disconnect();
    this.destinationNode?.disconnect();
    if (this.processedTrack && this.processedTrack !== this.activeInputTrack) {
      this.processedTrack.stop();
    }
    this.sourceNode = undefined;
    this.processorNode = undefined;
    this.workletNode = undefined;
    this.destinationNode = undefined;
    this.activeInputTrack = undefined;
    this.processedTrack = undefined;
  }

  private isCurrentConnect(connectVersion: number) {
    return (
      this.connectVersion === connectVersion &&
      Boolean(this.sourceNode) &&
      Boolean(this.destinationNode)
    );
  }

  private async connectWorklet(audioContext: AudioContext, connectVersion: number) {
    const workletReady = await loadVoiceGateWorklet(audioContext);
    if (!workletReady) {
      return false;
    }

    if (!this.isCurrentConnect(connectVersion) || !this.sourceNode || !this.destinationNode) {
      return true;
    }

    try {
      const workletNode = new AudioWorkletNode(audioContext, VOICE_GATE_WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        processorOptions: {
          profile: this.profile,
          config: this.config,
          source: this.source
        }
      });
      workletNode.port.onmessage = (event) => {
        this.handleWorkletMessage(event);
      };
      this.workletNode = workletNode;
      this.sourceNode.connect(workletNode);
      workletNode.connect(this.destinationNode);
      this.processedTrack =
        this.destinationNode.stream.getAudioTracks()[0] ?? this.activeInputTrack;
      return true;
    } catch (error) {
      console.warn("[sovchat:audio] Voice gate AudioWorklet failed; using fallback.", {
        error: error instanceof Error ? error.message : String(error)
      });
      this.workletNode = undefined;
      return false;
    }
  }

  private handleWorkletMessage(event: MessageEvent) {
    const payload = event.data as Partial<VoiceGateStats> & { type?: string };
    if (payload?.type !== "stats") {
      return;
    }

    this.onStats({
      profile: payload.profile ?? this.profile,
      source: payload.source ?? this.source,
      gateOpen: payload.gateOpen ?? this.gateOpen,
      rms: payload.rms ?? 0,
      noiseFloor: payload.noiseFloor ?? this.noiseFloor,
      openThreshold: payload.openThreshold ?? 0,
      closeThreshold: payload.closeThreshold ?? 0,
      gain: payload.gain ?? this.currentGain,
      closedGain: payload.closedGain ?? this.config.closedGain,
      updatedAt: new Date().toISOString()
    });
  }

  private processAudio(event: AudioProcessingEvent, sampleRate: number) {
    const input = event.inputBuffer.getChannelData(0);
    const output = event.outputBuffer.getChannelData(0);
    let sumSquares = 0;
    let peak = 0;

    for (let index = 0; index < input.length; index += 1) {
      const sample = input[index] ?? 0;
      sumSquares += sample * sample;
      const absSample = Math.abs(sample);
      if (absSample > peak) {
        peak = absSample;
      }
    }

    const rms = Math.sqrt(sumSquares / Math.max(1, input.length));
    const belowOpenFloor = rms < Math.max(this.config.minOpenRms, this.noiseFloor * 1.35);
    if (!this.gateOpen || belowOpenFloor) {
      const coefficient =
        rms > this.noiseFloor ? this.config.noiseFloorRise : this.config.noiseFloorFall;
      this.noiseFloor += (rms - this.noiseFloor) * coefficient;
      this.noiseFloor = Math.max(0.001, Math.min(this.noiseFloor, this.config.minOpenRms * 0.95));
    }

    const openThreshold = Math.max(
      this.config.minOpenRms,
      this.noiseFloor * this.config.openNoiseMultiplier
    );
    const closeThreshold = Math.max(
      this.config.minCloseRms,
      this.noiseFloor * this.config.closeNoiseMultiplier
    );
    const speechLike = rms >= openThreshold || peak >= this.config.peakOpen;

    if (speechLike) {
      this.gateOpen = true;
      this.holdSamples = Math.round((sampleRate * this.config.holdMs) / 1000);
    } else if (this.gateOpen) {
      this.holdSamples = Math.max(0, this.holdSamples - input.length);
      if (this.holdSamples === 0 && rms <= closeThreshold) {
        this.gateOpen = false;
      }
    }

    const targetGain = this.gateOpen ? 1 : this.config.closedGain;
    const smoothingMs = targetGain > this.currentGain ? this.config.attackMs : this.config.releaseMs;
    const smoothingCoefficient = 1 - Math.exp(-1 / ((smoothingMs / 1000) * sampleRate));

    for (let index = 0; index < input.length; index += 1) {
      this.currentGain += (targetGain - this.currentGain) * smoothingCoefficient;
      output[index] = (input[index] ?? 0) * this.currentGain;
    }

    const now = Date.now();
    if (now - this.lastStatsAt > 650) {
      this.lastStatsAt = now;
      this.onStats({
        profile: this.profile,
        source: this.source,
        gateOpen: this.gateOpen,
        rms,
        noiseFloor: this.noiseFloor,
        openThreshold,
        closeThreshold,
        gain: this.currentGain,
        closedGain: this.config.closedGain,
        updatedAt: new Date(now).toISOString()
      });
    }
  }
}

class VoiceGateProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = "sovchat-voice-gate";
  processedTrack?: MediaStreamTrack;
  private chain: VoiceGateNodeChain;

  constructor(
    profile: Exclude<VoiceGateExperiment, "off">,
    config: VoiceGateConfig,
    onStats: (stats: VoiceGateStats) => void
  ) {
    this.chain = new VoiceGateNodeChain(profile, config, "voice-gate", onStats);
  }

  setGateProfile(profile: Exclude<VoiceGateExperiment, "off">, config: VoiceGateConfig) {
    this.chain.setProfile(profile, config);
  }

  async init(opts: AudioProcessorOptions) {
    await this.chain.connect(opts.audioContext, opts.track);
    this.processedTrack = this.chain.processedTrack ?? opts.track;
  }

  async restart(opts: AudioProcessorOptions) {
    await this.destroy();
    await this.init(opts);
  }

  async destroy() {
    this.chain.disconnect();
    this.processedTrack = undefined;
  }
}

class KrispVoiceGateProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = "sovchat-krisp-voice-gate";
  processedTrack?: MediaStreamTrack;
  private chain: VoiceGateNodeChain;

  constructor(
    private readonly krispProcessor: KrispNoiseFilterProcessor,
    profile: Exclude<VoiceGateExperiment, "off">,
    config: VoiceGateConfig,
    onStats: (stats: VoiceGateStats) => void
  ) {
    this.chain = new VoiceGateNodeChain(profile, config, "krisp-voice-gate", onStats);
  }

  get krisp() {
    return this.krispProcessor;
  }

  setGateProfile(profile: Exclude<VoiceGateExperiment, "off">, config: VoiceGateConfig) {
    this.chain.setProfile(profile, config);
  }

  async onPublish(room: Room) {
    await this.krispProcessor.onPublish?.(room);
  }

  async setEnabled(enable: boolean) {
    return await this.krispProcessor.setEnabled(enable);
  }

  isEnabled() {
    return this.krispProcessor.isEnabled();
  }

  async init(opts: AudioProcessorOptions) {
    await this.krispProcessor.init(opts);
    await this.chain.connect(opts.audioContext, this.krispProcessor.processedTrack ?? opts.track);
    this.processedTrack = this.chain.processedTrack ?? this.krispProcessor.processedTrack ?? opts.track;
  }

  async restart(opts: AudioProcessorOptions) {
    await this.krispProcessor.restart(opts);
    await this.chain.connect(opts.audioContext, this.krispProcessor.processedTrack ?? opts.track);
    this.processedTrack = this.chain.processedTrack ?? this.krispProcessor.processedTrack ?? opts.track;
  }

  async destroy() {
    this.chain.disconnect();
    await this.krispProcessor.destroy();
    this.processedTrack = undefined;
  }
}

function getIdentityHash(identity: string) {
  let hash = 0;

  for (let index = 0; index < identity.length; index += 1) {
    hash = (hash * 33 + identity.charCodeAt(index)) % 360;
  }

  return hash;
}

function getPillDrift(
  identity: string,
  lane: "voice" | "lobby",
  reduceMotion: boolean
): {
  animate: { x: number | number[]; y: number | number[]; rotate: number | number[] };
  transition: Transition;
} {
  if (reduceMotion) {
    return {
      animate: { x: 0, y: 0, rotate: 0 },
      transition: { duration: 0 }
    };
  }

  const hash = getIdentityHash(identity);
  const horizontalDirection = lane === "voice" ? -1 : 1;
  const horizontalAmplitude = 2 + (hash % 3) * 0.92;
  const rotationAmplitude = 0.12 + ((hash >> 4) % 4) * 0.05;
  const duration = 3.48 + (hash % 7) * 0.41;
  const delay = -((hash % 9) * 0.6);

  return {
    animate: {
      x: [0, horizontalAmplitude * horizontalDirection, 0],
      y: 0,
      rotate: [-rotationAmplitude, rotationAmplitude, -rotationAmplitude]
    },
    transition: {
      duration,
      delay,
      ease: "easeInOut",
      repeat: Number.POSITIVE_INFINITY,
      repeatType: "mirror" as const
    }
  };
}

function getAvatarLabel(identity: string) {
  return identity
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function getAvatarStyle(identity: string): CSSProperties {
  const hue = getIdentityHash(identity);
  const hueOffset = (hue + 42) % 360;

  return {
    background: `linear-gradient(145deg, hsl(${hue} 54% 42%) 0%, hsl(${hueOffset} 50% 32%) 100%)`,
    boxShadow: `inset 0 1px 0 rgba(255,255,255,0.14), 0 10px 22px hsla(${hueOffset} 70% 8% / 0.2)`
  };
}

function getSeededAvatarStyle(identity: string): CSSProperties | null {
  const source = SEEDED_AVATAR_SOURCES.get(identity);

  if (!source) {
    return null;
  }

  return {
    backgroundImage: `url("${source}")`,
    backgroundSize: "cover",
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.1), 0 10px 22px rgba(0, 0, 0, 0.22)"
  };
}

function getStageAvatarSrc({
  identity,
  participantId,
  volumeKey,
  providedAvatarSrc,
  knownAvatarSources
}: {
  identity: string;
  participantId?: string;
  volumeKey?: string;
  providedAvatarSrc?: string | null;
  knownAvatarSources: Partial<Record<string, string>>;
}) {
  return (
    providedAvatarSrc ??
    (volumeKey ? knownAvatarSources[volumeKey] : undefined) ??
    (participantId ? knownAvatarSources[participantId] : undefined) ??
    knownAvatarSources[identity] ??
    SEEDED_AVATAR_SOURCES.get(identity)
  );
}

function getDemoVoiceActivity(identity: string, timestamp: number) {
  if (identity !== DEMO_PRIMARY_SPEAKER_IDENTITY || DEMO_AFK_IDENTITIES.has(identity)) {
    return null;
  }

  const cycleProgress = timestamp % DEMO_SPEAKING_CYCLE_MS;
  const isSpeaking = cycleProgress < DEMO_SPEAKING_WINDOW_MS;

  if (!isSpeaking) {
    return {
      isSpeaking: false,
      voiceLevel: 0
    };
  }

  const speakingProgress = cycleProgress / DEMO_SPEAKING_WINDOW_MS;
  const wave = Math.sin(speakingProgress * Math.PI * 3.2);
  const voiceLevel = 0.44 + ((wave + 1) / 2) * 0.38;

  return {
    isSpeaking: true,
    voiceLevel: Number(voiceLevel.toFixed(3))
  };
}

function buildStageUsers(
  participants: ParticipantView[],
  onlineNicknames: string[],
  onlineProfiles: PresenceResponse["profiles"],
  nickname: string,
  transitionLobbyNicknames: string[],
  lingeringNicknames: string[],
  knownAvatarSources: Partial<Record<string, string>>,
  options: {
    selfMuted: boolean;
    selfDeafened: boolean;
    thirdPartyMutedIds: Set<string>;
    participantVolumes: Record<string, number>;
    fillerMode: boolean;
  },
  demoTimestamp: number
): StageUser[] {
  const onlineProfileByNickname = new Map(
    onlineProfiles.map((profile) => [profile.nickname, profile])
  );
  const participantMap = new Map(
    participants.map((participant) => {
      const volumeKey = getStableParticipantVolumeKey(participant.participantId, participant.userId);
      const thirdPartyVolume = getStoredParticipantVolume(
        options.participantVolumes,
        volumeKey,
        participant.participantId
      );

      return [
        participant.displayName,
        {
          identity: participant.displayName,
          displayName: participant.displayName,
          userId: participant.userId,
          participantId: participant.participantId,
          volumeKey,
          avatarSrc: getStageAvatarSrc({
            identity: participant.displayName,
            participantId: participant.participantId,
            volumeKey,
            providedAvatarSrc: participant.avatarSrc,
            knownAvatarSources
          }),
          isSpeaking: participant.isSpeaking,
          voiceLevel: participant.voiceLevel,
          isLocal: participant.isLocal,
          lane: "voice" as const,
          isStreaming: participant.isStreaming,
          isSelfMuted: participant.isLocal ? options.selfMuted : Boolean(participant.isSelfMuted),
          isSelfDeafened: participant.isLocal
            ? options.selfDeafened
            : Boolean(participant.isSelfDeafened),
          isAfk: Boolean(participant.isAfk),
          thirdPartyVolume,
          isThirdPartyMuted: isStoredParticipantMuted(
            options.thirdPartyMutedIds,
            options.participantVolumes,
            volumeKey,
            participant.participantId
          )
        }
      ] as const;
    })
  );
  const voiceDisplayNames = new Set(participants.map((participant) => participant.displayName));

  const stageNicknames = Array.from(
    new Set([...onlineNicknames, ...transitionLobbyNicknames, ...lingeringNicknames])
  );
  const lobbyIdentities = stageNicknames.filter(
    (onlineNickname) => !voiceDisplayNames.has(onlineNickname)
  );
  if (!voiceDisplayNames.has(nickname) && !lobbyIdentities.includes(nickname)) {
    lobbyIdentities.unshift(nickname);
  }
  for (const transitionNickname of transitionLobbyNicknames) {
    if (!voiceDisplayNames.has(transitionNickname) && !lobbyIdentities.includes(transitionNickname)) {
      lobbyIdentities.push(transitionNickname);
    }
  }

  if (options.fillerMode) {
    for (const demoVoiceUser of DEMO_VOICE_USERS) {
      if (!participantMap.has(demoVoiceUser.identity)) {
        const demoVoiceActivity = getDemoVoiceActivity(demoVoiceUser.identity, demoTimestamp);
        participantMap.set(demoVoiceUser.identity, {
          identity: demoVoiceUser.identity,
          displayName: demoVoiceUser.identity,
          userId: null,
          participantId: demoVoiceUser.identity,
          volumeKey: demoVoiceUser.identity,
          avatarSrc: getStageAvatarSrc({
            identity: demoVoiceUser.identity,
            participantId: demoVoiceUser.identity,
            volumeKey: demoVoiceUser.identity,
            knownAvatarSources
          }),
          isSpeaking: demoVoiceActivity?.isSpeaking ?? Boolean(demoVoiceUser.isSpeaking),
          voiceLevel: demoVoiceActivity?.voiceLevel ?? (Boolean(demoVoiceUser.isSpeaking) ? 0.72 : 0),
          isLocal: false,
          lane: "voice" as const,
          isStreaming: Boolean(demoVoiceUser.isStreaming),
          isSelfMuted: Boolean(demoVoiceUser.isSelfMuted),
          isSelfDeafened: Boolean(demoVoiceUser.isSelfDeafened),
          isAfk: Boolean(demoVoiceUser.isAfk),
          thirdPartyVolume: getStoredParticipantVolume(
            options.participantVolumes,
            demoVoiceUser.identity
          ),
          isThirdPartyMuted: isStoredParticipantMuted(
            options.thirdPartyMutedIds,
            options.participantVolumes,
            demoVoiceUser.identity
          )
        });
      }
    }

    for (const demoLobbyUser of DEMO_LOBBY_USERS) {
      if (!lobbyIdentities.includes(demoLobbyUser.identity) && !participantMap.has(demoLobbyUser.identity)) {
        lobbyIdentities.push(demoLobbyUser.identity);
      }
    }
  }

  const lobbyUsers = lobbyIdentities.map((identity) => {
    const profile = onlineProfileByNickname.get(identity);

    return {
      identity,
      displayName: profile?.nickname ?? identity,
      userId: profile?.userId ?? null,
      participantId: identity,
      volumeKey: profile?.userId ?? identity,
      avatarSrc: getStageAvatarSrc({
        identity,
        participantId: identity,
        volumeKey: profile?.userId ?? identity,
        providedAvatarSrc: profile?.avatarSrc,
        knownAvatarSources
      }),
      isSpeaking: false,
      voiceLevel: 0,
      isLocal: identity === nickname,
      lane: "lobby" as const,
      isStreaming: false,
      isSelfMuted: false,
      isSelfDeafened: false,
      isAfk: DEMO_AFK_IDENTITIES.has(identity),
      isThirdPartyMuted: false,
      thirdPartyVolume: 1,
      isTransitioning: transitionLobbyNicknames.includes(identity)
    };
  });

  return [...participantMap.values(), ...lobbyUsers];
}

function getCompactAvatarFallback(name: string) {
  return name
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";
}

function CompactParticipantRow({
  user,
  onInspectStream,
  onToggleThirdPartyMute,
  onParticipantVolumeChange,
  onWhisperParticipant
}: {
  user: StageUser;
  onInspectStream: (identity: string) => void;
  onToggleThirdPartyMute: (identity: string) => void;
  onParticipantVolumeChange: (identity: string, volume: number) => void;
  onWhisperParticipant?: (target: WhisperTarget) => void;
}) {
  const [volumeEditorOpen, setVolumeEditorOpen] = useState(false);
  const participantIdentity = user.participantId ?? user.identity;
  const volumeIdentity = user.volumeKey ?? participantIdentity;
  const canAdjustVolume = !user.isLocal && user.lane === "voice";
  const participantVolume = user.thirdPartyVolume ?? 1;
  const participantVolumeSliderValue = getParticipantVolumeSliderValue(participantVolume);
  const participantVolumePercent = Math.round(participantVolume * 100);

  return (
    <div
      className={cn(
        "compact-participant-row group px-3 py-2",
        user.isSpeaking && "compact-participant-row-speaking",
        user.isTransitioning && "opacity-60"
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div
          className={cn(
            "compact-participant-avatar relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-semibold text-white/72",
            user.isSpeaking && "compact-participant-avatar-speaking"
          )}
        >
          {user.avatarSrc ? (
            <img src={user.avatarSrc} alt="" className="h-full w-full object-cover" />
          ) : (
            getCompactAvatarFallback(user.displayName)
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[0.98rem] text-white/88">{user.displayName}</span>
            {user.isLocal ? (
              <span className="text-[10px] uppercase tracking-[0.12em] text-white/34">You</span>
            ) : null}
            {user.isAfk ? (
              <span className="text-[10px] uppercase tracking-[0.12em] text-white/34">AFK</span>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {user.isStreaming ? (
            <HoverTooltip label={`Open ${user.displayName}'s stream`}>
              <button
                type="button"
                onClick={() => onInspectStream(participantIdentity)}
                className="compact-participant-action compact-participant-action-stream"
                aria-label={`Open ${user.displayName}'s screen share in a popout`}
              >
                <OmarchyGlyph kind="share" className="omarchy-mode-icon h-4.5 w-4.5" />
              </button>
            </HoverTooltip>
          ) : null}

          {!user.isLocal && user.userId && onWhisperParticipant ? (
            <HoverTooltip label={`Whisper ${user.displayName}`}>
              <button
                type="button"
                onClick={() =>
                  onWhisperParticipant({
                    userId: user.userId as string,
                    nickname: user.displayName
                  })
                }
                className="compact-participant-action"
                aria-label={`Whisper ${user.displayName}`}
              >
                <OmarchyGlyph kind="chat" className="omarchy-mode-icon h-4.5 w-4.5" />
              </button>
            </HoverTooltip>
          ) : null}

          {canAdjustVolume ? (
            <HoverTooltip label={`Adjust ${user.displayName} volume`}>
              <button
                type="button"
                onClick={() => setVolumeEditorOpen((open) => !open)}
                className={cn(
                  "compact-participant-action",
                  user.isThirdPartyMuted && "compact-participant-action-muted"
                )}
                aria-label={`Adjust ${user.displayName} volume`}
                aria-expanded={volumeEditorOpen}
              >
                <OmarchyGlyph
                  kind={user.isThirdPartyMuted ? "volume-off" : "volume"}
                  className="omarchy-mode-icon h-4.5 w-4.5"
                />
              </button>
            </HoverTooltip>
          ) : null}

          {user.isSelfMuted ? <MicOff className="mx-2 h-4 w-4 text-white/36" aria-label="Microphone muted" /> : null}
        </div>
      </div>

      {canAdjustVolume && volumeEditorOpen ? (
        <div className="compact-participant-volume-editor">
          <input
            type="range"
            min={0}
            max={PARTICIPANT_VOLUME_SLIDER_MAX}
            step={1}
            value={participantVolumeSliderValue}
            onChange={(event) =>
              onParticipantVolumeChange(
                volumeIdentity,
                getParticipantVolumeFromSliderValue(Number(event.target.value))
              )
            }
            className="compact-participant-volume-slider"
            style={
              {
                "--compact-volume-fill": `${(participantVolumeSliderValue / PARTICIPANT_VOLUME_SLIDER_MAX) * 100}%`
              } as CSSProperties
            }
            aria-label={`Volume for ${user.displayName}: ${participantVolumePercent}%`}
          />
          <span className="compact-participant-volume-value">{participantVolumePercent}%</span>
          <button
            type="button"
            onClick={() => onToggleThirdPartyMute(volumeIdentity)}
            className={cn(
              "compact-participant-volume-mute",
              user.isThirdPartyMuted && "compact-participant-volume-mute-active"
            )}
            aria-label={user.isThirdPartyMuted ? `Unmute ${user.displayName}` : `Mute ${user.displayName}`}
          >
            {user.isThirdPartyMuted ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function CompactVoiceStage(props: VoiceStageProps) {
  const [demoTimestamp, setDemoTimestamp] = useState(() => Date.now());
  const isConnecting = props.status === "connecting";
  const isPreparingAudio = props.status === "preparing-audio";
  const isConnected = isVoiceConnectedStatus(props.status);

  useEffect(() => {
    if (!props.fillerMode) {
      return;
    }

    const interval = window.setInterval(() => setDemoTimestamp(Date.now()), DEMO_ACTIVITY_TICK_MS);
    return () => window.clearInterval(interval);
  }, [props.fillerMode]);

  const stageUsers = useMemo(
    () =>
      buildStageUsers(
        props.participants,
        props.onlineNicknames,
        props.onlineProfiles,
        props.nickname,
        props.transitionLobbyNicknames,
        props.lingeringNicknames,
        props.knownAvatarSources,
        {
          selfMuted: props.selfMuted,
          selfDeafened: props.selfDeafened,
          thirdPartyMutedIds: props.thirdPartyMutedIds,
          participantVolumes: props.participantVolumes,
          fillerMode: props.fillerMode
        },
        demoTimestamp
      ),
    [
      demoTimestamp,
      props.fillerMode,
      props.knownAvatarSources,
      props.lingeringNicknames,
      props.nickname,
      props.onlineNicknames,
      props.onlineProfiles,
      props.participantVolumes,
      props.participants,
      props.selfDeafened,
      props.selfMuted,
      props.thirdPartyMutedIds,
      props.transitionLobbyNicknames
    ]
  );
  const voiceUsers = stageUsers
    .filter((user) => user.lane === "voice")
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
  const lobbyUsers = stageUsers
    .filter((user) => user.lane === "lobby")
    .sort((left, right) => left.displayName.localeCompare(right.displayName));

  if (props.isChatPanelOpen && props.chatPanelContent) {
    return <section className="compact-panel-stage h-full min-h-0 overflow-hidden">{props.chatPanelContent}</section>;
  }

  return (
    <section
      className="compact-voice-stage relative flex h-full min-h-0 flex-col overflow-hidden"
      aria-label={`${props.roomName} voice room`}
    >
      {props.error ? (
        <div className="compact-stage-error" role="alert">
          {props.error}
        </div>
      ) : null}

      <div className="compact-participant-scroll min-h-0 flex-1 overflow-y-auto px-3">
        <section className="compact-participant-lane" aria-labelledby="compact-live-heading">
          <div className="compact-lane-heading">
            <span id="compact-live-heading">Live</span>
            <span className="compact-lane-line" />
            <span className="compact-lane-count">{voiceUsers.length}</span>
          </div>
          <div className="space-y-1">
            {voiceUsers.map((user) => (
              <CompactParticipantRow
                key={`compact-live-${user.identity}`}
                user={user}
                onInspectStream={props.onInspectStream}
                onToggleThirdPartyMute={props.onToggleThirdPartyMute}
                onParticipantVolumeChange={props.onParticipantVolumeChange}
                onWhisperParticipant={props.onWhisperParticipant}
              />
            ))}
          </div>
        </section>

        <section className="compact-participant-lane" aria-labelledby="compact-lobby-heading">
          <div className="compact-lane-heading">
            <span id="compact-lobby-heading">Lobby</span>
            <span className="compact-lane-line" />
            <span className="compact-lane-count">{lobbyUsers.length}</span>
          </div>
          <div className="space-y-1">
            {lobbyUsers.map((user) => (
              <CompactParticipantRow
                key={`compact-lobby-${user.identity}`}
                user={user}
                onInspectStream={props.onInspectStream}
                onToggleThirdPartyMute={props.onToggleThirdPartyMute}
                onParticipantVolumeChange={props.onParticipantVolumeChange}
                onWhisperParticipant={props.onWhisperParticipant}
              />
            ))}
          </div>
        </section>
      </div>

      <div className="compact-stage-controls pointer-events-none absolute inset-x-0 z-20 flex items-center justify-center gap-4">
        <HoverTooltip label={props.noiseFilterEnabled ? "Disable noise filter" : "Enable noise filter"}>
          <button
            type="button"
            role="switch"
            aria-checked={props.noiseFilterEnabled}
            disabled={isConnecting || isPreparingAudio}
            onClick={props.onToggleNoiseFilter}
            className={cn(
              "compact-stage-control pointer-events-auto",
              props.noiseFilterEnabled && "compact-stage-control-active",
              props.krispFailed && "compact-stage-control-danger"
            )}
            aria-label={props.noiseFilterEnabled ? "Disable noise filter" : "Enable noise filter"}
          >
            <OmarchyGlyph kind="noise" className="omarchy-mode-icon h-5 w-5" />
          </button>
        </HoverTooltip>

        <HoverTooltip label={props.isSharing ? "Stop stream" : "Go live"}>
          <button
            type="button"
            disabled={!isConnected}
            onClick={props.onToggleScreenShare}
            className={cn(
              "compact-stage-control pointer-events-auto",
              props.isSharing && "compact-stage-control-streaming"
            )}
            aria-label={props.isSharing ? "Stop sharing screen" : "Share screen"}
          >
            <OmarchyGlyph kind={props.isSharing ? "share-off" : "share"} className="omarchy-mode-icon h-5 w-5" />
          </button>
        </HoverTooltip>

        <HoverTooltip
          label={isConnecting || isPreparingAudio ? "Cancel connection" : isConnected ? "Leave voice" : "Join voice"}
        >
          <button
            type="button"
            onClick={isConnecting || isPreparingAudio ? props.onCancelJoin : isConnected ? props.onLeave : props.onJoin}
            onPointerEnter={() => props.onPrimeJoin("compact-control-pointer-enter")}
            onFocus={() => props.onPrimeJoin("compact-control-focus")}
            className={cn(
              "compact-stage-control compact-stage-control-primary pointer-events-auto",
              isConnected && "compact-stage-control-connected"
            )}
            aria-label={isConnecting || isPreparingAudio ? "Cancel voice connection" : isConnected ? "Leave voice" : "Join voice"}
          >
            {isConnecting || isPreparingAudio ? (
              <LoaderCircle className="h-6 w-6 animate-spin" />
            ) : (
              <VoiceChannelGlyph connected={isConnected} />
            )}
          </button>
        </HoverTooltip>
      </div>

      {props.isUpdateInstallStageActive ? (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-[rgba(15,31,34,0.9)]">
          <UpdateInstallHourglass />
        </div>
      ) : null}
    </section>
  );
}

function VoiceStage({
  roomName,
  nickname,
  status,
  error,
  isSharing,
  participants,
  onlineNicknames,
  onlineProfiles,
  transitionLobbyNicknames,
  lingeringNicknames,
  selfMuted,
  selfDeafened,
  thirdPartyMutedIds,
  participantVolumes,
  suppressLayoutMotion,
  selectedStreamLabel,
  selectedStreamIsPlaceholder,
  selectedStreamIsPending,
  isStreamViewerOpen,
  isUpdateInstallStageActive,
  isChatPanelOpen,
  chatPanelContent,
  isRemoteFullscreen,
  outputMuted,
  outputVolume,
  showStreamStats,
  streamStats,
  hubRef,
  ringRef,
  onWhisperParticipant,
  onToggleThirdPartyMute,
  onParticipantVolumeChange,
  onInspectStream,
  dockedStreamStageRef,
  dockedScreenContainerRef,
  onCloseStreamViewer,
  onPopOutStream,
  onToggleRemoteFullscreen,
  onToggleStreamOutputMuted,
  onOutputVolumeChange,
  localAvatarSrc,
  knownAvatarSources,
  onJoin,
  onPrimeJoin,
  onCancelJoin,
  onLeave,
  onToggleScreenShare,
  fillerMode,
  performanceMode,
  krispSupported,
  krispFailed,
  krispPrewarmState,
  noiseFilterEnabled,
  onToggleNoiseFilter
}: VoiceStageProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const mainShellRef = useRef<HTMLDivElement>(null);
  const shellRotationRef = useRef(0);
  const shellSpeedMultiplierRef = useRef(1);
  const mainButtonHoveredRef = useRef(false);
  const isConnectedRef = useRef(false);
  const isConnectingRef = useRef(false);
  const reduceMotion = useReducedMotion();
  const motionDisabled = !!reduceMotion || performanceMode;
  const [scatterSeed] = useState(() => getVoiceFlowSessionSeed());
  const [flowParticles, setFlowParticles] = useState<FlowParticle[]>([]);
  const [hasPlayedEntry, setHasPlayedEntry] = useState(false);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [stageViewportTop, setStageViewportTop] = useState(0);
  const [chatVerticalCompensationActive, setChatVerticalCompensationActive] = useState(false);
  const lastStableStageSizeRef = useRef({ width: 0, height: 0 });
  const lastStableStageTopRef = useRef(0);
  const chatVerticalCompensationTimeoutRef = useRef<number | null>(null);
  const [pillLayoutWidths, setPillLayoutWidths] = useState<Record<string, number>>({});
  const [buttonBurst, setButtonBurst] = useState(false);
  const [mainButtonHovered, setMainButtonHovered] = useState(false);
  const [demoTimestamp, setDemoTimestamp] = useState(() => Date.now());
  const flowRngRef = useRef(createFlowRng(scatterSeed));
  const flowParticleIdRef = useRef(0);

  const stageUsers = useMemo(
    () =>
      buildStageUsers(
        participants,
        onlineNicknames,
        onlineProfiles,
        nickname,
        transitionLobbyNicknames,
        lingeringNicknames,
        knownAvatarSources,
        {
          selfMuted,
          selfDeafened,
          thirdPartyMutedIds,
          participantVolumes,
          fillerMode
        },
        demoTimestamp
      ),
    [
      participants,
      onlineNicknames,
      onlineProfiles,
      nickname,
      transitionLobbyNicknames,
      lingeringNicknames,
      knownAvatarSources,
      selfMuted,
      selfDeafened,
      thirdPartyMutedIds,
      participantVolumes,
      fillerMode,
      demoTimestamp
    ]
  );
  const voiceUsers = useMemo(
    () =>
      stageUsers
        .filter((user) => user.lane === "voice")
        .sort((left, right) =>
          left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" })
        ),
    [stageUsers]
  );
  const lobbyUsers = useMemo(
    () =>
      stageUsers
        .filter((user) => user.lane === "lobby")
        .sort((left, right) =>
          left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" })
        ),
    [stageUsers]
  );
  const isConnecting = status === "connecting";
  const isPreparingAudio = status === "preparing-audio";
  const isConnected = isVoiceConnectedStatus(status);
  const noiseFilterToggleDisabled = isConnecting || isPreparingAudio;
  mainButtonHoveredRef.current = mainButtonHovered;
  isConnectedRef.current = isConnected;
  isConnectingRef.current = isConnecting || isPreparingAudio;
  const krispBadgeFailed = noiseFilterEnabled && (krispFailed || status === "degraded");
  const krispLoading = noiseFilterEnabled && krispPrewarmState === "loading";
  const krispTooltip = noiseFilterToggleDisabled
    ? "Audio setup is in progress. Enhanced noise suppression can be changed after joining or cancelling."
    : !noiseFilterEnabled
    ? "Enhanced noise suppression is off. Click to enable it for your next microphone session."
    : krispBadgeFailed
      ? "Enhanced filtering could not become ready in time. SovChat is using browser noise suppression."
      : krispLoading
        ? "Enhanced noise suppression is warming up. You can still join voice while it prepares."
        : isConnected && !selfMuted
          ? "Local noise filtering is actively cleaning your mic input."
          : krispSupported
            ? "The local noise filter is ready and will clean your mic input when your microphone is live."
            : "Enhanced noise suppression is enabled and will prepare before your microphone is published.";
  const krispBadgeTitle = !noiseFilterEnabled
    ? "Enhanced filtering off"
    : krispBadgeFailed
      ? "Browser filtering active"
      : krispLoading
        ? "Enhanced filtering loading"
        : "Enhanced filtering on";
  const voiceCtaLabel = isPreparingAudio
    ? "Preparing audio..."
    : isConnecting
      ? "Connecting..."
    : mainButtonHovered
      ? isConnected
        ? "Leave voice"
        : "Connect"
      : isConnected
        ? "Connected"
        : "Join voice";

  useEffect(() => {
    if (motionDisabled) {
      setFlowParticles([]);
      return;
    }

    const inboundSpawnPoints = Array.from({ length: 10 }, (_, index) => ({
      x: 74 + ((index % 3) - 1) * 1.6,
      y: 8 + (index * 84) / 9
    }));
    const outboundSpawnPoints = Array.from({ length: 10 }, (_, index) => ({
      x: 20 + ((index % 3) - 1) * 1.6,
      y: 8 + (index * 84) / 9
    }));
    let spawnTimeout = 0;
    let pruneInterval = 0;
    let cancelled = false;
    const rng = flowRngRef.current;

    const spawnParticle = () => {
      const outbound = isConnectedRef.current;
      const spawnPoint = outbound
        ? outboundSpawnPoints[Math.floor(rng() * outboundSpawnPoints.length)]
        : inboundSpawnPoints[Math.floor(rng() * inboundSpawnPoints.length)];
      const variant = Math.floor(rng() * 3) as 0 | 1 | 2;
      const durationMs = Math.round(3200 + rng() * 2200);
      const isAmber = rng() < 0.1;
      const centerX = 50 + (rng() - 0.5) * 3.6;
      const centerY = 50 + (rng() - 0.5) * 3.4;
      const startY = spawnPoint.y + (rng() - 0.5) * 12;
      const endY = spawnPoint.y + (rng() - 0.5) * 12;
      const startX = spawnPoint.x + (rng() - 0.5) * 4.8;
      const endX = spawnPoint.x + (rng() - 0.5) * 4.8;
      const curveOffsetX = variant === 0 ? -7.5 : variant === 1 ? 0 : 7.5;
      const curveOffsetY = variant === 0 ? -8 : variant === 1 ? 0 : 8;
      const inboundStartX = outbound ? centerX : startX;
      const inboundStartY = outbound ? centerY : startY;
      const inboundEndX = outbound ? endX : centerX;
      const inboundEndY = outbound ? endY : centerY;
      const outboundStartX = centerX;
      const outboundStartY = centerY;
      const outboundEndX = endX;
      const outboundEndY = endY;
      const inboundBaseMidX = (inboundStartX + inboundEndX) / 2;
      const inboundBaseMidY = (inboundStartY + inboundEndY) / 2;
      const outboundBaseMidX = (outboundStartX + outboundEndX) / 2;
      const outboundBaseMidY = (outboundStartY + outboundEndY) / 2;
      const inboundMidX = inboundBaseMidX + curveOffsetX;
      const inboundMidY = inboundBaseMidY + curveOffsetY;
      const outboundMidX = outboundBaseMidX - curveOffsetX;
      const outboundMidY = outboundBaseMidY - curveOffsetY;
      const now = Date.now();
      const particle: FlowParticle = {
        key: `flow-${flowParticleIdRef.current += 1}`,
        variant,
        isAmber,
        durationMs,
        expiresAt: now + durationMs + 120,
        sizePx: Number((2.35 + rng() * 3.35).toFixed(2)),
        alpha: Number((0.11 + rng() * 0.2).toFixed(3)),
        glow: Number((0.08 + rng() * 0.1).toFixed(3)),
        amberAlpha: Number((0.97 + rng() * 0.03).toFixed(3)),
        inboundStartX,
        inboundBaseMidX,
        inboundMidX,
        inboundLateX: ((inboundMidX + inboundEndX) / 2) + curveOffsetX * 0.18,
        inboundEndX,
        inboundStartY,
        inboundBaseMidY,
        inboundMidY,
        inboundLateY: ((inboundMidY + inboundEndY) / 2) + curveOffsetY * 0.18,
        inboundEndY,
        outboundStartX,
        outboundBaseMidX,
        outboundMidX,
        outboundLateX: ((outboundMidX + outboundEndX) / 2) - curveOffsetX * 0.18,
        outboundEndX,
        outboundStartY,
        outboundBaseMidY,
        outboundMidY,
        outboundLateY: ((outboundMidY + outboundEndY) / 2) - curveOffsetY * 0.18,
        outboundEndY
      };

      setFlowParticles((previous) =>
        [...previous.filter((entry) => entry.expiresAt > now), particle].slice(-20)
      );
    };

    const scheduleSpawn = () => {
      if (cancelled) {
        return;
      }

      const delayMs = Math.round(80 + rng() * 220);
      spawnTimeout = window.setTimeout(() => {
        if (cancelled) {
          return;
        }
        if (typeof document === "undefined" || !document.hidden) {
          spawnParticle();
        }
        scheduleSpawn();
      }, delayMs);
    };

    pruneInterval = window.setInterval(() => {
      const now = Date.now();
      setFlowParticles((previous) => previous.filter((entry) => entry.expiresAt > now));
    }, 320);

    scheduleSpawn();

    return () => {
      cancelled = true;
      if (spawnTimeout) {
        window.clearTimeout(spawnTimeout);
      }
      if (pruneInterval) {
        window.clearInterval(pruneInterval);
      }
    };
  }, [motionDisabled, scatterSeed]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }
      setDemoTimestamp(Date.now());
    }, DEMO_ACTIVITY_TICK_MS);

    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const shell = mainShellRef.current;
    if (!shell || motionDisabled) {
      if (shell) {
        shell.style.setProperty("--voice-shell-rotation", `${shellRotationRef.current.toFixed(3)}deg`);
      }
      return;
    }

    const baseDegreesPerMs = 360 / 18_000;
    let frameId = 0;
    let lastTimestamp = performance.now();

    const tick = (timestamp: number) => {
      const delta = Math.min(48, timestamp - lastTimestamp);
      lastTimestamp = timestamp;
      const targetMultiplier =
        !isConnectedRef.current && !isConnectingRef.current && mainButtonHoveredRef.current ? 3 : 1;
      const ramp = 1 - Math.exp(-delta / 140);
      shellSpeedMultiplierRef.current +=
        (targetMultiplier - shellSpeedMultiplierRef.current) * ramp;
      shellRotationRef.current =
        (shellRotationRef.current + delta * baseDegreesPerMs * shellSpeedMultiplierRef.current) % 360;
      shell.style.setProperty("--voice-shell-rotation", `${shellRotationRef.current.toFixed(3)}deg`);
      frameId = window.requestAnimationFrame(tick);
    };

    shell.style.setProperty("--voice-shell-rotation", `${shellRotationRef.current.toFixed(3)}deg`);
    frameId = window.requestAnimationFrame(tick);

    return () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [motionDisabled]);

  useLayoutEffect(() => {
    const element = stageRef.current;
    if (!element) {
      return;
    }

    let cancelled = false;
    let settleFrameId = 0;
    let settleFramesRemaining = 0;

    const updateStageMetrics = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }

      const nextWidth = Math.round(rect.width);
      const nextHeight = Math.round(rect.height);
      const nextTop = Math.round(rect.top);

      setStageSize((previous) =>
        previous.width === nextWidth && previous.height === nextHeight
          ? previous
          : {
              width: nextWidth,
              height: nextHeight
            }
      );
      setStageViewportTop((previous) => (previous === nextTop ? previous : nextTop));
    };

    const scheduleSettledMetrics = (frames = STAGE_METRIC_SETTLE_FRAMES) => {
      settleFramesRemaining = Math.max(settleFramesRemaining, frames);

      if (settleFrameId) {
        return;
      }

      const tick = () => {
        settleFrameId = 0;
        if (cancelled) {
          return;
        }

        updateStageMetrics();
        settleFramesRemaining -= 1;

        if (settleFramesRemaining > 0) {
          settleFrameId = window.requestAnimationFrame(tick);
        }
      };

      settleFrameId = window.requestAnimationFrame(tick);
    };

    const handleMetricInvalidation = () => {
      updateStageMetrics();
      scheduleSettledMetrics(2);
    };

    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(handleMetricInvalidation);

    updateStageMetrics();
    scheduleSettledMetrics();
    observer?.observe(element);
    window.addEventListener("resize", handleMetricInvalidation);
    window.visualViewport?.addEventListener("resize", handleMetricInvalidation);
    void document.fonts?.ready.then(() => {
      if (!cancelled) {
        handleMetricInvalidation();
      }
    });

    return () => {
      cancelled = true;
      if (settleFrameId) {
        window.cancelAnimationFrame(settleFrameId);
      }
      observer?.disconnect();
      window.removeEventListener("resize", handleMetricInvalidation);
      window.visualViewport?.removeEventListener("resize", handleMetricInvalidation);
    };
  }, []);

  useEffect(() => {
    if (!isConnected || motionDisabled) {
      setButtonBurst(false);
      return;
    }

    setButtonBurst(true);
    const timeout = window.setTimeout(() => setButtonBurst(false), 860);
    return () => window.clearTimeout(timeout);
  }, [isConnected, motionDisabled]);

  useEffect(() => {
    if (stageSize.width > 0 && stageUsers.length > 0 && !hasPlayedEntry) {
      setHasPlayedEntry(true);
    }
  }, [hasPlayedEntry, stageSize.width, stageUsers.length]);

  useEffect(() => {
    const activeIds = new Set(stageUsers.map((user) => user.identity));

    setPillLayoutWidths((previous) => {
      const nextEntries = Object.entries(previous).filter(([identity]) => activeIds.has(identity));

      if (nextEntries.length === Object.keys(previous).length) {
        return previous;
      }

      return Object.fromEntries(nextEntries);
    });
  }, [stageUsers]);

  const layoutStageSize =
    isRemoteFullscreen && lastStableStageSizeRef.current.width > 0
      ? lastStableStageSizeRef.current
      : stageSize;
  const updateLayoutOpen = isUpdateInstallStageActive;
  const streamLayoutOpen = isStreamViewerOpen || updateLayoutOpen;
  const chatLayoutOpen = isChatPanelOpen && !streamLayoutOpen;

  useLayoutEffect(() => {
    const element = stageRef.current;
    if (!element) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return;
      }
      setStageViewportTop((previous) => (previous === rect.top ? previous : rect.top));
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [chatLayoutOpen]);

  useEffect(() => {
    if (chatLayoutOpen) {
      if (chatVerticalCompensationTimeoutRef.current !== null) {
        window.clearTimeout(chatVerticalCompensationTimeoutRef.current);
        chatVerticalCompensationTimeoutRef.current = null;
      }
      setChatVerticalCompensationActive(true);
      return;
    }

    if (!chatVerticalCompensationActive) {
      return;
    }

    chatVerticalCompensationTimeoutRef.current = window.setTimeout(() => {
      chatVerticalCompensationTimeoutRef.current = null;
      setChatVerticalCompensationActive(false);
    }, CHAT_STAGE_VERTICAL_SETTLE_MS);

    return () => {
      if (chatVerticalCompensationTimeoutRef.current !== null) {
        window.clearTimeout(chatVerticalCompensationTimeoutRef.current);
        chatVerticalCompensationTimeoutRef.current = null;
      }
    };
  }, [chatLayoutOpen, chatVerticalCompensationActive]);

  useEffect(() => {
    return () => {
      if (chatVerticalCompensationTimeoutRef.current !== null) {
        window.clearTimeout(chatVerticalCompensationTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (
      !isRemoteFullscreen &&
      !chatVerticalCompensationActive &&
      stageSize.width > 0 &&
      stageSize.height > 0
    ) {
      lastStableStageSizeRef.current = stageSize;
      lastStableStageTopRef.current = stageViewportTop;
    }
  }, [chatVerticalCompensationActive, isRemoteFullscreen, stageSize, stageViewportTop]);

  const layoutStageHeight =
    chatVerticalCompensationActive && lastStableStageSizeRef.current.height > 0
      ? lastStableStageSizeRef.current.height
      : layoutStageSize.height;
  const chatStageVerticalOffset =
    chatVerticalCompensationActive && lastStableStageSizeRef.current.height > 0
      ? Math.round(lastStableStageTopRef.current - stageViewportTop)
      : 0;
  const centerX = layoutStageSize.width / 2;
  const centerY = layoutStageHeight / 2;
  const hubTop = centerY - MAIN_BUTTON_CENTER_OFFSET;
  const shareFlowBridgeTop = hubTop + SHARE_FLOW_BRIDGE_TOP_OFFSET;
  const shareFlowBridgeEnd = centerY + SHARE_BUTTON_TOP_OFFSET + 1;
  const shareFlowBridgeHeight = Math.max(
    36,
    shareFlowBridgeEnd - shareFlowBridgeTop
  );
  const shareButtonVisible = isConnected && !updateLayoutOpen;
  const shareBridgeVisible = isConnected && !chatLayoutOpen && !updateLayoutOpen;
  const shareButtonHiddenMotion = motionDisabled
    ? { opacity: 0, y: 0, scale: 1 }
    : { opacity: 0, y: -SHARE_BUTTON_TOP_OFFSET, scale: 0.82 };
  const shareButtonTransition = motionDisabled
    ? ({ duration: 0 } as const)
    : ({ type: "spring", stiffness: 240, damping: 30, mass: 0.86 } as const);
  const shareBridgeTransition = motionDisabled
    ? ({ duration: 0 } as const)
    : ({
        height: { duration: 0.46, ease: [0.22, 1, 0.36, 1] },
        opacity: { duration: 0.18, ease: "easeOut" }
      } as const);
  const dockedStreamStageVisible = isStreamViewerOpen && !updateLayoutOpen && !isRemoteFullscreen;
  const dockedChatPanelVisible = chatLayoutOpen && !isRemoteFullscreen;
  const dockedStreamStageWidth = streamLayoutOpen
    ? Math.max(
        STREAM_STAGE_MIN_WIDTH,
        Math.min(STREAM_STAGE_MAX_WIDTH, layoutStageSize.width * 0.45)
      )
    : 0;
  const dockedChatPanelWidth = dockedChatPanelVisible
    ? Math.max(360, Math.min(layoutStageSize.width, Math.round(layoutStageSize.width * 0.6)))
    : 0;
  const laneInnerOffset = CORE_OUTER_RADIUS + RAIL_INNER_GAP;
  const leftLaneInnerEdge = Math.max(STAGE_EDGE_INSET + 152, centerX - laneInnerOffset);
  const rightLaneInnerEdge = Math.min(
    layoutStageSize.width - STAGE_EDGE_INSET - 152,
    centerX + laneInnerOffset
  );
  function getEstimatedWidth(label: string) {
    return Math.max(152, Math.min(460, label.length * 10.2 + 108));
  }
  function getLayoutWidth(identity: string, label: string) {
    const measuredWidth = pillLayoutWidths[identity];
    return measuredWidth && measuredWidth > 0 ? measuredWidth : getEstimatedWidth(label);
  }

  function getLanePositions(laneUsers: StageUser[], lane: "voice" | "lobby") {
    const positions = new Map<string, { x: number; y: number }>();

    if (!laneUsers.length) {
      return positions;
    }

    const availableHeight = Math.max(
      VOICE_PILL_HEIGHT,
      layoutStageHeight - VOICE_PILL_VERTICAL_PADDING * 2
    );
    const rowsPerColumn = Math.max(
      1,
      Math.floor((availableHeight + VOICE_PILL_GAP) / (VOICE_PILL_HEIGHT + VOICE_PILL_GAP))
    );
    const columnCount = Math.max(1, Math.ceil(laneUsers.length / rowsPerColumn));
    const totalRows = Math.max(1, Math.ceil(laneUsers.length / columnCount));
    const rows = Array.from({ length: totalRows }, () => [] as StageUser[]);

    laneUsers.forEach((laneUser, index) => {
      rows[Math.floor(index / columnCount)]?.push(laneUser);
    });

    const sharedColumnHeight =
      totalRows * VOICE_PILL_HEIGHT + Math.max(0, totalRows - 1) * VOICE_PILL_GAP;
    const sharedStartY = Math.round(centerY - sharedColumnHeight / 2);

    const laneBaseX = Math.round(
      streamLayoutOpen
        ? lane === "voice"
          ? STAGE_EDGE_INSET
          : layoutStageSize.width - STAGE_EDGE_INSET
        : chatLayoutOpen
          ? lane === "voice"
            ? STAGE_EDGE_INSET
            : layoutStageSize.width + STAGE_EDGE_INSET + 48
        : lane === "voice"
          ? leftLaneInnerEdge
          : rightLaneInnerEdge
    );
    const stageMaxRightEdge = layoutStageSize.width - STAGE_EDGE_INSET;
    const hubLeftGuard = centerX - CORE_OUTER_RADIUS - HUB_PILL_CLEARANCE;
    const hubRightGuard = centerX + CORE_OUTER_RADIUS + HUB_PILL_CLEARANCE;
    const laneMinLeftEdge =
      !streamLayoutOpen && !chatLayoutOpen && lane === "lobby"
        ? Math.min(stageMaxRightEdge, Math.max(STAGE_EDGE_INSET, hubRightGuard))
        : STAGE_EDGE_INSET;
    const laneMaxRightEdge =
      chatLayoutOpen && lane === "voice"
        ? Math.max(
            STAGE_EDGE_INSET + 180,
            layoutStageSize.width - dockedChatPanelWidth - STAGE_EDGE_INSET - 24
          )
        : !streamLayoutOpen && !chatLayoutOpen && lane === "voice"
          ? Math.max(STAGE_EDGE_INSET, Math.min(stageMaxRightEdge, hubLeftGuard))
          : stageMaxRightEdge;
    const stackDirection = streamLayoutOpen
      ? lane === "voice"
        ? 1
        : -1
      : chatLayoutOpen
        ? lane === "voice"
          ? 1
          : -1
      : lane === "voice"
        ? -1
        : 1;
    for (let rowIndex = 0; rowIndex < totalRows; rowIndex += 1) {
      const rowUsers = rows[rowIndex] ?? [];
      const rowItems = rowUsers.map((rowUser) => {
        const label = rowUser.isLocal ? nickname : rowUser.displayName;

        return {
          user: rowUser,
          width: getLayoutWidth(rowUser.identity, label)
        };
      });
      const visualRowItems = stackDirection < 0 ? [...rowItems].reverse() : rowItems;
      const rowWidth =
        rowItems.reduce((totalWidth, rowItem) => totalWidth + rowItem.width, 0) +
        Math.max(0, rowItems.length - 1) * VOICE_PILL_COLUMN_GAP;
      const rowAnchorX =
        streamLayoutOpen || chatLayoutOpen
          ? laneBaseX
          : lane === "voice"
            ? leftLaneInnerEdge
            : rightLaneInnerEdge;
      const preferredRowX = stackDirection < 0 ? rowAnchorX - rowWidth : rowAnchorX;
      const rowMaxX = Math.max(laneMinLeftEdge, laneMaxRightEdge - rowWidth);
      const rowX = Math.min(Math.max(laneMinLeftEdge, preferredRowX), rowMaxX);
      const y = Math.round(sharedStartY + rowIndex * (VOICE_PILL_HEIGHT + VOICE_PILL_GAP));
      let cursorX = rowX;

      for (const rowItem of visualRowItems) {
        positions.set(rowItem.user.identity, { x: Math.round(cursorX), y });
        cursorX += rowItem.width + VOICE_PILL_COLUMN_GAP;
      }
    }

    return positions;
  }

  const voiceLanePositions = useMemo(
    () => getLanePositions(voiceUsers, "voice"),
    [
      chatLayoutOpen,
      voiceUsers,
      centerY,
      leftLaneInnerEdge,
      nickname,
      pillLayoutWidths,
      layoutStageHeight,
      layoutStageSize.width,
      streamLayoutOpen
    ]
  );
  const lobbyLanePositions = useMemo(
    () => getLanePositions(lobbyUsers, "lobby"),
    [
      chatLayoutOpen,
      lobbyUsers,
      centerY,
      nickname,
      pillLayoutWidths,
      rightLaneInnerEdge,
      layoutStageHeight,
      layoutStageSize.width,
      streamLayoutOpen
    ]
  );

  function getPillPosition(user: StageUser) {
    if (user.lane === "voice") {
      return (
        voiceLanePositions.get(user.identity) ?? {
          x: leftLaneInnerEdge - getEstimatedWidth(user.isLocal ? nickname : user.displayName),
          y: centerY,
          opacity: 1
        }
      );
    }

    const hiddenLobbyX = layoutStageSize.width + getEstimatedWidth(user.isLocal ? nickname : user.displayName) + 72;
    const baseLobbyPosition = lobbyLanePositions.get(user.identity) ?? {
      x: rightLaneInnerEdge,
      y: centerY
    };

    return chatLayoutOpen
      ? {
          x: hiddenLobbyX,
          y: baseLobbyPosition.y,
          opacity: 0
        }
      : {
          ...baseLobbyPosition,
          opacity: 1
        };
  }

  return (
    <section className="relative flex h-full min-h-[72vh] flex-col overflow-hidden">
      {error ? (
        <div className="pointer-events-none absolute left-1/2 top-0 z-30 -translate-x-1/2 rounded-full border border-[color:rgba(255,123,123,0.24)] bg-[color:rgba(76,28,28,0.7)] px-4 py-2 text-sm text-[var(--danger)] shadow-[0_10px_30px_rgba(0,0,0,0.18)]">
          {error}
        </div>
      ) : null}

      <div ref={stageRef} className="voice-stage relative flex-1 overflow-hidden">
        {!motionDisabled ? (
          <div
            className={cn(
              "voice-flow-field absolute inset-0 z-0",
              isConnected ? "voice-flow-field-outbound" : "voice-flow-field-inbound"
            )}
            aria-hidden="true"
          >
            {flowParticles.map((particle) => (
              <span
                key={particle.key}
                className={cn(
                  "voice-flow-particle",
                  `voice-flow-particle-variant-${particle.variant}`,
                  particle.isAmber && "voice-flow-particle-amber"
                )}
                style={
                  {
                    "--flow-duration": `${particle.durationMs}ms`,
                    "--flow-size": `${particle.sizePx}px`,
                    "--flow-alpha": particle.alpha,
                    "--flow-glow": particle.glow,
                    "--flow-amber-alpha": particle.amberAlpha,
                    "--flow-inbound-start-x": `${particle.inboundStartX}%`,
                    "--flow-inbound-base-mid-x": `${particle.inboundBaseMidX}%`,
                    "--flow-inbound-mid-x": `${particle.inboundMidX}%`,
                    "--flow-inbound-late-x": `${particle.inboundLateX}%`,
                    "--flow-inbound-end-x": `${particle.inboundEndX}%`,
                    "--flow-inbound-start-y": `${particle.inboundStartY}%`,
                    "--flow-inbound-base-mid-y": `${particle.inboundBaseMidY}%`,
                    "--flow-inbound-mid-y": `${particle.inboundMidY}%`,
                    "--flow-inbound-late-y": `${particle.inboundLateY}%`,
                    "--flow-inbound-end-y": `${particle.inboundEndY}%`,
                    "--flow-outbound-start-x": `${particle.outboundStartX}%`,
                    "--flow-outbound-base-mid-x": `${particle.outboundBaseMidX}%`,
                    "--flow-outbound-mid-x": `${particle.outboundMidX}%`,
                    "--flow-outbound-late-x": `${particle.outboundLateX}%`,
                    "--flow-outbound-end-x": `${particle.outboundEndX}%`,
                    "--flow-outbound-start-y": `${particle.outboundStartY}%`,
                    "--flow-outbound-base-mid-y": `${particle.outboundBaseMidY}%`,
                    "--flow-outbound-mid-y": `${particle.outboundMidY}%`,
                    "--flow-outbound-late-y": `${particle.outboundLateY}%`,
                    "--flow-outbound-end-y": `${particle.outboundEndY}%`
                  } as CSSProperties
                }
              />
            ))}
          </div>
        ) : null}

        <motion.div
          className="absolute inset-0"
          style={{ y: chatStageVerticalOffset }}
          transition={{ y: { duration: 0 } }}
        >
          {!updateLayoutOpen ? (
            <motion.div
              className="pointer-events-none absolute z-10"
              style={{ left: `${centerX}px`, top: `${centerY}px` }}
              animate={
                chatLayoutOpen
                  ? { opacity: 0, y: -8, scale: 0.98 }
                  : { opacity: 1, y: 0, scale: 1 }
              }
              transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="flex w-[min(46vw,472px)] -translate-x-1/2 -translate-y-1/2 items-center justify-between">
                <div className="voice-lane-label voice-lane-label-live">
                  <span className="voice-lane-label-line" />
                  <span className="voice-lane-label-text">LIVE</span>
                </div>
                <div className="voice-lane-label voice-lane-label-lobby">
                  <span className="voice-lane-label-text">LOBBY</span>
                  <span className="voice-lane-label-line" />
                </div>
              </div>
            </motion.div>
          ) : null}

          {stageSize.width > 0
            ? stageUsers.map((user) => (
                <VoiceStagePill
                  key={user.identity}
                  user={user}
                  nickname={nickname}
                  localAvatarSrc={localAvatarSrc}
                  position={getPillPosition(user)}
                  hasPlayedEntry={hasPlayedEntry}
                  lockVerticalMotion={chatVerticalCompensationActive}
                  suppressLayoutMotion={suppressLayoutMotion}
                  reduceMotion={motionDisabled}
                  setPillLayoutWidths={setPillLayoutWidths}
                  onToggleThirdPartyMute={onToggleThirdPartyMute}
                  onParticipantVolumeChange={onParticipantVolumeChange}
                  onWhisperParticipant={onWhisperParticipant}
                  onInspectStream={onInspectStream}
                />
              ))
            : null}

          <motion.div
            className="absolute z-20"
            style={{ left: `${centerX}px`, top: `${hubTop}px` }}
            animate={
              chatLayoutOpen
                ? { opacity: 0, scale: 0.9, x: 84 }
                : { opacity: 1, scale: 1, x: 0 }
            }
            transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
          >
            <div
              ref={hubRef}
              className={cn(
                "voice-hub flex -translate-x-1/2 -translate-y-1/2 flex-col items-center",
                updateLayoutOpen && "voice-hub-update-install",
                isConnecting && "voice-hub-connecting",
                isConnected && "voice-hub-connected",
                buttonBurst && "voice-hub-burst"
              )}
              style={{ "--voice-energy": "0.000" } as CSSProperties}
            >
              {updateLayoutOpen ? (
                <UpdateInstallHourglass />
              ) : (
                <>
                  <div
                    className={cn(
                      "voice-main-label mb-[50px] text-[11px] uppercase tracking-[0.34em]",
                      isConnected && !mainButtonHovered && !isConnecting
                        ? "voice-main-label-connected"
                        : "text-[var(--muted)]",
                      mainButtonHovered && !isConnecting && "voice-main-label-hover"
                    )}
                  >
                    {voiceCtaLabel}
                  </div>

                  <div ref={mainShellRef} className="voice-main-shell">
                    {isConnected ? (
                      <VoiceRing ringRef={ringRef} />
                    ) : null}

                    <button
                      type="button"
                      onClick={isConnecting || isPreparingAudio ? onCancelJoin : isConnected ? onLeave : onJoin}
                      onPointerEnter={() => {
                        onPrimeJoin("hub-pointer-enter");
                        setMainButtonHovered(true);
                      }}
                      onFocus={() => onPrimeJoin("hub-focus")}
                      onPointerDownCapture={() => onPrimeJoin("hub-pointer-down")}
                      onMouseLeave={() => setMainButtonHovered(false)}
                      className={cn(
                        "voice-main-button relative z-10 inline-flex items-center justify-center rounded-full",
                        isConnected && "voice-main-button-connected",
                        (isConnecting || isPreparingAudio) && "voice-main-button-connecting"
                      )}
                      aria-label={
                        isConnecting || isPreparingAudio ? "Cancel voice connection" : isConnected ? "Leave voice" : "Join voice"
                      }
                      title={
                        isConnecting || isPreparingAudio ? "Cancel voice connection" : isConnected ? "Leave voice" : "Join voice"
                      }
                    >
                      {isConnecting || isPreparingAudio ? (
                        <LoaderCircle className="h-10 w-10 animate-spin" />
                      ) : isConnected ? (
                        <VoiceChannelGlyph connected />
                      ) : (
                        <VoiceChannelGlyph connected={false} />
                      )}
                    </button>
                  </div>
                </>
              )}
            </div>

          </motion.div>

          <AnimatePresence initial={false}>
            {shareBridgeVisible ? (
              <motion.div
                key="share-flow-bridge"
                className="voice-share-particle-bridge pointer-events-none absolute z-10"
                style={
                  {
                    left: `${centerX}px`,
                    top: `${shareFlowBridgeTop}px`
                  } as CSSProperties
                }
                initial={motionDisabled ? false : { opacity: 0, height: 0 }}
                animate={{ opacity: 0.86, height: shareFlowBridgeHeight }}
                exit={{ opacity: 0, height: 0 }}
                transition={shareBridgeTransition}
                aria-hidden="true"
              >
                {isSharing && !motionDisabled
                  ? Array.from({ length: 14 }, (_, index) => (
                      <span
                        key={`share-flow-${index}`}
                        className={cn(
                          "voice-share-particle",
                          index % 2 === 0 ? "voice-share-particle-down" : "voice-share-particle-up",
                          index % 5 === 0 && "voice-share-particle-amber"
                        )}
                        style={
                          {
                            "--share-flow-delay": `${index * -0.34}s`,
                            "--share-flow-x": `${((index % 4) - 1.5) * 3}px`,
                            "--share-flow-size": `${index % 5 === 0 ? 3.2 : 2.2 + (index % 3) * 0.45}px`,
                            "--share-flow-alpha": `${index % 5 === 0 ? 0.88 : 0.32 + (index % 4) * 0.06}`
                          } as CSSProperties
                        }
                      />
                    ))
                  : null}
              </motion.div>
            ) : null}
          </AnimatePresence>

          <motion.div
            className="pointer-events-none absolute z-20"
            style={{ left: `${centerX}px`, top: `${centerY}px` }}
            animate={
              chatLayoutOpen || updateLayoutOpen
                ? { opacity: 0, scale: 0.92, x: 84 }
                : { opacity: 1, scale: 1, x: 0 }
            }
            transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="relative h-[360px] w-[220px] -translate-x-1/2 -translate-y-1/2">
              <div
                className="pointer-events-none absolute left-1/2 flex -translate-x-1/2 flex-col items-center"
                style={{ top: `calc(50% + ${SHARE_BUTTON_TOP_OFFSET}px)` }}
              >
                <AnimatePresence initial={false}>
                  {shareButtonVisible ? (
                    <motion.div
                      key="share-button"
                      className="pointer-events-none flex flex-col items-center"
                      initial={motionDisabled ? false : shareButtonHiddenMotion}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={shareButtonHiddenMotion}
                      transition={shareButtonTransition}
                    >
                      <div className="voice-share-button-stack">
                        <HoverTooltip label={isSharing ? "Stop stream" : "Go live"}>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.currentTarget.blur();
                              onToggleScreenShare();
                            }}
                            className={cn(
                              "voice-share-button pointer-events-auto inline-flex items-center justify-center rounded-full",
                              isSharing && "voice-share-button-active"
                            )}
                            aria-label={isSharing ? "Stop sharing screen" : "Share screen"}
                          >
                            {isSharing ? (
                              <span className="voice-share-broadcast" aria-hidden="true">
                                <span className="voice-share-wave voice-share-wave-1" />
                              </span>
                            ) : null}
                            <span className="voice-share-core">
                              <ShareGlyph active={isSharing} />
                            </span>
                          </button>
                        </HoverTooltip>
                      </div>
                      {isSharing ? (
                        <div className="mt-4 whitespace-nowrap text-[11px] uppercase tracking-[0.34em] text-[var(--muted)]">
                          Live streaming
                        </div>
                      ) : null}
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>
            </div>
          </motion.div>
        </motion.div>

        <AnimatePresence>
          {dockedStreamStageVisible && selectedStreamLabel ? (
            <motion.div
              className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center px-4"
              initial={{ opacity: 0, scale: 0.84 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.84 }}
              transition={{
                opacity: { duration: 0.16, ease: "easeOut" },
                scale: { type: "spring", stiffness: 300, damping: 26 }
              }}
            >
              <motion.div
                className="pointer-events-auto voice-stream-dock rounded-[1.1rem] border border-white/8 bg-[rgba(25,39,43,0.74)] p-4 shadow-[0_24px_60px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-xl"
                style={{ width: `${dockedStreamStageWidth}px` }}
                initial={{ scale: 0.92 }}
                animate={{ scale: 1 }}
                exit={{ scale: 0.92 }}
                transition={{ type: "spring", stiffness: 300, damping: 26 }}
              >
              <div className="mb-2 flex items-center justify-between gap-3 text-sm text-[var(--muted)]">
                <div className="flex items-center gap-2">
                  <MonitorUp className="h-4 w-4 text-[var(--accent)]" />
                  {selectedStreamLabel} is sharing
                </div>
              </div>

              <div
                ref={dockedStreamStageRef}
                className="relative aspect-video min-h-[220px] w-full overflow-hidden rounded-[1rem]"
              >
                {showStreamStats ? <StreamStatsBadge stats={streamStats} /> : null}
                {selectedStreamIsPlaceholder ? (
                  <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[1rem] border border-white/8 bg-[radial-gradient(circle_at_25%_20%,rgba(84,221,229,0.2),transparent_28%),radial-gradient(circle_at_78%_22%,rgba(255,202,42,0.16),transparent_26%),linear-gradient(180deg,rgba(16,27,31,0.96),rgba(13,21,24,0.98))]">
                    <div className="relative flex max-w-[360px] flex-col items-center px-6 text-center">
                      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-[1.2rem] border border-[rgba(255,202,42,0.24)] bg-[rgba(255,202,42,0.08)] shadow-[0_18px_40px_rgba(0,0,0,0.2)]">
                        <PanelTop className="h-7 w-7 text-[var(--accent)]" />
                      </div>
                      <div className="text-[0.68rem] uppercase tracking-[0.28em] text-[var(--accent)]">
                        Demo Stream
                      </div>
                      <h3 className="mt-3 text-xl font-semibold text-white">
                        Placeholder broadcast for {selectedStreamLabel}
                      </h3>
                    </div>
                  </div>
                ) : selectedStreamIsPending ? (
                  <div className="flex h-full w-full items-center justify-center rounded-[1rem] border border-white/8 bg-[rgba(13,21,24,0.98)]">
                    <div className="flex flex-col items-center gap-3 text-white/80">
                      <LoaderCircle className="h-8 w-8 animate-spin text-[var(--accent)]" />
                      <div className="text-sm">Waiting for {selectedStreamLabel}&apos;s stream…</div>
                    </div>
                  </div>
                ) : (
                  <div
                    ref={dockedScreenContainerRef}
                    className="h-full w-full overflow-hidden rounded-[1rem]"
                  />
                )}
              </div>
              <StreamControllerDock
                outputMuted={outputMuted}
                outputVolume={outputVolume}
                canPopOut={!selectedStreamIsPlaceholder && !selectedStreamIsPending}
                isFullscreen={isRemoteFullscreen}
                isStreamPoppedOut={false}
                onToggleOutputMuted={onToggleStreamOutputMuted}
                onOutputVolumeChange={onOutputVolumeChange}
                onToggleFullscreen={onToggleRemoteFullscreen}
                onPopOut={onPopOutStream}
                onPopBackIn={onPopOutStream}
                onStopWatching={onCloseStreamViewer}
                className="mt-3 w-full"
              />
              </motion.div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <AnimatePresence>
          {dockedChatPanelVisible && chatPanelContent ? (
            <motion.div
              className="pointer-events-none absolute inset-y-0 right-0 z-40 flex justify-end"
              style={{ width: `${dockedChatPanelWidth}px` }}
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="pointer-events-auto h-full w-full">
                {chatPanelContent}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <div className="voice-krisp-corner-group pointer-events-none">
          <button
            type="button"
            role="switch"
            onClick={onToggleNoiseFilter}
            disabled={noiseFilterToggleDisabled}
            className={cn(
              "voice-krisp-corner pointer-events-auto",
              !noiseFilterEnabled && "voice-krisp-corner-disabled",
              krispLoading && "voice-krisp-corner-loading",
              krispBadgeFailed && "voice-krisp-corner-failed"
            )}
            aria-label={
              noiseFilterToggleDisabled
                ? `${krispBadgeTitle}. Audio setup is in progress.`
                : `${krispBadgeTitle}. Click to turn enhanced noise suppression ${noiseFilterEnabled ? "off" : "on"}.`
            }
            aria-checked={noiseFilterEnabled}
          >
            <span className="voice-krisp-corner-icon" aria-hidden="true">
              <OmarchyGlyph kind="noise" className="omarchy-mode-icon h-4 w-4" />
            </span>
            <span className="voice-krisp-corner-label" aria-hidden="true">
              Noise filter
            </span>
            <span className="voice-krisp-toggle-track" aria-hidden="true">
              <span className="voice-krisp-toggle-thumb" />
            </span>
          </button>
          <div className="voice-krisp-tooltip" role="status" aria-live="polite">
            <div
              className={cn(
                "voice-krisp-tooltip-title",
                krispBadgeFailed && "voice-krisp-tooltip-title-failed"
              )}
            >
              {krispBadgeTitle}
            </div>
            <div className="voice-krisp-tooltip-copy">{krispTooltip}</div>
          </div>
        </div>

      </div>
    </section>
  );
}

export function VoiceRoom({
  roomId,
  userId,
  roomName,
  fillerMode,
  nickname,
  localAvatarSrc,
  localAvatarId,
  localAvatarDataUrl,
  showMainPanel = true,
  compactMode = false,
  fallbackContent,
  isChatPanelOpen = false,
  chatPanelContent = null,
  onPrimaryOverlayChange,
  onWhisperParticipant
}: VoiceRoomProps) {
  const [room, setRoom] = useState<Room | null>(null);
  const [status, setStatus] = useState<VoiceConnectionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [participants, setParticipants] = useState<ParticipantView[]>([]);
  const [voicePresenceParticipants, setVoicePresenceParticipants] = useState<VoicePresenceParticipant[]>(
    []
  );
  const [knownAvatarSources, setKnownAvatarSources] = useState<Partial<Record<string, string>>>({});
  const [onlineNicknames, setOnlineNicknames] = useState<string[]>([]);
  const [onlineProfiles, setOnlineProfiles] = useState<PresenceResponse["profiles"]>([]);
  const [screenTrack, setScreenTrack] = useState<VideoTrack | null>(null);
  const [screenTrackIdentity, setScreenTrackIdentity] = useState<string | null>(null);
  const [selectedStreamIdentity, setSelectedStreamIdentity] = useState<string | null>(null);
  const [nativePopoutStreamIdentity, setNativePopoutStreamIdentity] = useState<string | null>(null);
  const [fullscreenTarget, setFullscreenTarget] = useState<"remote" | null>(null);
  const [isStreamPoppedOut, setIsStreamPoppedOut] = useState(false);
  const [suppressPillLayoutMotion, setSuppressPillLayoutMotion] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [isAfk, setIsAfk] = useState(false);
  const [isScreenSharePickerOpen, setIsScreenSharePickerOpen] = useState(false);
  const [streamTakeoverPrompt, setStreamTakeoverPrompt] = useState<{
    identity: string;
    label: string;
  } | null>(null);
  const [streamTakeoverBusy, setStreamTakeoverBusy] = useState(false);
  const [isUpdateInstallStageActive, setIsUpdateInstallStageActive] = useState(false);
  const [screenShareSources, setScreenShareSources] = useState<DesktopDisplayMediaSource[]>([]);
  const [screenShareSourcesLoading, setScreenShareSourcesLoading] = useState(false);
  const [screenShareIncludeSystemAudio, setScreenShareIncludeSystemAudio] = useState(false);
  const [streamQualityMode, setStreamQualityMode] = useState<StreamQualityMode>("auto");
  const [showStreamStats, setShowStreamStats] = useState(false);
  const [streamStats, setStreamStats] = useState<StreamStatsSnapshot | null>(null);
  const [isMuted, setIsMuted] = useState(audioSettingsStore.getState().inputMuted);
  const [selectedInputId, setSelectedInputId] = useState(
    audioSettingsStore.getState().selectedInputId
  );
  const [selectedOutputId, setSelectedOutputId] = useState(
    audioSettingsStore.getState().selectedOutputId
  );
  const [outputMuted, setOutputMuted] = useState(audioSettingsStore.getState().outputMuted);
  const [noiseFilterEnabled, setNoiseFilterEnabled] = useState(
    audioSettingsStore.getState().noiseFilterEnabled
  );
  const [audioProfile, setAudioProfile] = useState<SovChatAudioProfile>(
    audioSettingsStore.getState().audioProfile
  );
  const voiceGateExperiment: VoiceGateExperiment = DEFAULT_VOICE_GATE_EXPERIMENT;
  const [inputGain, setInputGain] = useState(1);
  const [krispSupported, setKrispSupported] = useState(false);
  const [krispFailed, setKrispFailed] = useState(false);
  const [krispLifecycle, setKrispLifecycle] =
    useState<KrispLifecycleState>("disabled");
  const [krispPrewarmState, setKrispPrewarmState] = useState<KrispPrewarmState>("idle");
  const [krispFallbackReason, setKrispFallbackReason] = useState<string | null>(null);
  const [krispProcessorEnabled, setKrispProcessorEnabled] = useState<boolean | null>(null);
  const [krispAttachedTrackId, setKrispAttachedTrackId] = useState<string | null>(null);
  const [diagnosticFallbackActive, setDiagnosticFallbackActive] = useState(false);
  const [lastAudioError, setLastAudioError] = useState<string | null>(null);
  const [lastDeviceSwitchResult, setLastDeviceSwitchResult] = useState<string | null>(null);
  const [lastProcessorFailure, setLastProcessorFailure] = useState<string | null>(null);
  const [noiseFloorDiagnostics, setNoiseFloorDiagnostics] = useState<{
    warningActive: boolean;
    rms: number | null;
    durationMs: number | null;
    recommendedProfile: SovChatAudioProfile | null;
  }>({
    warningActive: false,
    rms: null,
    durationMs: null,
    recommendedProfile: null
  });
  const [voiceGateDiagnostics, setVoiceGateDiagnostics] = useState<VoiceGateRuntimeState>(
    EMPTY_VOICE_GATE_DIAGNOSTICS
  );
  const [outputVolume, setOutputVolume] = useState(audioSettingsStore.getState().outputVolume);
  const [streamMuted, setStreamMuted] = useState(audioSettingsStore.getState().streamMuted);
  const [streamVolume, setStreamVolume] = useState(audioSettingsStore.getState().streamVolume);
  const microphonePublishPlan = useMemo(() => buildMicrophonePublishPlan(), []);
  const microphonePublishOptions = microphonePublishPlan.options;

  useEffect(() => {
    const handleUpdateInstallStage = (event: Event) => {
      const detail = (event as CustomEvent<DesktopUpdateInstallStageDetail>).detail;

      if (typeof detail?.active === "boolean") {
        setIsUpdateInstallStageActive(detail.active);

        if (detail.active) {
          setFullscreenTarget(null);
        }

        return;
      }

      setIsUpdateInstallStageActive((previous) => !previous);
      setFullscreenTarget(null);
    };

    window.addEventListener(DESKTOP_UPDATE_INSTALL_STAGE_EVENT, handleUpdateInstallStage);

    return () => {
      window.removeEventListener(DESKTOP_UPDATE_INSTALL_STAGE_EVENT, handleUpdateInstallStage);
    };
  }, []);

  useEffect(() => {
    if (!isUpdateInstallStageActive) {
      return;
    }

    const blockMouseEvent = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const eventNames = [
      "pointerdown",
      "pointerup",
      "mousedown",
      "mouseup",
      "click",
      "dblclick",
      "contextmenu"
    ] as const;

    for (const eventName of eventNames) {
      document.addEventListener(eventName, blockMouseEvent, true);
    }

    return () => {
      for (const eventName of eventNames) {
        document.removeEventListener(eventName, blockMouseEvent, true);
      }
    };
  }, [isUpdateInstallStageActive]);

  useEffect(() => {
    const nextEntries = new Map<string, string>();

    for (const participant of participants) {
      if (!participant.avatarSrc) {
        continue;
      }

      nextEntries.set(participant.participantId, participant.avatarSrc);
      if (participant.userId) {
        nextEntries.set(participant.userId, participant.avatarSrc);
      }
      nextEntries.set(participant.displayName, participant.avatarSrc);
    }

    for (const participant of voicePresenceParticipants) {
      if (!participant.avatarSrc) {
        continue;
      }

      nextEntries.set(participant.participantId, participant.avatarSrc);
      if (participant.userId) {
        nextEntries.set(participant.userId, participant.avatarSrc);
      }
      nextEntries.set(participant.displayName, participant.avatarSrc);
    }

    if (nextEntries.size === 0) {
      return;
    }

    setKnownAvatarSources((previous) => {
      let changed = false;
      const nextState = { ...previous };

      for (const [key, value] of nextEntries) {
        if (nextState[key] === value) {
          continue;
        }

        nextState[key] = value;
        changed = true;
      }

      return changed ? nextState : previous;
    });
  }, [participants, voicePresenceParticipants]);

  const mergeKnownAvatarSources = useCallback((entries: Array<[string, string]>) => {
    if (entries.length === 0) {
      return;
    }

    setKnownAvatarSources((previous) => {
      let changed = false;
      const nextState = { ...previous };

      for (const [key, value] of entries) {
        if (!key || !value || nextState[key] === value) {
          continue;
        }

        nextState[key] = value;
        changed = true;
      }

      return changed ? nextState : previous;
    });
  }, []);
  const [outputSupported, setOutputSupported] = useState(
    audioSettingsStore.getState().outputSwitchSupported
  );
  const [forcedPerformanceMode, setForcedPerformanceMode] = useState(
    audioSettingsStore.getState().performanceMode
  );
  const [afkLeaveMinutes, setAfkLeaveMinutes] = useState(
    advancedSettingsStore.getState().afkLeaveMinutes
  );
  const [transitionLobbyNicknames, setTransitionLobbyNicknames] = useState<string[]>([]);
  const [thirdPartyMutedIds, setThirdPartyMutedIds] = useState<Set<string>>(
    () => new Set(DEMO_PRESET_THIRD_PARTY_MUTED_IDS)
  );
  const [participantVolumes, setParticipantVolumes] = useState<Record<string, number>>(
    () => readStoredParticipantVolumes()
  );
  const participantVolumeKeys = useMemo(() => {
    const keys: Record<string, string> = {};
    const addKey = (participantId: string, participantUserId?: string | null) => {
      const volumeKey = getStableParticipantVolumeKey(participantId, participantUserId);
      if (!volumeKey) {
        return;
      }

      if (!keys[participantId] || keys[participantId] === participantId || volumeKey !== participantId) {
        keys[participantId] = volumeKey;
      }
    };

    for (const participant of participants) {
      addKey(participant.participantId, participant.userId);
    }

    for (const participant of voicePresenceParticipants) {
      addKey(participant.participantId, participant.userId);
    }

    return keys;
  }, [participants, voicePresenceParticipants]);
  useEffect(() => {
    setParticipantVolumes((previous) => {
      let changed = false;
      const nextVolumes = { ...previous };

      for (const [participantId, volumeKey] of Object.entries(participantVolumeKeys)) {
        if (participantId === volumeKey || nextVolumes[volumeKey] !== undefined) {
          continue;
        }

        const participantVolume = nextVolumes[participantId];
        if (participantVolume === undefined) {
          continue;
        }

        nextVolumes[volumeKey] = participantVolume;
        changed = true;
      }

      if (changed) {
        persistParticipantVolumes(nextVolumes);
      }

      return changed ? nextVolumes : previous;
    });
  }, [participantVolumeKeys]);
  const latestAudioPreferencesRef = useRef({
    selectedOutputId,
    outputMuted,
    outputVolume,
    streamMuted,
    streamVolume,
    thirdPartyMutedIds,
    participantVolumes,
    participantVolumeKeys,
    outputSupported
  });
  const audioContainerRef = useRef<HTMLDivElement>(null);
  const remoteOutputRouterRef = useRef<RemoteOutputRouter | null>(null);
  const voiceHubRef = useRef<HTMLDivElement>(null);
  const voiceRingRef = useRef<HTMLDivElement>(null);
  const uiAudioContextRef = useRef<AudioContext | null>(null);
  const voiceEnergyRef = useRef(0);
  const lastVoiceEnergyPaintRef = useRef(0);
  const dockedStreamStageRef = useRef<HTMLDivElement>(null);
  const fullscreenStreamStageRef = useRef<HTMLDivElement>(null);
  const dockedScreenContainerRef = useRef<HTMLDivElement>(null);
  const fullscreenScreenContainerRef = useRef<HTMLDivElement>(null);
  const attachedRemoteScreenRef = useRef<{ track: VideoTrack; element: HTMLVideoElement } | null>(null);
  const remoteVideoRenderFpsRef = useRef<number | null>(null);
  const documentPipWindowRef = useRef<Window | null>(null);
  const documentPipVideoContainerRef = useRef<HTMLDivElement | null>(null);
  const krispProcessorRef = useRef<KrispNoiseFilterProcessor | null>(null);
  const krispGainProcessorRef = useRef<KrispMicrophoneGainProcessor | null>(null);
  const microphoneGainProcessorRef = useRef<MicrophoneGainProcessor | null>(null);
  const voiceGateProcessorRef = useRef<VoiceGateProcessor | null>(null);
  const krispVoiceGateProcessorRef = useRef<KrispVoiceGateProcessor | null>(null);
  const voiceGateExperimentRef = useRef<VoiceGateExperiment>(voiceGateExperiment);
  const audioDeviceSyncQueueRef = useRef<Promise<void>>(Promise.resolve());
  const audioDeviceSyncRequestRef = useRef(0);
  const desiredInputMutedRef = useRef(isMuted);
  const desiredOutputMutedRef = useRef(outputMuted);
  const desiredAfkRef = useRef(isAfk);
  const activeInputDeviceIdRef = useRef<string | null>(null);
  const activeOutputDeviceIdRef = useRef<string | null>(null);
  const desktopAudioProcessingTimeoutRef = useRef(0);
  const desktopAudioProcessingAttemptRef = useRef(0);
  const previousVoiceIdsRef = useRef<string[]>([]);
  const participantVoiceActivityRef = useRef<Map<string, ParticipantVoiceActivity>>(new Map());
  const disconnectTimeoutsRef = useRef<Map<string, number>>(new Map());
  const selectedStreamIdentityRef = useRef<string | null>(null);
  const streamTakeoverOverrideIdentityRef = useRef<string | null>(null);
  const nativePopoutStreamIdentityRef = useRef<string | null>(null);
  const suppressNextPopoutRestoreRef = useRef(false);
  const screenShareSourceRequestRef = useRef(0);
  const screenShareSessionRef = useRef<ScreenShareSession | null>(null);
  const screenShareUsageStartedAtRef = useRef<number | null>(null);
  const screenShareUsageReportedAtRef = useRef<number | null>(null);
  const screenShareUsageIntervalRef = useRef(0);
  const roomUsageStartedAtRef = useRef<number | null>(null);
  const roomUsageReportedAtRef = useRef<number | null>(null);
  const roomUsageIntervalRef = useRef(0);
  const screenShareUsageStreamSampleRef = useRef<StreamStatsSample | null>(null);
  const previousLocalStreamStatsRef = useRef<StreamStatsSample | null>(null);
  const previousRemoteStreamStatsRef = useRef<StreamStatsSample | null>(null);
  const previousMicrophoneAudioStatsRef = useRef<AudioStatsSample | null>(null);
  const previousScreenShareAudioStatsRef = useRef<AudioStatsSample | null>(null);
  const joinAttemptRef = useRef(0);
  const currentRoomIdRef = useRef<string | null>(roomId ?? null);
  const prefetchedVoiceTokenRef = useRef<PrefetchedVoiceToken | null>(null);
  const voiceTokenPrefetchRef = useRef<VoiceTokenPrefetchRequest | null>(null);
  const joinAbortControllerRef = useRef<AbortController | null>(null);
  const playbackResumeCleanupRef = useRef<(() => void) | null>(null);
  const krispPrewarmAbortRef = useRef<AbortController | null>(null);
  const pendingJoinMicrophoneTrackRef = useRef<LocalAudioTrack | null>(null);
  const microphoneJoinDegradedRef = useRef(false);
  const whiteNoiseResetInFlightRef = useRef(false);
  const whiteNoiseResetLastTriggeredAtRef = useRef(0);
  const noiseFloorWarningActiveRef = useRef(false);
  const krispFailedRef = useRef(krispFailed);
  const krispLifecycleRef = useRef<KrispLifecycleState>(krispLifecycle);
  const krispFallbackReasonRef = useRef<string | null>(krispFallbackReason);
  const krispActiveTrackIdRef = useRef<string | null>(null);
  const krispProcessingRequestRef = useRef(0);
  const manualNoiseFilterRestartInFlightRef = useRef(false);
  const manualNoiseFilterRestartRequestRef = useRef(0);
  const diagnosticFallbackActiveRef = useRef(diagnosticFallbackActive);
  const streamAfkStopInFlightRef = useRef(false);
  const autoStreamTierRef = useRef<"high" | "medium" | "low">("high");
  const activeRoomRef = useRef<Room | null>(null);
  const connectedRoomIdRef = useRef<string | null>(roomId ?? null);
  const fallbackLiveKitUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;
  const desktopBridge = getDesktopBridge();
  const isDesktopShell = Boolean(desktopBridge?.isDesktop);
  const screenShareSystemAudioSupported =
    !isDesktopShell || desktopBridge?.supportsSystemAudioCapture === true;
  const audioMode = resolveAudioMode({
    diagnosticFallback: diagnosticFallbackActive,
    audioProfile,
    noiseFilterEnabled,
    krispSupported,
    krispFailed
  });
  const effectiveKrispSupported = krispSupported && !krispFailed;
  const { isAppFocused } = useAppFocusState();
  const performanceMode = forcedPerformanceMode || !isAppFocused;
  const remoteOutputRouter =
    remoteOutputRouterRef.current ??= new RemoteOutputRouter(() => audioContainerRef.current);

  krispFailedRef.current = krispFailed;
  krispLifecycleRef.current = krispLifecycle;
  krispFallbackReasonRef.current = krispFallbackReason;
  diagnosticFallbackActiveRef.current = diagnosticFallbackActive;
  voiceGateExperimentRef.current = voiceGateExperiment;
  currentRoomIdRef.current = roomId ?? null;

  latestAudioPreferencesRef.current = {
    selectedOutputId,
    outputMuted,
    outputVolume,
    streamMuted,
    streamVolume,
    thirdPartyMutedIds,
    participantVolumes,
    participantVolumeKeys,
    outputSupported
  };

  useEffect(() => {
    installLiveKitClientDiagnostics();
    preconnectToUrl(resolveApiUrl("/api/livekit/token"), "api");
    void navigator.mediaDevices?.enumerateDevices?.().catch(() => undefined);
    void fetch(VOICE_GATE_WORKLET_URL, { cache: "force-cache" }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const targetRoomId = roomId ?? null;
    clearStalePrefetchedVoiceToken(targetRoomId);

    const activePrefetch = voiceTokenPrefetchRef.current;
    if (!targetRoomId || (activePrefetch && activePrefetch.roomId !== targetRoomId)) {
      activePrefetch?.abort();
      voiceTokenPrefetchRef.current = null;
    }
  }, [roomId]);

  useEffect(() => {
    return () => {
      voiceTokenPrefetchRef.current?.abort();
      voiceTokenPrefetchRef.current = null;
      joinAbortControllerRef.current?.abort();
      joinAbortControllerRef.current = null;
      playbackResumeCleanupRef.current?.();
      playbackResumeCleanupRef.current = null;
      prefetchedVoiceTokenRef.current = null;
      krispPrewarmAbortRef.current?.abort();
      krispPrewarmAbortRef.current = null;
      if (pendingJoinMicrophoneTrackRef.current) {
        stopUnpublishedLocalAudioTrack(pendingJoinMicrophoneTrackRef.current);
        pendingJoinMicrophoneTrackRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (
      !roomId ||
      status === "connecting" ||
      status === "preparing-audio" ||
      isVoiceConnectedStatus(status)
    ) {
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      if (!cancelled) {
        primeVoiceJoin("room-ready");
      }
    }, VOICE_TOKEN_PREFETCH_DELAY_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [roomId, status]);

  useEffect(() => {
    if (!noiseFilterEnabled || krispFailed) {
      krispPrewarmAbortRef.current?.abort();
      krispPrewarmAbortRef.current = null;
      setKrispPrewarmState(noiseFilterEnabled && krispFailed ? "degraded" : "idle");
      return;
    }

    let cancelled = false;
    const run = () => {
      if (!cancelled) {
        const controller = new AbortController();
        krispPrewarmAbortRef.current?.abort();
        krispPrewarmAbortRef.current = controller;
        setKrispPrewarmState("loading");
        void prewarmKrispNoiseFilter("app-startup", controller.signal)
          .then((supported) => {
            if (!cancelled && krispPrewarmAbortRef.current === controller) {
              setKrispPrewarmState(supported ? "ready" : "degraded");
            }
          })
          .catch(() => {
            if (!cancelled && !controller.signal.aborted) {
              setKrispPrewarmState("degraded");
            }
          })
          .finally(() => {
            if (krispPrewarmAbortRef.current === controller) {
              krispPrewarmAbortRef.current = null;
            }
          });
      }
    };
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const idleId = idleWindow.requestIdleCallback?.(run, { timeout: 1800 }) ?? null;
    const timeoutId = idleId === null ? window.setTimeout(run, 650) : null;

    return () => {
      cancelled = true;
      if (idleId !== null) {
        idleWindow.cancelIdleCallback?.(idleId);
      }
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      krispPrewarmAbortRef.current?.abort();
      krispPrewarmAbortRef.current = null;
    };
  }, [noiseFilterEnabled, krispFailed]);

  function updateKrispLifecycle(
    nextState: KrispLifecycleState,
    details: {
      reason?: string | null;
      processorEnabled?: boolean | null;
      attachedTrackId?: string | null;
      error?: string | null;
      record?: boolean;
    } = {}
  ) {
    krispLifecycleRef.current = nextState;
    setKrispLifecycle(nextState);

    if ("reason" in details) {
      const reason = details.reason ?? null;
      krispFallbackReasonRef.current = reason;
      setKrispFallbackReason(reason);
    }

    if ("processorEnabled" in details) {
      setKrispProcessorEnabled(details.processorEnabled ?? null);
    }

    if ("attachedTrackId" in details) {
      const attachedTrackId = details.attachedTrackId ?? null;
      krispActiveTrackIdRef.current = attachedTrackId;
      setKrispAttachedTrackId(attachedTrackId);
    }

    if (details.record !== false) {
      recordAudioDiagnosticEvent("krisp-lifecycle", {
        state: nextState,
        reason: details.reason ?? null,
        processorEnabled: details.processorEnabled ?? null,
        attachedTrackId: details.attachedTrackId ?? null,
        error: details.error ?? null
      });
    }
  }

  function isKrispNoiseFilterProcessor(
    processor: TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> | null
  ): processor is KrispNoiseFilterProcessor {
    return (
      Boolean(processor) &&
      typeof (processor as KrispNoiseFilterProcessor).setEnabled === "function" &&
      typeof (processor as KrispNoiseFilterProcessor).isEnabled === "function"
    );
  }

  function getKrispProcessorForTrack(localTrack: LocalAudioTrack | null) {
    const currentProcessor = localTrack?.getProcessor() ?? null;
    if (currentProcessor && currentProcessor === krispProcessorRef.current) {
      return krispProcessorRef.current;
    }
    if (isKrispNoiseFilterProcessor(currentProcessor)) {
      return currentProcessor;
    }
    if (
      currentProcessor &&
      krispVoiceGateProcessorRef.current &&
      currentProcessor === krispVoiceGateProcessorRef.current
    ) {
      return krispVoiceGateProcessorRef.current.krisp;
    }
    if (
      currentProcessor &&
      krispGainProcessorRef.current &&
      currentProcessor === krispGainProcessorRef.current
    ) {
      return krispGainProcessorRef.current.krisp;
    }

    return null;
  }

  function readKrispProcessorEnabled(processor: KrispNoiseFilterProcessor | null) {
    if (!processor || typeof processor.isEnabled !== "function") {
      return null;
    }

    try {
      return Boolean(processor.isEnabled());
    } catch {
      return null;
    }
  }

  function beginKrispProcessingRequest() {
    krispProcessingRequestRef.current += 1;
    return krispProcessingRequestRef.current;
  }

  function isKrispProcessingRequestCurrent(requestId: number) {
    return krispProcessingRequestRef.current === requestId;
  }

  function markKrispFailedForSession(
    message: string,
    reason: string,
    attachedTrackId: string | null = null
  ) {
    krispFailedRef.current = true;
    setKrispFailed(true);
    setLastProcessorFailure(message);
    updateKrispLifecycle("failed", {
      reason,
      processorEnabled: false,
      attachedTrackId,
      error: message
    });
  }

  function isPrefetchedVoiceTokenFresh(
    entry: PrefetchedVoiceToken | null,
    targetRoomId: string | null
  ) {
    return Boolean(
      entry &&
        targetRoomId &&
        entry.roomId === targetRoomId &&
        Date.now() - entry.createdAt <= VOICE_TOKEN_PREFETCH_MAX_AGE_MS
    );
  }

  function clearStalePrefetchedVoiceToken(targetRoomId: string | null) {
    const entry = prefetchedVoiceTokenRef.current;

    if (!entry) {
      return;
    }

    if (!targetRoomId || entry.roomId !== targetRoomId || !isPrefetchedVoiceTokenFresh(entry, targetRoomId)) {
      prefetchedVoiceTokenRef.current = null;
    }
  }

  async function fetchLiveKitVoiceToken(signal?: AbortSignal) {
    let response: Response;
    try {
      response = await apiFetch("/api/livekit/token", {
        method: "POST",
        signal
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      throw new Error("SovChat could not be reached while creating a LiveKit token.");
    }

    const payload = (await response.json().catch(() => null)) as LiveKitVoiceTokenPayload | null;

    if (!response.ok) {
      throw new Error(
        payload?.error ?? `SovChat returned ${response.status} while creating a LiveKit token.`
      );
    }
    if (!payload) {
      throw new Error("LiveKit token response was empty.");
    }

    return payload;
  }

  function primeVoiceJoin(reason: string) {
    const targetRoomId = currentRoomIdRef.current;

    if (
      !targetRoomId ||
      status === "connecting" ||
      status === "preparing-audio" ||
      isVoiceConnectedStatus(status)
    ) {
      return;
    }

    clearStalePrefetchedVoiceToken(targetRoomId);

    if (isPrefetchedVoiceTokenFresh(prefetchedVoiceTokenRef.current, targetRoomId)) {
      return;
    }

    const activePrefetch = voiceTokenPrefetchRef.current;
    if (activePrefetch?.roomId === targetRoomId) {
      return;
    }

    activePrefetch?.abort();

    const controller = new AbortController();
    const startedAt = Date.now();
    const request: VoiceTokenPrefetchRequest = {
      roomId: targetRoomId,
      startedAt,
      abort: () => controller.abort(),
      promise: fetchLiveKitVoiceToken(controller.signal)
        .then((payload) => {
          const serverUrl = resolveLiveKitServerUrl(payload.serverUrl, fallbackLiveKitUrl);
          const endpoint = getLiveKitEndpointDetails(serverUrl);
          preconnectToUrl(serverUrl, "livekit");

          if (currentRoomIdRef.current === targetRoomId) {
            prefetchedVoiceTokenRef.current = {
              roomId: targetRoomId,
              createdAt: Date.now(),
              payload
            };
            recordAudioDiagnosticEvent("voice-token-prefetch-complete", {
              reason,
              roomId: targetRoomId,
              durationMs: Date.now() - startedAt,
              endpoint
            });
          }

          return payload;
        })
        .catch((caughtError) => {
          if (!isAbortError(caughtError)) {
            recordAudioDiagnosticEvent("voice-token-prefetch-failed", {
              reason,
              roomId: targetRoomId,
              durationMs: Date.now() - startedAt,
              error: getAudioErrorMessage(caughtError)
            });
          }

          return null;
        })
        .finally(() => {
          if (voiceTokenPrefetchRef.current?.startedAt === startedAt) {
            voiceTokenPrefetchRef.current = null;
          }
        })
    };

    voiceTokenPrefetchRef.current = request;
    recordAudioDiagnosticEvent("voice-token-prefetch-start", {
      reason,
      roomId: targetRoomId
    });
  }

  async function getLiveKitVoiceTokenForJoin(
    attemptId: number,
    targetRoomId: string | null,
    signal?: AbortSignal,
    abort?: () => void
  ) {
    clearStalePrefetchedVoiceToken(targetRoomId);

    const cachedToken = prefetchedVoiceTokenRef.current;
    if (isPrefetchedVoiceTokenFresh(cachedToken, targetRoomId) && cachedToken) {
      prefetchedVoiceTokenRef.current = null;
      recordAudioDiagnosticEvent("voice-token-prefetch-used", {
        attemptId,
        roomId: targetRoomId,
        ageMs: Date.now() - cachedToken.createdAt
      });
      return cachedToken.payload;
    }

    const activePrefetch = voiceTokenPrefetchRef.current;
    if (activePrefetch && activePrefetch.roomId === targetRoomId) {
      const prefetchAgeMs = Date.now() - activePrefetch.startedAt;

      if (prefetchAgeMs < JOIN_TOKEN_TIMEOUT_MS) {
        try {
          const payload = await runTimedJoinOperation(
            activePrefetch.promise,
            "token",
            Math.max(1000, JOIN_TOKEN_TIMEOUT_MS - prefetchAgeMs),
            { attemptId, roomId: targetRoomId, source: "prefetch" },
            () => activePrefetch.abort()
          );

          if (!isActiveJoinAttempt(attemptId)) {
            throw new JoinCancelledError();
          }

          if (payload) {
            prefetchedVoiceTokenRef.current = null;
            recordAudioDiagnosticEvent("voice-token-prefetch-used", {
              attemptId,
              roomId: targetRoomId,
              ageMs: Date.now() - activePrefetch.startedAt,
              source: "in-flight"
            });
            return payload;
          }
        } catch (error) {
          if (signal?.aborted || !isActiveJoinAttempt(attemptId)) {
            throw new JoinCancelledError();
          }

          recordAudioDiagnosticEvent("voice-token-prefetch-fallback-direct", {
            attemptId,
            roomId: targetRoomId,
            ageMs: Date.now() - activePrefetch.startedAt,
            error: getAudioErrorMessage(error)
          });
        }
      }

      activePrefetch.abort();
      if (voiceTokenPrefetchRef.current === activePrefetch) {
        voiceTokenPrefetchRef.current = null;
      }
    }

    try {
      const payload = await runTimedJoinOperation(
        fetchLiveKitVoiceToken(signal),
        "token",
        JOIN_TOKEN_TIMEOUT_MS,
        { attemptId, roomId: targetRoomId, source: "direct" },
        abort
      );
      if (signal?.aborted || !isActiveJoinAttempt(attemptId)) {
        throw new JoinCancelledError();
      }
      return payload;
    } catch (error) {
      if (signal?.aborted || !isActiveJoinAttempt(attemptId) || isAbortError(error)) {
        throw new JoinCancelledError();
      }
      throw error;
    }
  }

  async function prewarmKrispNoiseFilter(reason: string, signal?: AbortSignal) {
    if (!noiseFilterEnabled || krispFailedRef.current) {
      return false;
    }

    const krispModule = await loadKrispNoiseFilterModule();
    if (signal?.aborted) {
      throw new DOMException("Krisp prewarm was cancelled.", "AbortError");
    }
    const supported = Boolean(krispModule?.isKrispNoiseFilterSupported?.());
    setKrispSupported(supported);
    recordAudioDiagnosticEvent("krisp-runtime-prewarm", {
      reason,
      supported
    });

    return supported ? await prewarmKrispModelAssets(reason, signal) : false;
  }

  async function setKrispEnabledWithTimeout(
    processor: KrispNoiseFilterProcessor,
    enabled: boolean,
    reason: string,
    timeoutMs = KRISP_PROCESSOR_ENABLE_TIMEOUT_MS
  ) {
    const operation = enabled
      ? withKrispModelProxy(() => processor.setEnabled(enabled))
      : processor.setEnabled(enabled);

    return await runTimedAudioOperation(
      operation,
      timeoutMs,
      enabled ? "krisp-enable-timeout" : "krisp-disable-timeout",
      { reason }
    );
  }

  async function stopProcessorWithTimeout(localTrack: LocalAudioTrack, reason: string) {
    return await runTimedAudioOperation(
      localTrack.stopProcessor(),
      KRISP_PROCESSOR_STOP_TIMEOUT_MS,
      "audio-processor-stop-timeout",
      { reason }
    );
  }

  const updateVoiceGateDiagnostics = useCallback((stats: VoiceGateStats) => {
    setVoiceGateDiagnostics({
      profile: stats.profile,
      enabled: true,
      processorActive: true,
      source: stats.source,
      gateOpen: stats.gateOpen,
      rms: stats.rms,
      noiseFloor: stats.noiseFloor,
      openThreshold: stats.openThreshold,
      closeThreshold: stats.closeThreshold,
      gain: stats.gain,
      closedGain: stats.closedGain,
      updatedAt: stats.updatedAt
    });
  }, []);

  useEffect(() => {
    const localTrack = getMicrophoneTrack(room?.localParticipant ?? null);
    const sourceMediaTrack = getTrackSourceMediaStreamTrack(localTrack);
    const mediaTrack = getTrackMediaStreamTrack(localTrack);
    const localTrackSettings = getMediaTrackSettings(sourceMediaTrack ?? mediaTrack);
    const currentProcessor = localTrack?.getProcessor() ?? null;
    const activeKrispProcessor = getKrispProcessorForTrack(localTrack);
    const currentKrispProcessorEnabled = readKrispProcessorEnabled(activeKrispProcessor);
    const krispProcessorExists = Boolean(
      krispProcessorRef.current ||
        krispVoiceGateProcessorRef.current ||
        krispGainProcessorRef.current
    );
    const krispAttachedToActiveTrack = Boolean(
        activeKrispProcessor &&
        currentProcessor &&
        sourceMediaTrack?.readyState === "live" &&
        (!krispActiveTrackIdRef.current || krispActiveTrackIdRef.current === sourceMediaTrack.id)
    );
    const krispActuallyEnabled = Boolean(
      krispAttachedToActiveTrack && (currentKrispProcessorEnabled ?? krispProcessorEnabled ?? false)
    );
    const requestedCaptureConstraints = getAudioCaptureOptions(
      selectedInputId,
      noiseFilterEnabled,
      effectiveKrispSupported,
      audioProfile
    );
    const requestedVoiceIsolation = (
      requestedCaptureConstraints as MediaTrackConstraints & { voiceIsolation?: ConstrainBoolean }
    ).voiceIsolation;
    const krispExpected = noiseFilterEnabled;
    const noiseFilterState: NoiseFilterRuntimeState = {
      supported: krispSupported,
      expected: krispExpected,
      enabled: krispActuallyEnabled,
      failed: krispFailed,
      fallbackActive:
        noiseFilterEnabled &&
        (!krispActuallyEnabled || krispLifecycle === "fallback-standard"),
      lastError: lastProcessorFailure,
      lifecycle: krispLifecycle,
      processorExists: krispProcessorExists,
      attachedToActiveTrack: krispAttachedToActiveTrack,
      processorEnabled: currentKrispProcessorEnabled ?? krispProcessorEnabled,
      localTrackId: mediaTrack?.id ?? null,
      localTrackReadyState: mediaTrack?.readyState ?? null,
      fallbackReason: krispFallbackReason
    };
    const actualSettings = localTrackSettings as
      | (MediaTrackSettings & {
          echoCancellation?: boolean;
          noiseSuppression?: boolean;
          autoGainControl?: boolean;
          voiceIsolation?: boolean;
        })
      | null;

    publishAudioDiagnosticsSnapshot({
      connectionStatus: status,
      mode: audioMode,
      profile: audioProfile,
      selectedInputId,
      selectedOutputId,
      captureConstraints: requestedCaptureConstraints,
      requestedCaptureConstraints,
      requestedEchoCancellation: requestedCaptureConstraints.echoCancellation ?? null,
      requestedNoiseSuppression: requestedCaptureConstraints.noiseSuppression ?? null,
      requestedAutoGainControl: requestedCaptureConstraints.autoGainControl ?? null,
      requestedVoiceIsolation: requestedVoiceIsolation ?? null,
      localTrackSettings,
      currentLocalTrackId: mediaTrack?.id ?? null,
      currentLocalTrackReadyState: mediaTrack?.readyState ?? null,
      actualEchoCancellation: actualSettings?.echoCancellation ?? null,
      actualNoiseSuppression: actualSettings?.noiseSuppression ?? null,
      actualAutoGainControl: actualSettings?.autoGainControl ?? null,
      actualVoiceIsolation: actualSettings?.voiceIsolation ?? null,
      enhancedNoiseSuppressionEnabled: noiseFilterEnabled,
      krispSupported,
      krispPrewarmState,
      krispLifecycle,
      krispProcessorAttached: krispAttachedToActiveTrack,
      processorAttached: Boolean(currentProcessor),
      publishDtx: microphonePublishOptions.dtx ?? null,
      noiseFilter: noiseFilterState,
      voicePublishProfile: microphonePublishPlan.diagnostics.publishProfile,
      voiceGate: voiceGateDiagnostics,
      noiseFloor: noiseFloorDiagnostics,
      customProcessorActive: Boolean(localTrack?.getProcessor()),
      localMicTrackCount: localTrack ? 1 : 0,
      remoteAudioElementCount: remoteOutputRouter.elementCount,
      inputMuted: isMuted,
      outputMuted,
      outputVolume,
      streamMuted,
      streamVolume,
      lastAudioError,
      lastDeviceSwitchResult,
      lastProcessorFailure,
      updatedAt: new Date().toISOString()
    });
  }, [
    audioMode,
    audioProfile,
    effectiveKrispSupported,
    inputGain,
    isMuted,
    krispAttachedTrackId,
    krispFailed,
    krispFallbackReason,
    krispLifecycle,
    krispProcessorEnabled,
    krispPrewarmState,
    krispSupported,
    lastAudioError,
    lastDeviceSwitchResult,
    lastProcessorFailure,
    noiseFilterEnabled,
    noiseFloorDiagnostics,
    outputMuted,
    outputVolume,
    remoteOutputRouter,
    room,
    selectedInputId,
    selectedOutputId,
    streamMuted,
    streamVolume,
    status,
    voiceGateDiagnostics
  ]);

  function logMuteDebug(event: string, details: Record<string, unknown> = {}) {
    if (typeof window === "undefined") {
      return;
    }

    const entry: MuteDebugEntry = {
      timestamp: new Date().toISOString(),
      event,
      details: {
        roomStatus: status,
        reactMuted: isMuted,
        desiredMuted: desiredInputMutedRef.current,
        storeMuted: audioSettingsStore.getState().inputMuted,
        selectedInputId: audioSettingsStore.getState().selectedInputId,
        activeInputDeviceId: activeInputDeviceIdRef.current,
        microphone: getMicrophoneDebugSnapshot(room?.localParticipant ?? null),
        ...details
      }
    };

    recordAudioDiagnosticEvent(event, entry.details ?? {});

    if (shouldLogVerboseDiagnostics()) {
      console.info("[voice:mute]", entry.event, entry);
      void desktopBridge?.logMuteDebug?.(entry).catch(() => undefined);
    }
  }

  function recordLocalAudioStats(snapshot: LocalAudioStatsSnapshot) {
    if (shouldLogVerboseDiagnostics()) {
      console.info("[voice:audio]", snapshot.source, snapshot);
    }
  }

  async function sampleLocalAudioPublication(
    publication: LocalTrackPublication | null | undefined,
    options: TrackPublishOptions,
    previousRef: MutableRefObject<AudioStatsSample | null>
  ) {
    const audioTrack = publication?.audioTrack;
    const sender = audioTrack?.sender;
    if (!sender?.getStats) {
      return;
    }

    const report = await sender.getStats().catch(() => null);
    if (!report) {
      return;
    }

    const source = options.source ?? publication?.source ?? Track.Source.Microphone;
    const audioStats = buildLocalAudioStats(report, source, options, previousRef.current);
    if (!audioStats) {
      return;
    }

    previousRef.current = audioStats.sample;
    recordLocalAudioStats(audioStats.snapshot);
  }

  function scheduleLocalAudioStatsSample(
    publication: LocalTrackPublication | null | undefined,
    options: TrackPublishOptions,
    previousRef: MutableRefObject<AudioStatsSample | null>
  ) {
    void sampleLocalAudioPublication(publication, options, previousRef);
    window.setTimeout(() => {
      void sampleLocalAudioPublication(publication, options, previousRef);
    }, STREAM_STATS_INTERVAL_MS);
  }

  function paintVoiceEnergy(value: number, force = false) {
    const clampedValue = Math.max(0, Math.min(1, value));
    const ringElement = voiceRingRef.current;
    const hubElement = voiceHubRef.current;

    voiceEnergyRef.current = clampedValue;

    if (!force && Math.abs(clampedValue - lastVoiceEnergyPaintRef.current) < 0.004) {
      return;
    }

    const formattedValue = clampedValue.toFixed(3);
    ringElement?.style.setProperty("--voice-energy", formattedValue);
    hubElement?.style.setProperty("--voice-energy", formattedValue);
    lastVoiceEnergyPaintRef.current = clampedValue;
  }

  function syncLocalSelfContext(nextSelfMuted: boolean, nextSelfDeafened: boolean) {
    desiredInputMutedRef.current = nextSelfMuted;
    desiredOutputMutedRef.current = nextSelfDeafened;

    setParticipants((previous) =>
      previous.map((participant) =>
        participant.isLocal || participant.participantId === nickname
          ? {
              ...participant,
              isSelfMuted: nextSelfMuted,
              isSelfDeafened: nextSelfDeafened
            }
          : participant
      )
    );

    setVoicePresenceParticipants((previous) =>
      previous.map((participant) =>
        participant.participantId === nickname || participant.displayName === nickname
          ? {
              ...participant,
              isSelfMuted: nextSelfMuted,
              isSelfDeafened: nextSelfDeafened
            }
          : participant
      )
    );
  }

  useEffect(() => {
    desiredAfkRef.current = isAfk;

    setParticipants((previous) =>
      previous.map((participant) =>
        participant.isLocal || participant.participantId === nickname
          ? {
              ...participant,
              isAfk
            }
          : participant
      )
    );

    setVoicePresenceParticipants((previous) =>
      previous.map((participant) =>
        participant.participantId === nickname || participant.displayName === nickname
          ? {
              ...participant,
              isAfk
            }
          : participant
      )
    );
  }, [isAfk, nickname]);

  const mergedParticipants = useMemo(() => {
    const merged = new Map<string, ParticipantView>();

    for (const participant of voicePresenceParticipants) {
      merged.set(participant.participantId, {
        participantId: participant.participantId,
        userId: participant.userId,
        identity: participant.displayName,
        displayName: participant.displayName,
        avatarSrc: participant.avatarSrc ?? undefined,
        isSpeaking: false,
        voiceLevel: 0,
        isLocal: false,
        isStreaming: participant.isStreaming,
        isSelfMuted: participant.isSelfMuted,
        isSelfDeafened: participant.isSelfDeafened,
        isAfk: participant.isAfk
      });
    }

    for (const participant of participants) {
      const existingParticipant = merged.get(participant.participantId);
      merged.set(participant.participantId, {
        ...participant,
        userId: existingParticipant?.userId ?? participant.userId ?? null,
        isAfk: participant.isAfk ?? existingParticipant?.isAfk
      });
    }

    return Array.from(merged.values()).sort((left, right) => {
      if (left.isLocal !== right.isLocal) {
        return left.isLocal ? -1 : 1;
      }

      const nameComparison = left.displayName.localeCompare(right.displayName, undefined, {
        sensitivity: "base"
      });

      if (nameComparison !== 0) {
        return nameComparison;
      }

      return left.participantId.localeCompare(right.participantId);
    });
  }, [participants, voicePresenceParticipants]);
  const selectedStreamIsLocal = Boolean(
    room && selectedStreamIdentity === room.localParticipant.identity
  );
  const selectedRemoteScreenTrack = useMemo(() => {
    if (!room || !selectedStreamIdentity) {
      return null;
    }

    if (selectedStreamIdentity === room.localParticipant.identity) {
      return getScreenTrack(room.localParticipant) ?? (
        screenTrackIdentity === selectedStreamIdentity ? screenTrack : null
      );
    }

    const selectedParticipant = room.remoteParticipants.get(selectedStreamIdentity);
    return selectedParticipant ? getScreenTrack(selectedParticipant) : null;
  }, [room, screenTrack, screenTrackIdentity, selectedStreamIdentity, participants]);

  async function playUiCue(
    kind:
      | "join"
      | "leave"
      | "stream-start"
      | "stream-stop"
      | "self-mute"
      | "self-unmute"
      | "self-deafen"
      | "self-undeafen"
  ) {
    if (typeof AudioContext === "undefined") {
      return;
    }

    uiAudioContextRef.current ??= new AudioContext();
    const audioContext = uiAudioContextRef.current;
    if (audioContext.state === "suspended") {
      await audioContext.resume().catch(() => undefined);
    }
    const startedAt = audioContext.currentTime + 0.01;

    const cueProfiles: Record<
      typeof kind,
      Array<{
        offset: number;
        duration: number;
        startHz: number;
        endHz: number;
        gain: number;
        type?: OscillatorType;
      }>
    > = {
      join: [
        { offset: 0, duration: 0.16, startHz: 420, endHz: 620, gain: 0.25, type: "triangle" },
        { offset: 0.1, duration: 0.2, startHz: 620, endHz: 940, gain: 0.27, type: "sine" },
        { offset: 0.24, duration: 0.1, startHz: 1180, endHz: 1480, gain: 0.17, type: "triangle" }
      ],
      leave: [
        { offset: 0, duration: 0.14, startHz: 760, endHz: 520, gain: 0.23, type: "triangle" },
        { offset: 0.1, duration: 0.2, startHz: 480, endHz: 300, gain: 0.25, type: "sine" },
        { offset: 0.28, duration: 0.08, startHz: 260, endHz: 180, gain: 0.15, type: "triangle" }
      ],
      "stream-start": [
        { offset: 0, duration: 0.13, startHz: 320, endHz: 560, gain: 0.2, type: "triangle" },
        { offset: 0.08, duration: 0.19, startHz: 680, endHz: 1120, gain: 0.23, type: "sine" },
        { offset: 0.2, duration: 0.16, startHz: 1260, endHz: 1760, gain: 0.18, type: "triangle" },
        { offset: 0.34, duration: 0.08, startHz: 2100, endHz: 2400, gain: 0.1, type: "sine" }
      ],
      "stream-stop": [
        { offset: 0, duration: 0.13, startHz: 1500, endHz: 980, gain: 0.16, type: "triangle" },
        { offset: 0.09, duration: 0.19, startHz: 760, endHz: 420, gain: 0.18, type: "sine" },
        { offset: 0.26, duration: 0.1, startHz: 340, endHz: 220, gain: 0.12, type: "triangle" }
      ],
      "self-mute": [
        { offset: 0, duration: 0.08, startHz: 620, endHz: 360, gain: 0.11, type: "square" },
        { offset: 0.09, duration: 0.07, startHz: 320, endHz: 240, gain: 0.09, type: "triangle" }
      ],
      "self-unmute": [
        { offset: 0, duration: 0.08, startHz: 360, endHz: 620, gain: 0.105, type: "triangle" },
        { offset: 0.08, duration: 0.09, startHz: 760, endHz: 960, gain: 0.09, type: "sine" }
      ],
      "self-deafen": [
        { offset: 0, duration: 0.1, startHz: 700, endHz: 440, gain: 0.12, type: "sawtooth" },
        { offset: 0.11, duration: 0.12, startHz: 440, endHz: 180, gain: 0.1, type: "triangle" }
      ],
      "self-undeafen": [
        { offset: 0, duration: 0.09, startHz: 220, endHz: 440, gain: 0.105, type: "triangle" },
        { offset: 0.08, duration: 0.14, startHz: 520, endHz: 880, gain: 0.105, type: "sine" },
        { offset: 0.2, duration: 0.07, startHz: 1100, endHz: 1320, gain: 0.07, type: "triangle" }
      ]
    };

    for (const tone of cueProfiles[kind]) {
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      const toneStart = startedAt + tone.offset;
      const toneEnd = toneStart + tone.duration;

      oscillator.type = tone.type ?? "sine";
      oscillator.frequency.setValueAtTime(tone.startHz, toneStart);
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(40, tone.endHz), toneEnd);

      gainNode.gain.setValueAtTime(0.0001, toneStart);
      gainNode.gain.exponentialRampToValueAtTime(tone.gain, toneStart + 0.018);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, toneEnd);

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      oscillator.start(toneStart);
      oscillator.stop(toneEnd + 0.02);

      oscillator.addEventListener("ended", () => {
        oscillator.disconnect();
        gainNode.disconnect();
      });
    }

    void audioContext.resume().catch(() => undefined);
  }

  function isActiveRoomInstance(candidate: Room | null) {
    return activeRoomRef.current === candidate;
  }

  function isActiveJoinAttempt(attemptId: number) {
    return joinAttemptRef.current === attemptId;
  }

  function detachAllRemoteAudio() {
    remoteOutputRouter.clear();
    audioContainerRef.current?.replaceChildren();
  }

  function resetRoomState(nextStatus: "idle" | "error" = "idle") {
    joinAttemptRef.current += 1;
    audioDeviceSyncRequestRef.current += 1;
    beginKrispProcessingRequest();
    voiceTokenPrefetchRef.current?.abort();
    voiceTokenPrefetchRef.current = null;
    joinAbortControllerRef.current?.abort();
    joinAbortControllerRef.current = null;
    playbackResumeCleanupRef.current?.();
    playbackResumeCleanupRef.current = null;
    krispPrewarmAbortRef.current?.abort();
    krispPrewarmAbortRef.current = null;
    if (pendingJoinMicrophoneTrackRef.current) {
      stopUnpublishedLocalAudioTrack(pendingJoinMicrophoneTrackRef.current);
      pendingJoinMicrophoneTrackRef.current = null;
    }
    microphoneJoinDegradedRef.current = false;
    detachAllRemoteAudio();
    screenShareSessionRef.current?.cleanup();
    screenShareSessionRef.current = null;
    if (screenShareUsageIntervalRef.current) {
      window.clearInterval(screenShareUsageIntervalRef.current);
      screenShareUsageIntervalRef.current = 0;
    }
    screenShareUsageStartedAtRef.current = null;
    screenShareUsageReportedAtRef.current = null;
    screenShareUsageStreamSampleRef.current = null;
    if (roomUsageIntervalRef.current) {
      window.clearInterval(roomUsageIntervalRef.current);
      roomUsageIntervalRef.current = 0;
    }
    roomUsageStartedAtRef.current = null;
    roomUsageReportedAtRef.current = null;
    participantVoiceActivityRef.current.clear();
    setRoom(null);
    setParticipants([]);
    setVoicePresenceParticipants((previous) =>
      previous.filter(
        (participant) =>
          participant.participantId !== nickname && participant.displayName !== nickname
      )
    );
    setScreenTrack(null);
    setScreenTrackIdentity(null);
    setSelectedStreamIdentity(null);
    setIsSharing(false);
    clearDesktopScreenShareSelection();
    setIsScreenSharePickerOpen(false);
    setScreenShareSources([]);
    setScreenShareSourcesLoading(false);
    setScreenShareIncludeSystemAudio(false);
    setStreamStats(null);
    krispProcessorRef.current = null;
    krispGainProcessorRef.current = null;
    krispVoiceGateProcessorRef.current = null;
    microphoneGainProcessorRef.current = null;
    voiceGateProcessorRef.current = null;
    krispActiveTrackIdRef.current = null;
    setKrispAttachedTrackId(null);
    setKrispProcessorEnabled(null);
    updateKrispLifecycle("disabled", {
      reason: "room-reset",
      processorEnabled: false,
      attachedTrackId: null,
      record: false
    });
    activeInputDeviceIdRef.current = null;
    activeOutputDeviceIdRef.current = null;
    if (desktopAudioProcessingTimeoutRef.current) {
      window.clearTimeout(desktopAudioProcessingTimeoutRef.current);
      desktopAudioProcessingTimeoutRef.current = 0;
    }
    desktopAudioProcessingAttemptRef.current = 0;
    previousLocalStreamStatsRef.current = null;
    previousRemoteStreamStatsRef.current = null;
    previousMicrophoneAudioStatsRef.current = null;
    previousScreenShareAudioStatsRef.current = null;
    whiteNoiseResetInFlightRef.current = false;
    whiteNoiseResetLastTriggeredAtRef.current = 0;
    autoStreamTierRef.current = "high";
    paintVoiceEnergy(0, true);
    setThirdPartyMutedIds(new Set(DEMO_PRESET_THIRD_PARTY_MUTED_IDS));
    setParticipantVolumes(readStoredParticipantVolumes());
    syncLocalSelfContext(isMuted, outputMuted);
    activeRoomRef.current = null;
    connectedRoomIdRef.current = null;
    setStatus(nextStatus);
  }

  function applyRemoteAudioPreferences(
    nextOutputId: string,
    nextOutputMuted: boolean,
    nextVoiceVolume: number,
    nextStreamMuted: boolean,
    nextStreamVolume: number,
    nextThirdPartyMutedIds: Set<string>,
    nextParticipantVolumes = latestAudioPreferencesRef.current.participantVolumes,
    nextParticipantVolumeKeys = latestAudioPreferencesRef.current.participantVolumeKeys,
    nextOutputSupported = latestAudioPreferencesRef.current.outputSupported
  ) {
    remoteOutputRouter.apply({
      selectedOutputId: nextOutputId,
      outputMuted: nextOutputMuted,
      outputVolume: nextVoiceVolume,
      streamMuted: nextStreamMuted,
      streamVolume: nextStreamVolume,
      thirdPartyMutedIds: nextThirdPartyMutedIds,
      participantVolumes: nextParticipantVolumes,
      participantVolumeKeys: nextParticipantVolumeKeys,
      outputSupported: nextOutputSupported
    });
  }

  async function syncOutputOnlyPreferences(
    nextOutputId: string,
    nextOutputMuted: boolean,
    nextVoiceVolume: number,
    nextStreamMuted = streamMuted,
    nextStreamVolume = streamVolume,
    nextThirdPartyMutedIds = thirdPartyMutedIds,
    reason = "output"
  ) {
    const normalizedOutputId = getConcreteDeviceId(nextOutputId) || null;

    audioSettingsStore.patch({
      selectedOutputId: nextOutputId,
      outputMuted: nextOutputMuted,
      outputVolume: nextVoiceVolume,
      streamMuted: nextStreamMuted,
      streamVolume: nextStreamVolume,
      outputSwitchSupported:
        typeof HTMLMediaElement !== "undefined" &&
        "setSinkId" in HTMLMediaElement.prototype
    });

    if (room && outputSupported && activeOutputDeviceIdRef.current !== normalizedOutputId) {
      if (normalizedOutputId) {
        await room.switchActiveDevice("audiooutput", normalizedOutputId)
          .then(() => setLastDeviceSwitchResult("output:ok"))
          .catch((caughtError) => {
            const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
            setLastDeviceSwitchResult(`output:failed:${message}`);
            recordAudioDiagnosticEvent("output-device-switch-failed", {
              reason,
              error: message
            });
          });
      }
      activeOutputDeviceIdRef.current = normalizedOutputId;
    }

    applyRemoteAudioPreferences(
      nextOutputId,
      nextOutputMuted,
      nextVoiceVolume,
      nextStreamMuted,
      nextStreamVolume,
      nextThirdPartyMutedIds
    );
  }

  function resetVoiceGateDiagnostics(nextProfile = voiceGateExperimentRef.current) {
    setVoiceGateDiagnostics({
      ...EMPTY_VOICE_GATE_DIAGNOSTICS,
      profile: nextProfile
    });
  }

  async function applyEnhancedKrispCaptureConstraints(
    localTrack: LocalAudioTrack | null,
    reason: string
  ) {
    const mediaTrack = getTrackSourceMediaStreamTrack(localTrack);
    if (!mediaTrack || mediaTrack.readyState !== "live") {
      recordAudioDiagnosticEvent("krisp-enhanced-capture-skipped", {
        reason,
        readyState: mediaTrack?.readyState ?? null
      });
      return false;
    }

    const enhancedConstraints = buildMicrophoneCaptureOptions({
      selectedInputId: "",
      mode: "enhanced",
      profile: audioProfile,
      noiseFilterEnabled: true,
      krispActive: true
    });
    const voiceIsolation = (
      enhancedConstraints as MediaTrackConstraints & { voiceIsolation?: boolean }
    ).voiceIsolation;

    return await mediaTrack
      .applyConstraints(enhancedConstraints)
      .then(() => {
        const settings = getMediaTrackSettings(mediaTrack) as
          | (MediaTrackSettings & {
              echoCancellation?: boolean;
              noiseSuppression?: boolean;
              autoGainControl?: boolean;
              voiceIsolation?: boolean;
            })
          | null;
        recordAudioDiagnosticEvent("krisp-enhanced-capture-applied", {
          reason,
          trackId: mediaTrack.id,
          echoCancellation: enhancedConstraints.echoCancellation ?? null,
          noiseSuppression: enhancedConstraints.noiseSuppression ?? null,
          autoGainControl: enhancedConstraints.autoGainControl ?? null,
          voiceIsolation: voiceIsolation ?? null,
          actualEchoCancellation: settings?.echoCancellation ?? null,
          actualNoiseSuppression: settings?.noiseSuppression ?? null,
          actualAutoGainControl: settings?.autoGainControl ?? null,
          actualVoiceIsolation: settings?.voiceIsolation ?? null
        });
        return true;
      })
      .catch((error) => {
        recordAudioDiagnosticEvent("krisp-enhanced-capture-failed", {
          reason,
          trackId: mediaTrack.id,
          error: error instanceof Error ? error.message : String(error)
        });
        return false;
      });
  }

  async function applyNativeVoiceCleanupConstraints(
    localTrack: LocalAudioTrack | null,
    reason: string
  ) {
    const mediaTrack = getTrackSourceMediaStreamTrack(localTrack);
    if (!mediaTrack || mediaTrack.readyState !== "live") {
      updateKrispLifecycle("fallback-standard", {
        reason,
        processorEnabled: false,
        attachedTrackId: null
      });
      return;
    }

    const fallbackConstraints = buildMicrophoneCaptureOptions({
      selectedInputId: "",
      mode: "safe",
      profile: "standard",
      noiseFilterEnabled: false,
      krispActive: false
    });
    const voiceIsolation = (
      fallbackConstraints as MediaTrackConstraints & { voiceIsolation?: boolean }
    ).voiceIsolation;

    await mediaTrack
      .applyConstraints(fallbackConstraints)
      .then(() => {
        const settings = getMediaTrackSettings(mediaTrack) as
          | (MediaTrackSettings & {
              echoCancellation?: boolean;
              noiseSuppression?: boolean;
              autoGainControl?: boolean;
              voiceIsolation?: boolean;
            })
          | null;
        updateKrispLifecycle("fallback-standard", {
          reason,
          processorEnabled: false,
          attachedTrackId: null
        });
        recordAudioDiagnosticEvent("native-voice-cleanup-restored", {
          reason,
          trackId: mediaTrack.id,
          echoCancellation: fallbackConstraints.echoCancellation ?? null,
          noiseSuppression: fallbackConstraints.noiseSuppression ?? null,
          autoGainControl: fallbackConstraints.autoGainControl ?? null,
          voiceIsolation: voiceIsolation ?? null,
          actualEchoCancellation: settings?.echoCancellation ?? null,
          actualNoiseSuppression: settings?.noiseSuppression ?? null,
          actualAutoGainControl: settings?.autoGainControl ?? null,
          actualVoiceIsolation: settings?.voiceIsolation ?? null
        });
      })
      .catch((error) => {
        recordAudioDiagnosticEvent("native-voice-cleanup-restore-failed", {
          reason,
          error: error instanceof Error ? error.message : String(error)
        });
      });
  }

  async function syncKrispNoiseFilter(
    localTrack: LocalAudioTrack | null,
    enabled: boolean,
    supported: boolean,
    requestId = krispProcessingRequestRef.current,
    publishRoomContext?: Room | null
  ) {
    const requestIsCurrent = () => isKrispProcessingRequestCurrent(requestId);

    if (!localTrack) {
      updateKrispLifecycle(enabled ? "loading" : "disabled", {
        reason: "missing-local-audio-track",
        processorEnabled: null,
        attachedTrackId: null
      });
      return;
    }

    if (!requestIsCurrent()) {
      return;
    }

    let currentProcessor = localTrack.getProcessor();
    const sourceMediaTrack = getTrackSourceMediaStreamTrack(localTrack);
    const mediaTrack = getTrackMediaStreamTrack(localTrack);
    const attachedTrackId = sourceMediaTrack?.id ?? mediaTrack?.id ?? null;

    if (
      currentProcessor === voiceGateProcessorRef.current ||
      currentProcessor === krispVoiceGateProcessorRef.current
    ) {
      await stopProcessorWithTimeout(localTrack, "remove-legacy-voice-gate-before-krisp");
      voiceGateProcessorRef.current = null;
      krispVoiceGateProcessorRef.current = null;
      currentProcessor = localTrack.getProcessor();
      resetVoiceGateDiagnostics("off");
    }

    if (!requestIsCurrent()) {
      return;
    }

    if (!enabled || !supported) {
      const activeKrispProcessor = getKrispProcessorForTrack(localTrack);
      if (activeKrispProcessor) {
        await setKrispEnabledWithTimeout(
          activeKrispProcessor,
          false,
          enabled ? "krisp-unsupported" : "krisp-disabled",
          KRISP_PROCESSOR_STOP_TIMEOUT_MS
        );
      }
      if (currentProcessor && currentProcessor !== microphoneGainProcessorRef.current) {
        await stopProcessorWithTimeout(
          localTrack,
          enabled ? "krisp-unsupported" : "krisp-disabled"
        );
      }
      krispProcessorRef.current = null;
      krispGainProcessorRef.current = null;
      krispVoiceGateProcessorRef.current = null;
      updateKrispLifecycle(enabled ? "fallback-standard" : "disabled", {
        reason: enabled ? "krisp-unsupported" : "krisp-disabled",
        processorEnabled: false,
        attachedTrackId: null
      });
      if (enabled && !supported) {
        await applyNativeVoiceCleanupConstraints(localTrack, "krisp-unsupported");
      }
      return;
    }

    if (!sourceMediaTrack || sourceMediaTrack.readyState !== "live") {
      updateKrispLifecycle("loading", {
        reason: "local-audio-track-not-live",
        processorEnabled: null,
        attachedTrackId
      });
      return;
    }

    const attachedKrispProcessor = getKrispProcessorForTrack(localTrack);
    if (
      attachedKrispProcessor &&
      localTrack.getProcessor() === attachedKrispProcessor
    ) {
      krispProcessorRef.current = attachedKrispProcessor;
      krispGainProcessorRef.current = null;
      krispVoiceGateProcessorRef.current = null;
      setKrispSupported(true);

      const processorAlreadyEnabled = readKrispProcessorEnabled(attachedKrispProcessor);
      let existingProcessorRecovered = true;
      if (processorAlreadyEnabled === false) {
        const enableExistingResult = await setKrispEnabledWithTimeout(
          attachedKrispProcessor,
          true,
          "krisp-enable-existing"
        );

        if (!requestIsCurrent()) {
          return;
        }

        if (enableExistingResult.status !== "ok" || enableExistingResult.value === false) {
          existingProcessorRecovered = false;
          recordAudioDiagnosticEvent("krisp-existing-enable-deferred", {
            status: enableExistingResult.status,
            trackId: attachedTrackId,
            error:
              enableExistingResult.status === "error"
                ? enableExistingResult.error instanceof Error
                  ? enableExistingResult.error.message
                  : String(enableExistingResult.error)
                : null
          });
          await stopProcessorWithTimeout(localTrack, "krisp-existing-enable-retry-fresh-attach");
          krispProcessorRef.current = null;
          krispGainProcessorRef.current = null;
          krispVoiceGateProcessorRef.current = null;
        }
      }

      if (!existingProcessorRecovered) {
        currentProcessor = localTrack.getProcessor();
        updateKrispLifecycle("loading", {
          reason: "krisp-existing-enable-retry-fresh-attach",
          processorEnabled: null,
          attachedTrackId
        });
      } else {
        const processorEnabled = readKrispProcessorEnabled(attachedKrispProcessor) ?? true;
        const processedTrack = (attachedKrispProcessor as { processedTrack?: MediaStreamTrack })
          .processedTrack;
        const processedTrackLive = !processedTrack || processedTrack.readyState === "live";
        if (processorEnabled === false || !processedTrackLive) {
          recordAudioDiagnosticEvent("krisp-existing-active-verification-failed", {
            trackId: attachedTrackId,
            processorEnabled,
            processedTrackState: processedTrack?.readyState ?? null
          });
          await stopProcessorWithTimeout(localTrack, "krisp-existing-active-verification-failed");
          krispProcessorRef.current = null;
          krispGainProcessorRef.current = null;
          krispVoiceGateProcessorRef.current = null;
          currentProcessor = localTrack.getProcessor();
          updateKrispLifecycle("loading", {
            reason: "krisp-existing-active-verification-retry-fresh-attach",
            processorEnabled: null,
            attachedTrackId
          });
        } else {
          krispActiveTrackIdRef.current = attachedTrackId;
          setKrispAttachedTrackId(attachedTrackId);
          setKrispProcessorEnabled(processorEnabled);
          setLastProcessorFailure(null);
          updateKrispLifecycle("active", {
            reason: "krisp-existing-processor-active",
            processorEnabled,
            attachedTrackId
          });
          recordAudioDiagnosticEvent("krisp-existing-processor-active", {
            trackId: attachedTrackId,
            processorEnabled
          });
          return;
        }
      }
    }

    updateKrispLifecycle("loading", {
      reason: "krisp-attach-start",
      processorEnabled: null,
      attachedTrackId
    });

    const enhancedCaptureApplied = await applyEnhancedKrispCaptureConstraints(
      localTrack,
      "before-krisp-attach"
    );
    if (!requestIsCurrent()) {
      return;
    }
    if (!enhancedCaptureApplied) {
      await stopProcessorWithTimeout(localTrack, "krisp-enhanced-capture-failed");
      krispProcessorRef.current = null;
      krispGainProcessorRef.current = null;
      krispVoiceGateProcessorRef.current = null;
      markKrispFailedForSession(
        "Krisp enhanced capture constraints could not be applied.",
        "enhanced-capture-constraints-failed",
        null
      );
      await applyNativeVoiceCleanupConstraints(localTrack, "krisp-enhanced-capture-failed");
      return;
    }

    const krispModule = await loadKrispNoiseFilterModule();
    if (!requestIsCurrent()) {
      return;
    }
    if (!krispModule) {
      if (currentProcessor) {
        await stopProcessorWithTimeout(localTrack, "krisp-module-unavailable");
      }
      krispProcessorRef.current = null;
      krispGainProcessorRef.current = null;
      krispVoiceGateProcessorRef.current = null;
      setKrispSupported(false);
      recordAudioDiagnosticEvent("krisp-module-unavailable");
      markKrispFailedForSession("Krisp module could not be loaded.", "krisp-module-unavailable");
      await applyNativeVoiceCleanupConstraints(localTrack, "krisp-module-unavailable");
      return;
    }

    const supportedNow = Boolean(krispModule.isKrispNoiseFilterSupported?.());
    if (!supportedNow) {
      if (currentProcessor) {
        await stopProcessorWithTimeout(localTrack, "krisp-unsupported-runtime");
      }
      krispProcessorRef.current = null;
      krispGainProcessorRef.current = null;
      krispVoiceGateProcessorRef.current = null;
      setKrispSupported(false);
      markKrispFailedForSession(
        "Krisp is not supported in this browser/session.",
        "krisp-unsupported-runtime"
      );
      await applyNativeVoiceCleanupConstraints(localTrack, "krisp-unsupported-runtime");
      return;
    }

    setKrispSupported(true);

    let processor = krispProcessorRef.current;
    const activeKrispProcessor =
      currentProcessor &&
      currentProcessor === krispProcessorRef.current &&
      "setEnabled" in currentProcessor
        ? (currentProcessor as KrispNoiseFilterProcessor)
        : null;

    if (activeKrispProcessor) {
      krispProcessorRef.current = activeKrispProcessor;
      processor = activeKrispProcessor;
    }

    if (!processor || krispActiveTrackIdRef.current !== attachedTrackId) {
      processor = krispModule.KrispNoiseFilter({ quality: DEFAULT_KRISP_MODEL_QUALITY });
      krispProcessorRef.current = processor;
    }

    if (localTrack.getProcessor() !== processor) {
      const attachPromise = withKrispModelProxy(() => localTrack.setProcessor(processor));
      const processorAppliedResult = await runTimedAudioOperation(
        attachPromise,
        KRISP_PROCESSOR_ATTACH_TIMEOUT_MS,
        "krisp-processor-attach-timeout",
        { trackId: attachedTrackId }
      );
      const processorApplied = processorAppliedResult.status === "ok";

      if (!requestIsCurrent()) {
        if (processorApplied) {
          await stopProcessorWithTimeout(localTrack, "stale-krisp-attach-cleanup");
        }
        return;
      }

      if (!processorApplied) {
        if (processorAppliedResult.status === "error") {
          recordAudioDiagnosticEvent("krisp-processor-attach-error", {
            trackId: attachedTrackId,
            error:
              processorAppliedResult.error instanceof Error
                ? processorAppliedResult.error.message
                : String(processorAppliedResult.error)
          });
        } else {
          void attachPromise
            .then(() => {
              if (localTrack.getProcessor() === processor) {
                void stopProcessorWithTimeout(localTrack, "late-krisp-attach-timeout-cleanup");
              }
            })
            .catch(() => undefined);
        }
        krispProcessorRef.current = null;
        krispGainProcessorRef.current = null;
        krispVoiceGateProcessorRef.current = null;
        setKrispSupported(false);
        recordAudioDiagnosticEvent("krisp-processor-attach-failed");
        markKrispFailedForSession("Krisp processor failed to attach.", "krisp-processor-attach-failed");
        await applyNativeVoiceCleanupConstraints(localTrack, "krisp-processor-attach-failed");
        return;
      }

      currentProcessor = localTrack.getProcessor();
    }

    if (!requestIsCurrent()) {
      await stopProcessorWithTimeout(localTrack, "stale-krisp-attach-cleanup");
      return;
    }

    if (publishRoomContext && typeof processor.onPublish === "function") {
      const onPublishResult = await runTimedAudioOperation(
        processor.onPublish(publishRoomContext),
        KRISP_PROCESSOR_ENABLE_TIMEOUT_MS,
        "krisp-on-publish-timeout"
      );
      if (onPublishResult.status !== "ok") {
        recordAudioDiagnosticEvent("krisp-processor-on-publish-failed", {
          trackId: attachedTrackId,
          status: onPublishResult.status,
          error:
            onPublishResult.status === "error"
              ? onPublishResult.error instanceof Error
                ? onPublishResult.error.message
                : String(onPublishResult.error)
              : null
        });
        await stopProcessorWithTimeout(localTrack, "krisp-on-publish-failed");
        krispProcessorRef.current = null;
        krispGainProcessorRef.current = null;
        krispVoiceGateProcessorRef.current = null;
        markKrispFailedForSession(
          "Krisp processor could not finish preparing for publication.",
          "krisp-on-publish-failed"
        );
        await applyNativeVoiceCleanupConstraints(localTrack, "krisp-on-publish-failed");
        return;
      }
    }

    const enabledOperationResult = await setKrispEnabledWithTimeout(
      processor,
      true,
      "krisp-enable"
    );

    if (!requestIsCurrent()) {
      await stopProcessorWithTimeout(localTrack, "stale-krisp-enable-cleanup");
      return;
    }

    const enabledResult =
      enabledOperationResult.status === "ok" && enabledOperationResult.value !== false;

    if (!enabledResult) {
      if (enabledOperationResult.status === "error") {
        recordAudioDiagnosticEvent("krisp-enable-failed", {
          error:
            enabledOperationResult.error instanceof Error
              ? enabledOperationResult.error.message
              : String(enabledOperationResult.error)
        });
      }
      await stopProcessorWithTimeout(localTrack, "krisp-enable-failed");
      krispProcessorRef.current = null;
      krispGainProcessorRef.current = null;
      krispVoiceGateProcessorRef.current = null;
      if (!krispFailedRef.current || enabledOperationResult.status === "timeout") {
        recordAudioDiagnosticEvent("krisp-enable-returned-false");
      }
      markKrispFailedForSession("Krisp processor could not be enabled.", "krisp-enable-failed");
      await applyNativeVoiceCleanupConstraints(localTrack, "krisp-enable-failed");
      return;
    }

    if (!requestIsCurrent()) {
      await stopProcessorWithTimeout(localTrack, "stale-krisp-request-cleanup");
      return;
    }

    const processorAttached = localTrack.getProcessor() === processor;
    const finalProcessorEnabled = readKrispProcessorEnabled(processor) ?? true;
    const processedTrack = (processor as { processedTrack?: MediaStreamTrack }).processedTrack;
    const processedTrackLive = !processedTrack || processedTrack.readyState === "live";

    if (!processorAttached || finalProcessorEnabled === false || !processedTrackLive) {
      recordAudioDiagnosticEvent("krisp-active-verification-failed", {
        trackId: attachedTrackId,
        processorAttached,
        processorEnabled: finalProcessorEnabled,
        processedTrackState: processedTrack?.readyState ?? null
      });
      await stopProcessorWithTimeout(localTrack, "krisp-active-verification-failed");
      krispProcessorRef.current = null;
      krispGainProcessorRef.current = null;
      krispVoiceGateProcessorRef.current = null;
      markKrispFailedForSession(
        "Krisp processor was not active on the current microphone track.",
        "krisp-active-verification-failed"
      );
      await applyNativeVoiceCleanupConstraints(localTrack, "krisp-active-verification-failed");
      return;
    }

    krispActiveTrackIdRef.current = attachedTrackId;
    setKrispAttachedTrackId(attachedTrackId);
    setKrispProcessorEnabled(finalProcessorEnabled);
    setLastProcessorFailure(null);
    updateKrispLifecycle("active", {
      reason: "krisp-enabled",
      processorEnabled: finalProcessorEnabled,
      attachedTrackId
    });
    recordAudioDiagnosticEvent("krisp-processor-active", {
      trackId: attachedTrackId,
      processorAttached,
      processorEnabled: finalProcessorEnabled
    });
  }

  async function syncVoiceGateOnlyProcessor(
    localTrack: LocalAudioTrack,
    experiment: Exclude<VoiceGateExperiment, "off">,
    config: VoiceGateConfig,
    reason: string
  ) {
    let processor = voiceGateProcessorRef.current;

    if (!processor) {
      processor = new VoiceGateProcessor(experiment, config, updateVoiceGateDiagnostics);
      voiceGateProcessorRef.current = processor;
    }

    processor.setGateProfile(experiment, config);

    if (localTrack.getProcessor() !== processor) {
      const processorApplied = await localTrack
        .setProcessor(processor)
        .then(() => true)
        .catch((error) => {
          recordAudioDiagnosticEvent("voice-gate-processor-attach-failed", {
            reason,
            profile: experiment,
            error: error instanceof Error ? error.message : String(error)
          });
          return false;
        });

      if (!processorApplied) {
        voiceGateProcessorRef.current = null;
        setLastProcessorFailure("Voice gate processor failed to attach.");
        resetVoiceGateDiagnostics(experiment);
        return false;
      }
    }

    krispProcessorRef.current = null;
    krispVoiceGateProcessorRef.current = null;
    setVoiceGateDiagnostics((previous) => ({
      ...previous,
      profile: experiment,
      enabled: true,
      processorActive: true,
      source: "voice-gate",
      closedGain: config.closedGain,
      updatedAt: previous.updatedAt ?? new Date().toISOString()
    }));
    recordAudioDiagnosticEvent("voice-gate-processor-active", {
      reason,
      profile: experiment,
      source: "voice-gate",
      closedGain: config.closedGain
    });
    return true;
  }

  async function syncVoiceGateAndKrispProcessing(
    localTrack: LocalAudioTrack | null,
    enabledNoiseFilter: boolean,
    supportedNoiseFilter: boolean,
    experiment: VoiceGateExperiment,
    publishRoomContext?: Room | null
  ) {
    if (!localTrack) {
      return;
    }

    const gateConfig = getVoiceGateConfig(experiment);
    if (!gateConfig) {
      voiceGateProcessorRef.current = null;
      krispVoiceGateProcessorRef.current = null;
      resetVoiceGateDiagnostics(experiment);
      await syncKrispNoiseFilter(
        localTrack,
        enabledNoiseFilter,
        supportedNoiseFilter,
        krispProcessingRequestRef.current,
        publishRoomContext
      );
      return;
    }
    const activeGateExperiment = experiment as Exclude<VoiceGateExperiment, "off">;

    if (enabledNoiseFilter && supportedNoiseFilter) {
      const enhancedCaptureApplied = await applyEnhancedKrispCaptureConstraints(
        localTrack,
        "before-krisp-voice-gate-attach"
      );
      if (!enhancedCaptureApplied) {
        await localTrack.stopProcessor().catch(() => undefined);
        krispProcessorRef.current = null;
        krispVoiceGateProcessorRef.current = null;
        krispFailedRef.current = true;
        setKrispFailed(true);
        setLastProcessorFailure("Krisp enhanced capture constraints could not be applied.");
        updateKrispLifecycle("failed", {
          reason: "enhanced-capture-constraints-failed",
          processorEnabled: false,
          attachedTrackId: null
        });
        await applyNativeVoiceCleanupConstraints(localTrack, "krisp-voice-gate-enhanced-capture-failed");
        await syncVoiceGateOnlyProcessor(
          localTrack,
          activeGateExperiment,
          gateConfig,
          "krisp-enhanced-capture-failed"
        );
        return;
      }

      const krispModule = await loadKrispNoiseFilterModule();

      if (!krispModule) {
        if (localTrack.getProcessor()) {
          await localTrack.stopProcessor().catch(() => undefined);
        }
        krispProcessorRef.current = null;
        krispVoiceGateProcessorRef.current = null;
        setKrispSupported(false);
        krispFailedRef.current = true;
        setKrispFailed(true);
        setLastProcessorFailure("Krisp module could not be loaded.");
        recordAudioDiagnosticEvent("krisp-module-unavailable-for-voice-gate", {
          profile: experiment
        });
        updateKrispLifecycle("failed", {
          reason: "krisp-module-unavailable-for-voice-gate",
          processorEnabled: false,
          attachedTrackId: null
        });
        await applyNativeVoiceCleanupConstraints(localTrack, "krisp-module-unavailable-for-voice-gate");
        await syncVoiceGateOnlyProcessor(
          localTrack,
          activeGateExperiment,
          gateConfig,
          "krisp-module-unavailable"
        );
        return;
      }

      let processor = krispVoiceGateProcessorRef.current;

      if (!processor) {
        processor = new KrispVoiceGateProcessor(
          krispModule.KrispNoiseFilter({ quality: DEFAULT_KRISP_MODEL_QUALITY }),
          activeGateExperiment,
          gateConfig,
          updateVoiceGateDiagnostics
        );
        krispVoiceGateProcessorRef.current = processor;
      }

      processor.setGateProfile(activeGateExperiment, gateConfig);

      if (localTrack.getProcessor() !== processor) {
        const processorPromise = withKrispModelProxy(() => localTrack.setProcessor(processor));
        const processorResult = await runTimedAudioOperation(
          processorPromise,
          JOIN_KRISP_PREPARE_TIMEOUT_MS,
          "krisp-voice-gate-processor-timeout"
        );
        const processorApplied = processorResult.status === "ok";

        if (processorResult.status === "error") {
          const error = processorResult.error;
          recordAudioDiagnosticEvent("krisp-voice-gate-processor-attach-failed", {
            profile: experiment,
            error: error instanceof Error ? error.message : String(error)
          });
        } else if (processorResult.status === "timeout") {
          void processorPromise
            .then(() => localTrack.stopProcessor().catch(() => undefined))
            .catch(() => undefined);
        }

        if (!processorApplied) {
          await localTrack.stopProcessor().catch(() => undefined);
          krispProcessorRef.current = null;
          krispVoiceGateProcessorRef.current = null;
          setKrispSupported(false);
          krispFailedRef.current = true;
          setKrispFailed(true);
          setLastProcessorFailure("Krisp voice gate processor failed to attach.");
          updateKrispLifecycle("failed", {
            reason: "krisp-voice-gate-attach-failed",
            processorEnabled: false,
            attachedTrackId: null
          });
          await applyNativeVoiceCleanupConstraints(localTrack, "krisp-voice-gate-attach-failed");
          await syncVoiceGateOnlyProcessor(
            localTrack,
            activeGateExperiment,
            gateConfig,
            "krisp-attach-failed"
          );
          return;
        }
      }

      if (publishRoomContext && typeof processor.onPublish === "function") {
        const onPublishResult = await runTimedAudioOperation(
          processor.onPublish(publishRoomContext),
          KRISP_PROCESSOR_ENABLE_TIMEOUT_MS,
          "krisp-voice-gate-on-publish-timeout"
        );
        if (onPublishResult.status !== "ok") {
          recordAudioDiagnosticEvent("krisp-voice-gate-on-publish-failed", {
            profile: experiment,
            status: onPublishResult.status,
            error:
              onPublishResult.status === "error"
                ? onPublishResult.error instanceof Error
                  ? onPublishResult.error.message
                  : String(onPublishResult.error)
                : null
          });
          await localTrack.stopProcessor().catch(() => undefined);
          krispProcessorRef.current = null;
          krispVoiceGateProcessorRef.current = null;
          markKrispFailedForSession(
            "Krisp voice gate could not finish preparing for publication.",
            "krisp-voice-gate-on-publish-failed"
          );
          await applyNativeVoiceCleanupConstraints(
            localTrack,
            "krisp-voice-gate-on-publish-failed"
          );
          await syncVoiceGateOnlyProcessor(
            localTrack,
            activeGateExperiment,
            gateConfig,
            "krisp-on-publish-failed"
          );
          return;
        }
      }

      const enableOperationResult = await runTimedAudioOperation(
        processor.setEnabled(true),
        KRISP_PROCESSOR_ENABLE_TIMEOUT_MS,
        "krisp-voice-gate-enable-timeout"
      );
      const enabledResult =
        enableOperationResult.status === "ok" && enableOperationResult.value !== false;
      if (enableOperationResult.status === "error") {
        const error = enableOperationResult.error;
        krispFailedRef.current = true;
        setKrispFailed(true);
        setLastProcessorFailure(error instanceof Error ? error.message : String(error));
        recordAudioDiagnosticEvent("krisp-voice-gate-enable-failed", {
          profile: experiment,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      if (!enabledResult) {
        await localTrack.stopProcessor().catch(() => undefined);
        krispProcessorRef.current = null;
        krispVoiceGateProcessorRef.current = null;
        updateKrispLifecycle("failed", {
          reason: "krisp-voice-gate-enable-failed",
          processorEnabled: false,
          attachedTrackId: null
        });
        await applyNativeVoiceCleanupConstraints(localTrack, "krisp-voice-gate-enable-failed");
        await syncVoiceGateOnlyProcessor(
          localTrack,
          activeGateExperiment,
          gateConfig,
          "krisp-enable-failed"
        );
        return;
      }

      voiceGateProcessorRef.current = null;
      krispProcessorRef.current = processor.krisp;
      const mediaTrack = getTrackMediaStreamTrack(localTrack);
      krispActiveTrackIdRef.current = mediaTrack?.id ?? null;
      setKrispAttachedTrackId(mediaTrack?.id ?? null);
      setKrispProcessorEnabled(readKrispProcessorEnabled(processor.krisp) ?? true);
      updateKrispLifecycle("active", {
        reason: "krisp-voice-gate-enabled",
        processorEnabled: readKrispProcessorEnabled(processor.krisp) ?? true,
        attachedTrackId: mediaTrack?.id ?? null
      });
      setVoiceGateDiagnostics((previous) => ({
        ...previous,
        profile: activeGateExperiment,
        enabled: true,
        processorActive: true,
        source: "krisp-voice-gate",
        closedGain: gateConfig.closedGain,
        updatedAt: previous.updatedAt ?? new Date().toISOString()
      }));
      recordAudioDiagnosticEvent("krisp-voice-gate-processor-active", {
        profile: activeGateExperiment,
        closedGain: gateConfig.closedGain
      });
      return;
    }

    if (enabledNoiseFilter && !supportedNoiseFilter) {
      await applyNativeVoiceCleanupConstraints(localTrack, "voice-gate-krisp-unsupported");
    }

    await syncVoiceGateOnlyProcessor(localTrack, activeGateExperiment, gateConfig, "krisp-disabled");
  }

  async function stopLocalAudioProcessing(localTrack: LocalAudioTrack | null, reason: string) {
    beginKrispProcessingRequest();

    if (desktopAudioProcessingTimeoutRef.current) {
      window.clearTimeout(desktopAudioProcessingTimeoutRef.current);
      desktopAudioProcessingTimeoutRef.current = 0;
    }

    if (!localTrack?.getProcessor()) {
      return;
    }

    logMuteDebug("audio-processing-stop-start", {
      reason,
      processorTrack: getTrackMediaStreamTrack(localTrack)
        ? {
            label: getTrackMediaStreamTrack(localTrack)?.label,
            enabled: getTrackMediaStreamTrack(localTrack)?.enabled,
            muted: getTrackMediaStreamTrack(localTrack)?.muted,
            readyState: getTrackMediaStreamTrack(localTrack)?.readyState
          }
        : null
    });

    const activeKrispProcessor = getKrispProcessorForTrack(localTrack);
    if (activeKrispProcessor) {
      const disableResult = await setKrispEnabledWithTimeout(
        activeKrispProcessor,
        false,
        reason,
        KRISP_PROCESSOR_STOP_TIMEOUT_MS
      );
      if (disableResult.status === "error") {
        recordAudioDiagnosticEvent("krisp-disable-failed", {
          reason,
          error:
            disableResult.error instanceof Error
              ? disableResult.error.message
              : String(disableResult.error)
        });
      }
    }

    const stopResult = await stopProcessorWithTimeout(localTrack, reason);
    if (stopResult.status === "error") {
      recordAudioDiagnosticEvent("audio-processor-stop-failed", {
        reason,
        error: stopResult.error instanceof Error ? stopResult.error.message : String(stopResult.error)
      });
    }
    krispProcessorRef.current = null;
    krispGainProcessorRef.current = null;
    microphoneGainProcessorRef.current = null;
    voiceGateProcessorRef.current = null;
    krispVoiceGateProcessorRef.current = null;
    resetVoiceGateDiagnostics();
    updateKrispLifecycle("disabled", {
      reason,
      processorEnabled: false,
      attachedTrackId: null
    });

    logMuteDebug("audio-processing-stop-complete", {
      reason,
      rawTrack: getTrackMediaStreamTrack(localTrack)
        ? {
            label: getTrackMediaStreamTrack(localTrack)?.label,
            enabled: getTrackMediaStreamTrack(localTrack)?.enabled,
            muted: getTrackMediaStreamTrack(localTrack)?.muted,
            readyState: getTrackMediaStreamTrack(localTrack)?.readyState
          }
        : null
    });
  }

  function scheduleDesktopAudioProcessing(
    localTrack: LocalAudioTrack | null,
    enabledNoiseFilter: boolean,
    supportedNoiseFilter: boolean,
    nextInputGain: number,
    nextVoiceGateExperiment: VoiceGateExperiment,
    reason: string
  ) {
    if (!localTrack || isMuted || desiredInputMutedRef.current) {
      return;
    }

    if (desktopAudioProcessingTimeoutRef.current) {
      window.clearTimeout(desktopAudioProcessingTimeoutRef.current);
    }

    const attempt = desktopAudioProcessingAttemptRef.current;
    const delay = attempt === 0 ? 450 : 900;

    logMuteDebug("desktop-processing-scheduled", {
      reason,
      attempt,
      delay,
      enabledNoiseFilter,
      supportedNoiseFilter,
      nextInputGain,
      nextVoiceGateExperiment
    });

    desktopAudioProcessingTimeoutRef.current = window.setTimeout(() => {
      desktopAudioProcessingTimeoutRef.current = 0;

      void (async () => {
        const latestTrack = getMicrophoneTrack(room?.localParticipant ?? null) ?? localTrack;
        const currentMediaTrack = getTrackMediaStreamTrack(latestTrack);

        if (
          !latestTrack ||
          isMuted ||
          desiredInputMutedRef.current ||
          currentMediaTrack?.readyState !== "live" ||
          !currentMediaTrack.enabled
        ) {
          logMuteDebug("desktop-processing-skipped", {
            reason,
            attempt,
            mediaReadyState: currentMediaTrack?.readyState ?? null,
            mediaEnabled: currentMediaTrack?.enabled ?? null
          });
          return;
        }

        await syncLocalAudioProcessingCore(
          latestTrack,
          enabledNoiseFilter,
          supportedNoiseFilter,
          nextInputGain,
          nextVoiceGateExperiment
        );

        await wait(260);
        const processedTrack = getTrackMediaStreamTrack(latestTrack);
        const processedTrackLive =
          processedTrack?.readyState === "live" && processedTrack.enabled;

        logMuteDebug("desktop-processing-verified", {
          reason,
          attempt,
          processedTrackLive,
          mediaReadyState: processedTrack?.readyState ?? null,
          mediaEnabled: processedTrack?.enabled ?? null,
          mediaLabel: processedTrack?.label ?? null
        });

        if (processedTrackLive || latestTrack.getProcessor() == null) {
          desktopAudioProcessingAttemptRef.current = 0;
          return;
        }

        await stopLocalAudioProcessing(latestTrack, "desktop-processor-ended-after-apply");

        if (attempt >= 1) {
          logMuteDebug("desktop-processing-fallback-raw", { reason, attempt });
          desktopAudioProcessingAttemptRef.current = 0;
          return;
        }

        desktopAudioProcessingAttemptRef.current = attempt + 1;
        scheduleDesktopAudioProcessing(
          getMicrophoneTrack(room?.localParticipant ?? null),
          enabledNoiseFilter,
          supportedNoiseFilter,
          nextInputGain,
          nextVoiceGateExperiment,
          "retry-after-ended-processor"
        );
      })();
    }, delay);
  }

  async function syncLocalAudioProcessingCore(
    localTrack: LocalAudioTrack | null,
    enabledNoiseFilter: boolean,
    supportedNoiseFilter: boolean,
    nextInputGain: number,
    nextVoiceGateExperiment: VoiceGateExperiment,
    publishRoomContext?: Room | null
  ) {
    const effectiveInputGain = getEffectiveBoostGain(nextInputGain, MAX_MICROPHONE_GAIN_PERCENT);

    if (!localTrack) {
      return;
    }

    const currentProcessorTrack = getTrackMediaStreamTrack(localTrack);
    if (localTrack.getProcessor() && currentProcessorTrack?.readyState === "ended") {
      await stopLocalAudioProcessing(localTrack, "stale-ended-processor");
    }

    if (!CUSTOM_INPUT_GAIN_PROCESSORS_ENABLED && Math.abs(effectiveInputGain - 1) > 0.01) {
      recordAudioDiagnosticEvent("input-gain-processor-skipped", {
        requestedGain: effectiveInputGain,
        mode: audioMode
      });
    }

    if (CUSTOM_INPUT_GAIN_PROCESSORS_ENABLED && Math.abs(effectiveInputGain - 1) > 0.01) {
      if (enabledNoiseFilter && supportedNoiseFilter) {
        const krispModule = await loadKrispNoiseFilterModule();

        if (krispModule) {
          let processor = krispGainProcessorRef.current;

          if (!processor) {
            processor = new KrispMicrophoneGainProcessor(
              krispModule.KrispNoiseFilter({ quality: DEFAULT_KRISP_MODEL_QUALITY }),
              effectiveInputGain
            );
            krispGainProcessorRef.current = processor;
          }

          if (localTrack.getProcessor() !== processor) {
            const processorApplied = await withKrispModelProxy(() =>
              localTrack.setProcessor(processor)
            )
              .then(() => true)
              .catch(() => false);

            if (!processorApplied) {
              krispGainProcessorRef.current = null;
              krispProcessorRef.current = null;
              setKrispSupported(false);
            } else {
              microphoneGainProcessorRef.current = null;
              krispProcessorRef.current = processor.krisp;
            }
          } else {
            krispProcessorRef.current = processor.krisp;
          }

          if (localTrack.getProcessor() === processor) {
            processor.setGain(effectiveInputGain);
            await processor.setEnabled(true).catch(() => undefined);
            return;
          }
        }
      }

      let processor = microphoneGainProcessorRef.current;

      if (!processor) {
        processor = new MicrophoneGainProcessor(effectiveInputGain);
        microphoneGainProcessorRef.current = processor;
      }

      if (localTrack.getProcessor() !== processor) {
        await localTrack.setProcessor(processor).catch(() => undefined);
      }

      processor.setGain(effectiveInputGain);
      krispProcessorRef.current = null;
      krispGainProcessorRef.current = null;
      return;
    }

    if (krispGainProcessorRef.current && localTrack.getProcessor() === krispGainProcessorRef.current) {
      await localTrack.stopProcessor().catch(() => undefined);
    }
    krispGainProcessorRef.current = null;

    if (microphoneGainProcessorRef.current && localTrack.getProcessor() === microphoneGainProcessorRef.current) {
      await localTrack.stopProcessor().catch(() => undefined);
    }
    microphoneGainProcessorRef.current = null;

    await syncVoiceGateAndKrispProcessing(
      localTrack,
      enabledNoiseFilter,
      supportedNoiseFilter,
      nextVoiceGateExperiment,
      publishRoomContext
    );
  }

  async function syncLocalAudioProcessing(
    localTrack: LocalAudioTrack | null,
    enabledNoiseFilter: boolean,
    supportedNoiseFilter: boolean,
    nextInputGain: number,
    nextVoiceGateExperiment = voiceGateExperimentRef.current,
    reason = "sync",
    publishRoomContext?: Room | null
  ) {
    if (!enabledNoiseFilter) {
      await stopLocalAudioProcessing(localTrack, `krisp-disabled:${reason}`);
      if (localTrack) {
        await applyNativeVoiceCleanupConstraints(localTrack, `krisp-disabled:${reason}`);
        updateKrispLifecycle("disabled", {
          reason: `krisp-disabled:${reason}`,
          processorEnabled: false,
          attachedTrackId: null
        });
      }
      return;
    }

    const requestId = beginKrispProcessingRequest();
    try {
      await syncLocalAudioProcessingCore(
        localTrack,
        true,
        supportedNoiseFilter && !krispFailedRef.current,
        nextInputGain,
        nextVoiceGateExperiment,
        publishRoomContext
      );
    } catch (error) {
      if (!isKrispProcessingRequestCurrent(requestId)) {
        return;
      }

      markKrispFailedForSession(
        error instanceof Error ? error.message : String(error),
        `krisp-sync-unhandled:${reason}`,
        null
      );
    }
  }

  async function tuneScreenShareSender(
    videoTrack: LocalVideoTrack,
    profile: ScreenShareProfile
  ) {
    await videoTrack.setDegradationPreference(profile.sender.degradationPreference).catch(
      () => undefined
    );

    const sender = videoTrack.sender;
    if (!sender?.getParameters || !sender.setParameters) {
      return;
    }

    const parameters = sender.getParameters();
    parameters.degradationPreference = profile.sender.degradationPreference;
    parameters.encodings = (parameters.encodings ?? [{}]).map((encoding, index) => ({
      ...encoding,
      active: encoding.active ?? true,
      maxBitrate:
        index === 0
          ? profile.sender.maxBitrate
          : Math.min(
              profile.sender.maxBitrate,
              encoding.maxBitrate ?? Math.floor(profile.sender.maxBitrate / (index + 1))
            ),
      maxFramerate: profile.sender.maxFramerate
    }));

    await sender.setParameters(parameters).catch(() => undefined);
  }

  async function getScreenShareRemainingSeconds() {
    const response = await apiFetch("/api/stream-usage", {
      cache: "no-store"
    });
    const payload = (await response.json().catch(() => null)) as
      | { remainingSeconds?: number | null; error?: string }
      | null;

    if (!response.ok || !payload) {
      throw new Error(payload?.error ?? "Unable to check stream time.");
    }

    return payload.remainingSeconds === null
      ? Number.POSITIVE_INFINITY
      : typeof payload.remainingSeconds === "number"
        ? payload.remainingSeconds
        : 0;
  }

  async function reportLiveKitRoomUsage(payload: {
    webRtcSeconds?: number;
    streamSeconds?: number;
    streamBytes?: number;
  }) {
    const webRtcSeconds = Math.max(0, Math.floor(payload.webRtcSeconds ?? 0));
    const streamSeconds = Math.max(0, Math.floor(payload.streamSeconds ?? 0));
    const streamBytes = Math.max(0, Math.floor(payload.streamBytes ?? 0));

    if (webRtcSeconds <= 0 && streamSeconds <= 0 && streamBytes <= 0) {
      return;
    }

    await apiFetch("/api/livekit-usage", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        webRtcSeconds,
        streamSeconds,
        streamBytes
      })
    }).catch(() => undefined);
  }

  function getReportedStreamByteDelta() {
    const currentSample = previousLocalStreamStatsRef.current;

    if (!currentSample) {
      return 0;
    }

    const previousSample = screenShareUsageStreamSampleRef.current;
    screenShareUsageStreamSampleRef.current = currentSample;

    if (!previousSample || currentSample.bytes < previousSample.bytes) {
      return 0;
    }

    return currentSample.bytes - previousSample.bytes;
  }

  function reportRoomVoiceUsage(force = false) {
    if (roomUsageStartedAtRef.current === null) {
      return;
    }

    const now = Date.now();
    const lastReportedAt = roomUsageReportedAtRef.current ?? roomUsageStartedAtRef.current;
    const seconds = Math.floor((now - lastReportedAt) / 1000);

    if (seconds <= 0 || (!force && seconds < 5)) {
      return;
    }

    roomUsageReportedAtRef.current = now;
    void reportLiveKitRoomUsage({ webRtcSeconds: seconds });
  }

  function startRoomVoiceUsageTimer() {
    roomUsageStartedAtRef.current = Date.now();
    roomUsageReportedAtRef.current = roomUsageStartedAtRef.current;

    if (roomUsageIntervalRef.current) {
      window.clearInterval(roomUsageIntervalRef.current);
    }

    roomUsageIntervalRef.current = window.setInterval(() => {
      reportRoomVoiceUsage();
    }, SCREEN_SHARE_USAGE_REPORT_INTERVAL_MS);
  }

  function stopRoomVoiceUsageTimer() {
    if (roomUsageIntervalRef.current) {
      window.clearInterval(roomUsageIntervalRef.current);
      roomUsageIntervalRef.current = 0;
    }

    reportRoomVoiceUsage(true);
    roomUsageStartedAtRef.current = null;
    roomUsageReportedAtRef.current = null;
  }

  async function reportScreenShareUsage(force = false) {
    if (screenShareUsageStartedAtRef.current === null) {
      return 0;
    }

    const now = Date.now();
    const lastReportedAt = screenShareUsageReportedAtRef.current ?? screenShareUsageStartedAtRef.current;
    const seconds = Math.floor((now - lastReportedAt) / 1000);

    if (seconds <= 0 || (!force && seconds < 5)) {
      return null;
    }

    screenShareUsageReportedAtRef.current = now;
    const streamBytes = getReportedStreamByteDelta();

    void reportLiveKitRoomUsage({
      streamSeconds: seconds,
      streamBytes
    });

    const response = await apiFetch("/api/stream-usage", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seconds })
    });
    const payload = (await response.json().catch(() => null)) as
      | { remainingSeconds?: number | null; error?: string }
      | null;

    if (!response.ok || !payload) {
      throw new Error(payload?.error ?? "Unable to update stream time.");
    }

    return payload.remainingSeconds === null
      ? Number.POSITIVE_INFINITY
      : typeof payload.remainingSeconds === "number"
        ? payload.remainingSeconds
        : 0;
  }

  function startScreenShareUsageTimer(activeRoom: Room) {
    screenShareUsageStartedAtRef.current = Date.now();
    screenShareUsageReportedAtRef.current = screenShareUsageStartedAtRef.current;
    screenShareUsageStreamSampleRef.current = previousLocalStreamStatsRef.current;

    if (screenShareUsageIntervalRef.current) {
      window.clearInterval(screenShareUsageIntervalRef.current);
    }

    screenShareUsageIntervalRef.current = window.setInterval(() => {
      void reportScreenShareUsage()
        .then((remainingSeconds) => {
          if (remainingSeconds !== null && remainingSeconds <= 0) {
            setError("Daily streaming limit reached. You can stream again tomorrow.");
            void stopLocalScreenShare(activeRoom).finally(() => refreshParticipants(activeRoom));
          }
        })
        .catch(() => undefined);
    }, SCREEN_SHARE_USAGE_REPORT_INTERVAL_MS);
  }

  async function stopScreenShareUsageTimer() {
    if (screenShareUsageIntervalRef.current) {
      window.clearInterval(screenShareUsageIntervalRef.current);
      screenShareUsageIntervalRef.current = 0;
    }

    await reportScreenShareUsage(true).catch(() => undefined);
    screenShareUsageStartedAtRef.current = null;
    screenShareUsageReportedAtRef.current = null;
    screenShareUsageStreamSampleRef.current = null;
  }

  async function stopLocalScreenShare(activeRoom: Room | null, playCue = true) {
    const timingStartedAt = getPerformanceNow();
    const session = screenShareSessionRef.current;
    screenShareSessionRef.current = null;

    if (!session || !activeRoom) {
      return;
    }

    session.cleanup();
    await stopScreenShareUsageTimer();
    previousScreenShareAudioStatsRef.current = null;
    await session.audioPublication?.mute().catch(() => undefined);
    await activeRoom.localParticipant.unpublishTrack(session.videoTrack, true).catch(() => undefined);
    if (session.audioTrack) {
      await activeRoom.localParticipant.unpublishTrack(session.audioTrack, true).catch(() => undefined);
    }

    if (playCue) {
      void playUiCue("stream-stop");
    }

    recordPerformanceTiming("stream.stop", timingStartedAt, {
      status: "success",
      hadSystemAudio: Boolean(session.audioTrack)
    });
  }

  useEffect(() => {
    if (!isVoiceConnectedStatus(status) || !room) {
      stopRoomVoiceUsageTimer();
      return;
    }

    startRoomVoiceUsageTimer();

    return () => {
      stopRoomVoiceUsageTimer();
    };
  }, [room, status]);

  async function startLocalScreenShare(
    activeRoom: Room,
    includeSystemAudio: boolean,
    qualityMode: StreamQualityMode,
    options: { takeoverIdentity?: string | null; remainingSeconds?: number } = {}
  ) {
    const shouldCaptureSystemAudio = screenShareSystemAudioSupported && includeSystemAudio;
    const timingStartedAt = getPerformanceNow();
    const takeoverIdentity = options.takeoverIdentity ?? null;
    const activeRemoteStreamIdentity = getActiveRemoteStreamIdentity(activeRoom);
    if (activeRemoteStreamIdentity && activeRemoteStreamIdentity !== takeoverIdentity) {
      throw new Error("Someone is already live. Rooms are limited to one active stream.");
    }

    const profile = getScreenShareProfile(qualityMode);
    await stopLocalScreenShare(activeRoom, false);

    const remainingSeconds = options.remainingSeconds ?? await getScreenShareRemainingSeconds();
    if (remainingSeconds <= 0) {
      throw new Error("Daily streaming limit reached. You can stream again tomorrow.");
    }

    const captureOptions: ScreenShareCaptureOptions = {
      ...profile.capture,
      audio: shouldCaptureSystemAudio ? getScreenShareAudioConstraints() : false,
      systemAudio: shouldCaptureSystemAudio ? "include" : "exclude"
    };

    const createdTracks = await activeRoom.localParticipant.createScreenTracks(captureOptions);
    const videoTrack = createdTracks.find(
      (track): track is LocalVideoTrack => track.kind === Track.Kind.Video
    );
    const audioTrack =
      createdTracks.find(
        (track): track is LocalAudioTrack => track.kind === Track.Kind.Audio
      ) ?? null;

    if (!videoTrack) {
      createdTracks.forEach((track) => track.stop());
      throw new Error("Screen capture did not return a video track.");
    }

    const activeStreamAfterCapture = getActiveRemoteStreamIdentity(activeRoom);
    if (activeStreamAfterCapture && activeStreamAfterCapture !== takeoverIdentity) {
      createdTracks.forEach((track) => track.stop());
      throw new Error("Someone is already live. Rooms are limited to one active stream.");
    }

    videoTrack.mediaStreamTrack.contentHint = profile.capture.contentHint ?? "motion";

    const streamName = `screen-${activeRoom.localParticipant.identity}`;
    let videoPublication: LocalTrackPublication;
    try {
      videoPublication = await activeRoom.localParticipant.publishTrack(videoTrack, {
        ...profile.videoPublish,
        source: Track.Source.ScreenShare,
        stream: streamName
      });
    } catch (error) {
      if (profile.videoPublish.videoCodec !== "vp8") {
        throw error;
      }

      videoPublication = await activeRoom.localParticipant.publishTrack(videoTrack, {
        ...profile.videoPublish,
        videoCodec: "h264",
        source: Track.Source.ScreenShare,
        stream: streamName
      });
    }
    const audioPublication =
      audioTrack && shouldCaptureSystemAudio
        ? await activeRoom.localParticipant.publishTrack(audioTrack, {
            ...profile.audioPublish,
            source: Track.Source.ScreenShareAudio,
            stream: streamName
          })
        : null;
    scheduleLocalAudioStatsSample(
      audioPublication,
      profile.audioPublish,
      previousScreenShareAudioStatsRef
    );

    const handleEnded = () => {
      void stopLocalScreenShare(activeRoom).finally(() => refreshParticipants(activeRoom));
    };
    videoTrack.mediaStreamTrack.addEventListener("ended", handleEnded, { once: true });

    screenShareSessionRef.current = {
      videoTrack,
      audioTrack,
      videoPublication,
      audioPublication,
      mode: qualityMode,
      cleanup: () => {
        videoTrack.mediaStreamTrack.removeEventListener("ended", handleEnded);
      }
    };

    setScreenTrack(videoTrack);
    setScreenTrackIdentity(activeRoom.localParticipant.identity);
    setIsSharing(true);

    await tuneScreenShareSender(videoTrack, profile);
    startScreenShareUsageTimer(activeRoom);
    void playUiCue("stream-start");
    recordPerformanceTiming("stream.start", timingStartedAt, {
      status: "success",
      includeSystemAudio: shouldCaptureSystemAudio,
      qualityMode
    });
  }

  function refreshParticipants(activeRoom: Room) {
    if (!isActiveRoomInstance(activeRoom)) {
      return;
    }

    const now = performance.now();
    const nextVoiceActivity = new Map<string, ParticipantVoiceActivity>();
    const allParticipants = [
      activeRoom.localParticipant,
      ...Array.from(activeRoom.remoteParticipants.values())
    ];

    setParticipants(
      allParticipants.flatMap((participant) => {
        const metadata = parseParticipantMetadata(participant.metadata);
        if (!participant.isLocal && isHiddenParticipantMetadata(metadata)) {
          return [];
        }

        const audioLevel = Math.min(1, Math.max(0, participant.audioLevel ?? 0));
        const voiceActivity = resolveParticipantVoiceActivity(
          participantVoiceActivityRef.current.get(participant.identity),
          audioLevel,
          Boolean(participant.isSpeaking),
          now
        );
        nextVoiceActivity.set(participant.identity, voiceActivity.activity);
        const isLocal = participant === activeRoom.localParticipant;

        return [{
          participantId: participant.identity,
          userId: metadata.userId ?? null,
          identity: getParticipantDisplayName(participant),
          displayName: getParticipantDisplayName(participant),
          avatarSrc: getParticipantAvatarSrc(metadata),
          isSpeaking: voiceActivity.isSpeaking,
          voiceLevel: Number(voiceActivity.voiceLevel.toFixed(3)),
          isLocal,
          isStreaming: isParticipantStreaming(participant),
          isSelfMuted: isLocal
            ? desiredInputMutedRef.current
            : getSelfMutedState(participant, metadata),
          isSelfDeafened: isLocal
            ? desiredOutputMutedRef.current
            : getSelfDeafenedState(metadata),
          isAfk: isLocal ? desiredAfkRef.current : Boolean(metadata.isAfk)
        }];
      })
    );
    participantVoiceActivityRef.current = nextVoiceActivity;

    const localScreen = getScreenTrack(activeRoom.localParticipant);
    const remoteScreenParticipant =
      Array.from(activeRoom.remoteParticipants.values()).find((participant) =>
        Boolean(getScreenTrack(participant))
      ) ?? null;
    const remoteScreen = remoteScreenParticipant ? getScreenTrack(remoteScreenParticipant) : null;

    setScreenTrack(localScreen ?? remoteScreen);
    setScreenTrackIdentity(
      localScreen
        ? activeRoom.localParticipant.identity
        : remoteScreenParticipant
          ? remoteScreenParticipant.identity
          : null
    );
    setIsSharing(Boolean(localScreen));
  }

  function getAudioCaptureOptions(
    nextInputId: string,
    nextNoiseFilterEnabled = noiseFilterEnabled,
    nextKrispSupported = effectiveKrispSupported,
    nextAudioProfile = audioProfile
  ) {
    const nextMode = resolveAudioMode({
      diagnosticFallback: diagnosticFallbackActiveRef.current,
      audioProfile: nextAudioProfile,
      noiseFilterEnabled: nextNoiseFilterEnabled,
      krispSupported: nextKrispSupported,
      krispFailed: krispFailedRef.current
    });
    const constraintProfile: SovChatAudioProfile =
      nextMode === "safe" && isNoiseFilterProfile(nextAudioProfile) && krispFailedRef.current
        ? "standard"
        : nextAudioProfile;
    const nextKrispActive =
      nextNoiseFilterEnabled && !krispFailedRef.current;
    const constraints = buildMicrophoneCaptureOptions({
      selectedInputId: nextInputId,
      mode: nextMode,
      profile: constraintProfile,
      noiseFilterEnabled: nextNoiseFilterEnabled,
      krispActive: nextKrispActive
    });
    const voiceIsolation = (constraints as MediaTrackConstraints & { voiceIsolation?: boolean })
      .voiceIsolation;
    const requestedCaptureConstraints = getCaptureConstraintDiagnostics(constraints);

    recordAudioDiagnosticEvent("capture-constraints-built", {
      mode: nextMode,
      profile: nextAudioProfile,
      constraintProfile,
      krispExpected: nextNoiseFilterEnabled,
      krispActive: nextKrispActive,
      hasDeviceId: Boolean(constraints.deviceId),
      requestedCaptureConstraints,
      echoCancellation: constraints.echoCancellation ?? null,
      noiseSuppression: constraints.noiseSuppression ?? null,
      autoGainControl: constraints.autoGainControl ?? null,
      voiceIsolation: voiceIsolation ?? null,
      channelCount: constraints.channelCount ?? null
    });

    return constraints;
  }

  async function enableMicrophoneWithDefaultFallback(
    participant: LocalParticipant,
    nextInputId: string,
    nextNoiseFilterEnabled: boolean,
    nextAudioProfile: SovChatAudioProfile,
    syncId: string,
    inputDeviceChanged: boolean,
    publishOptions = microphonePublishOptions
  ): Promise<{
    publication: LocalTrackPublication | undefined;
    usedDefaultInputFallback: boolean;
    inputDeviceAlreadyApplied: boolean;
  }> {
    const selectedDeviceId = getConcreteDeviceId(nextInputId);

    try {
      const publication = await participant.setMicrophoneEnabled(
        true,
        getAudioCaptureOptions(
          nextInputId,
          nextNoiseFilterEnabled,
          effectiveKrispSupported,
          nextAudioProfile
        ),
        publishOptions
      );
      return { publication, usedDefaultInputFallback: false, inputDeviceAlreadyApplied: false };
    } catch (caughtError) {
      const message = getAudioErrorMessage(caughtError);
      setLastAudioError(message);
      setLastDeviceSwitchResult(`failed:${message}`);
      recordAudioDiagnosticEvent("microphone-enable-failed", {
        syncId,
        inputDeviceChanged,
        selectedInputId: nextInputId,
        errorName: getAudioErrorName(caughtError) || null,
        error: message
      });

      if (!selectedDeviceId || !isSelectedInputDeviceFailure(caughtError)) {
        return {
          publication: undefined,
          usedDefaultInputFallback: false,
          inputDeviceAlreadyApplied: false
        };
      }

      recordAudioDiagnosticEvent("selected-microphone-fallback-start", {
        syncId,
        selectedInputId: nextInputId,
        errorName: getAudioErrorName(caughtError) || null
      });

      await participant.setMicrophoneEnabled(false).catch(() => undefined);

      try {
        const publication = await participant.setMicrophoneEnabled(
          true,
          getAudioCaptureOptions(
            "default",
            nextNoiseFilterEnabled,
            effectiveKrispSupported,
            nextAudioProfile
          ),
          publishOptions
        );
        setLastAudioError(null);
        setLastDeviceSwitchResult("input:fallback-default");
        recordAudioDiagnosticEvent("selected-microphone-fallback-used", {
          syncId,
          selectedInputId: nextInputId
        });
        return { publication, usedDefaultInputFallback: true, inputDeviceAlreadyApplied: false };
      } catch (fallbackError) {
        const fallbackMessage = getAudioErrorMessage(fallbackError);
        setLastAudioError(fallbackMessage);
        setLastDeviceSwitchResult(`fallback:failed:${fallbackMessage}`);
        recordAudioDiagnosticEvent("selected-microphone-fallback-failed", {
          syncId,
          selectedInputId: nextInputId,
          errorName: getAudioErrorName(fallbackError) || null,
          error: fallbackMessage
        });
        return {
          publication: undefined,
          usedDefaultInputFallback: false,
          inputDeviceAlreadyApplied: false
        };
      }
    }
  }

  function stopUnpublishedLocalAudioTrack(localTrack: LocalAudioTrack) {
    localTrack.stop();
    getTrackSourceMediaStreamTrack(localTrack)?.stop();
    getTrackMediaStreamTrack(localTrack)?.stop();
  }

  function attachParticipantAudioContextToTrack(
    participant: LocalParticipant,
    localTrack: LocalAudioTrack,
    reason: string,
    syncId: string
  ) {
    const audioContext = (participant as unknown as { audioContext?: AudioContext | null })
      .audioContext;

    if (!audioContext || audioContext.state === "closed") {
      recordAudioDiagnosticEvent("prepared-microphone-audio-context-missing", {
        syncId,
        reason,
        audioContextState: audioContext?.state ?? null
      });
      return false;
    }

    localTrack.setAudioContext(audioContext);
    recordAudioDiagnosticEvent("prepared-microphone-audio-context-attached", {
      syncId,
      reason,
      audioContextState: audioContext.state,
      sampleRate: audioContext.sampleRate
    });
    return true;
  }

  async function createPreparedMicrophoneTrackWithDefaultFallback(
    nextRoom: Room,
    nextInputId: string,
    nextNoiseFilterEnabled: boolean,
    nextAudioProfile: SovChatAudioProfile,
    nextInputGain: number,
    syncId: string
  ): Promise<{
    localTrack: LocalAudioTrack | null;
    usedDefaultInputFallback: boolean;
    inputDeviceAlreadyApplied: boolean;
  }> {
    const selectedDeviceId = getConcreteDeviceId(nextInputId);

    async function createPreparedTrack(inputId: string, reason: string) {
      const localTrack = await createLocalAudioTrack(
        getAudioCaptureOptions(
          inputId,
          nextNoiseFilterEnabled,
          effectiveKrispSupported,
          nextAudioProfile
        )
      );

      try {
        const hasAudioContext = attachParticipantAudioContextToTrack(
          nextRoom.localParticipant,
          localTrack,
          reason,
          syncId
        );

        if (nextNoiseFilterEnabled && !krispFailedRef.current && hasAudioContext) {
          await syncLocalAudioProcessing(
            localTrack,
            true,
            !krispFailedRef.current,
            nextInputGain,
            voiceGateExperimentRef.current,
            reason,
            nextRoom
          );
        } else if (nextNoiseFilterEnabled && !hasAudioContext) {
          recordAudioDiagnosticEvent("prepared-microphone-processing-deferred", {
            syncId,
            reason,
            selectedInputId: inputId
          });
        }

        recordAudioDiagnosticEvent("prepared-microphone-track-created", {
          syncId,
          reason,
          selectedInputId: inputId,
          krispRequested: nextNoiseFilterEnabled,
          krispFailed: krispFailedRef.current
        });
        return localTrack;
      } catch (error) {
        await stopLocalAudioProcessing(
          localTrack,
          `prepared-microphone-processing-failed:${reason}`
        ).catch(() => undefined);
        stopUnpublishedLocalAudioTrack(localTrack);
        throw error;
      }
    }

    try {
      const localTrack = await createPreparedTrack(nextInputId, "before-microphone-publish");
      return {
        localTrack,
        usedDefaultInputFallback: false,
        inputDeviceAlreadyApplied: true
      };
    } catch (caughtError) {
      const message = getAudioErrorMessage(caughtError);
      setLastAudioError(message);
      setLastDeviceSwitchResult(`failed:${message}`);
      recordAudioDiagnosticEvent("prepared-microphone-track-create-failed", {
        syncId,
        selectedInputId: nextInputId,
        errorName: getAudioErrorName(caughtError) || null,
        error: message
      });

      if (!selectedDeviceId || !isSelectedInputDeviceFailure(caughtError)) {
        return {
          localTrack: null,
          usedDefaultInputFallback: false,
          inputDeviceAlreadyApplied: false
        };
      }

      recordAudioDiagnosticEvent("selected-microphone-fallback-start", {
        syncId,
        selectedInputId: nextInputId,
        errorName: getAudioErrorName(caughtError) || null
      });

      try {
        const localTrack = await createPreparedTrack(
          "default",
          "before-microphone-publish:fallback-default"
        );
        setLastAudioError(null);
        setLastDeviceSwitchResult("input:fallback-default");
        recordAudioDiagnosticEvent("selected-microphone-fallback-used", {
          syncId,
          selectedInputId: nextInputId
        });
        return {
          localTrack,
          usedDefaultInputFallback: true,
          inputDeviceAlreadyApplied: true
        };
      } catch (fallbackError) {
        const fallbackMessage = getAudioErrorMessage(fallbackError);
        setLastAudioError(fallbackMessage);
        setLastDeviceSwitchResult(`fallback:failed:${fallbackMessage}`);
        recordAudioDiagnosticEvent("selected-microphone-fallback-failed", {
          syncId,
          selectedInputId: nextInputId,
          errorName: getAudioErrorName(fallbackError) || null,
          error: fallbackMessage
        });
        return {
          localTrack: null,
          usedDefaultInputFallback: false,
          inputDeviceAlreadyApplied: false
        };
      }
    }
  }

  async function publishPreparedMicrophoneTrack(
    participant: LocalParticipant,
    localTrack: LocalAudioTrack,
    publishOptions: TrackPublishOptions,
    syncId: string
  ) {
    try {
      return await participant.publishTrack(localTrack, publishOptions);
    } catch (caughtError) {
      const message = getAudioErrorMessage(caughtError);
      setLastAudioError(message);
      recordAudioDiagnosticEvent("prepared-microphone-publish-failed", {
        syncId,
        errorName: getAudioErrorName(caughtError) || null,
        error: message
      });
      await stopLocalAudioProcessing(localTrack, "prepared-microphone-publish-failed").catch(
        () => undefined
      );
      stopUnpublishedLocalAudioTrack(localTrack);
      return undefined;
    }
  }

  async function prepareMicrophoneForJoin(
    attemptId: number,
    nextInputId: string,
    nextAudioProfile: SovChatAudioProfile
  ): Promise<PreparedJoinMicrophone> {
    const startedAt = getPerformanceNow();
    const selectedDeviceId = getConcreteDeviceId(nextInputId);

    const capture = async (inputId: string, usedDefaultInputFallback: boolean) => {
      const localTrack = await createLocalAudioTrack(
        getAudioCaptureOptions(inputId, false, false, nextAudioProfile)
      );

      if (!isActiveJoinAttempt(attemptId)) {
        stopUnpublishedLocalAudioTrack(localTrack);
        throw new JoinCancelledError();
      }

      pendingJoinMicrophoneTrackRef.current = localTrack;
      recordPerformanceTiming("voice.join.microphone-capture", startedAt, {
        attemptId,
        status: "success",
        usedDefaultInputFallback
      });
      recordAudioDiagnosticEvent("voice-join-microphone-captured", {
        attemptId,
        usedDefaultInputFallback
      });
      return { localTrack, usedDefaultInputFallback };
    };

    try {
      return await capture(nextInputId, false);
    } catch (error) {
      if (isJoinCancelledError(error)) {
        throw error;
      }

      if (!selectedDeviceId || !isSelectedInputDeviceFailure(error)) {
        recordPerformanceTiming("voice.join.microphone-capture", startedAt, {
          attemptId,
          status: "error",
          error: getAudioErrorMessage(error)
        });
        throw error;
      }

      recordAudioDiagnosticEvent("voice-join-selected-microphone-fallback", {
        attemptId,
        errorName: getAudioErrorName(error) || null
      });
      return await capture("default", true);
    }
  }

  async function syncAudioDevices(
    nextRoom: Room | null,
    nextInputId: string,
    nextOutputId: string,
    nextMuted: boolean,
    nextNoiseFilterEnabled: boolean,
    nextInputGain: number,
    nextOutputMuted: boolean,
    nextVoiceVolume: number,
    nextStreamMuted = streamMuted,
    nextStreamVolume = streamVolume,
    nextThirdPartyMutedIds = thirdPartyMutedIds,
    nextMicrophonePublishOptions = microphonePublishOptions
  ) {
    nextInputGain = 1;
    const nextAudioProfile = audioSettingsStore.getState().audioProfile;
    const nextEnhancedNoiseSuppressionEnabled = Boolean(nextNoiseFilterEnabled);
    const nextAudioMode = resolveAudioMode({
      diagnosticFallback: diagnosticFallbackActiveRef.current,
      audioProfile: nextAudioProfile,
      noiseFilterEnabled: nextEnhancedNoiseSuppressionEnabled,
      krispSupported: effectiveKrispSupported,
      krispFailed: krispFailedRef.current
    });
    const nextPublishDiagnostics = microphonePublishPlan.diagnostics;
    const syncId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const syncRequestId = audioDeviceSyncRequestRef.current + 1;
    audioDeviceSyncRequestRef.current = syncRequestId;

    logMuteDebug("sync-requested", {
      syncId,
      syncRequestId,
      nextInputId,
      nextOutputId,
      nextMuted,
      enhancedNoiseSuppressionEnabled: nextEnhancedNoiseSuppressionEnabled,
      nextAudioProfile,
      nextInputGain,
      nextOutputMuted,
      publishAudioPreset: nextPublishDiagnostics.publishAudioPreset,
      publishDtx: nextMicrophonePublishOptions.dtx ?? null,
      publishRed: nextMicrophonePublishOptions.red ?? null,
      publishForceStereo: nextMicrophonePublishOptions.forceStereo ?? null,
      publishMaxBitrate: nextMicrophonePublishOptions.audioPreset?.maxBitrate ?? null,
      publishProfile: nextPublishDiagnostics.publishProfile,
      voiceGateExperiment: voiceGateExperimentRef.current,
      hasRoom: Boolean(nextRoom)
    });

    desiredInputMutedRef.current = nextMuted;
    desiredOutputMutedRef.current = nextOutputMuted;

    audioSettingsStore.patch({
      selectedInputId: nextInputId,
      selectedOutputId: nextOutputId,
      inputMuted: nextMuted,
      outputMuted: nextOutputMuted,
      audioProfile: nextAudioProfile,
      noiseFilterEnabled: nextEnhancedNoiseSuppressionEnabled,
      inputGain: nextInputGain,
      outputVolume: nextVoiceVolume,
      streamMuted: nextStreamMuted,
      streamVolume: nextStreamVolume,
      outputSwitchSupported:
        typeof HTMLMediaElement !== "undefined" &&
        "setSinkId" in HTMLMediaElement.prototype
    });

    if (!nextRoom) {
      logMuteDebug("sync-skipped-no-room", { syncId, nextMuted });
      return;
    }

    const syncOperation = audioDeviceSyncQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const normalizedInputId = getConcreteDeviceId(nextInputId) || null;
        const normalizedOutputId = getConcreteDeviceId(nextOutputId) || null;
        const inputDeviceChanged = activeInputDeviceIdRef.current !== normalizedInputId;
        const audioIntentStillCurrent = () =>
          audioDeviceSyncRequestRef.current === syncRequestId &&
          nextMuted === desiredInputMutedRef.current &&
          nextOutputMuted === desiredOutputMutedRef.current;

        logMuteDebug("sync-started", {
          syncId,
          syncRequestId,
          nextMuted,
          inputDeviceChanged,
          normalizedInputId,
          normalizedOutputId
        });

        if (!audioIntentStillCurrent()) {
          logMuteDebug("sync-cancelled-stale-before-apply", {
            syncId,
            nextMuted,
            nextOutputMuted,
            desiredMuted: desiredInputMutedRef.current,
            desiredOutputMuted: desiredOutputMutedRef.current
          });
          return;
        }

        if (nextMuted) {
          logMuteDebug("mute-apply-start", { syncId });
          await ensureLocalMicrophoneMuted(nextRoom.localParticipant);
          logMuteDebug("mute-apply-after-track-mute", { syncId });
          if (!audioIntentStillCurrent()) {
            logMuteDebug("sync-cancelled-stale-after-mute", {
              syncId,
              nextMuted,
              nextOutputMuted,
              desiredMuted: desiredInputMutedRef.current,
              desiredOutputMuted: desiredOutputMutedRef.current
            });
            return;
          }
          paintVoiceEnergy(0, true);
          logMuteDebug("mute-apply-complete", { syncId });
        } else {
          logMuteDebug("unmute-apply-start", { syncId });
          let microphonePublication = getLocalMicrophonePublication(nextRoom.localParticipant);
          let microphoneTrack =
            microphonePublication?.audioTrack ?? getMicrophoneTrack(nextRoom.localParticipant);
          let mediaStreamTrack = getTrackMediaStreamTrack(microphoneTrack);
          let usedDefaultInputFallback = false;
          let inputDeviceAlreadyApplied = false;
          const shouldCreateOrSwitchTrack =
            inputDeviceChanged ||
            !microphonePublication ||
            !microphoneTrack ||
            !mediaStreamTrack ||
            mediaStreamTrack.readyState !== "live";
          const shouldPrepareKrispBeforePublish =
            nextEnhancedNoiseSuppressionEnabled && !krispFailedRef.current;

          if (shouldCreateOrSwitchTrack) {
            await stopLocalAudioProcessing(microphoneTrack, "replace-microphone-track");
            if (shouldPrepareKrispBeforePublish) {
              if (microphoneTrack) {
                await nextRoom.localParticipant
                  .unpublishTrack(microphoneTrack, true)
                  .catch((caughtError) => {
                    recordAudioDiagnosticEvent("replace-microphone-unpublish-failed", {
                      syncId,
                      error: getAudioErrorMessage(caughtError)
                    });
                  });
              }

              await nextRoom.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);

              const preparedTrackResult = await createPreparedMicrophoneTrackWithDefaultFallback(
                nextRoom,
                nextInputId,
                nextEnhancedNoiseSuppressionEnabled,
                nextAudioProfile,
                nextInputGain,
                syncId
              );
              usedDefaultInputFallback = preparedTrackResult.usedDefaultInputFallback;
              inputDeviceAlreadyApplied = preparedTrackResult.inputDeviceAlreadyApplied;

              if (preparedTrackResult.localTrack && !audioIntentStillCurrent()) {
                await stopLocalAudioProcessing(
                  preparedTrackResult.localTrack,
                  "prepared-microphone-discarded-stale-intent"
                ).catch(() => undefined);
                stopUnpublishedLocalAudioTrack(preparedTrackResult.localTrack);
                logMuteDebug("sync-cancelled-stale-before-prepared-publish", {
                  syncId,
                  nextMuted,
                  nextOutputMuted,
                  desiredMuted: desiredInputMutedRef.current,
                  desiredOutputMuted: desiredOutputMutedRef.current
                });
                return;
              }

              microphonePublication = preparedTrackResult.localTrack
                ? await publishPreparedMicrophoneTrack(
                    nextRoom.localParticipant,
                    preparedTrackResult.localTrack,
                    nextMicrophonePublishOptions,
                    syncId
                  )
                : undefined;
            } else {
              const microphoneEnableResult = await enableMicrophoneWithDefaultFallback(
                nextRoom.localParticipant,
                nextInputId,
                nextEnhancedNoiseSuppressionEnabled,
                nextAudioProfile,
                syncId,
                inputDeviceChanged,
                nextMicrophonePublishOptions
              );
              microphonePublication = microphoneEnableResult.publication;
              usedDefaultInputFallback = microphoneEnableResult.usedDefaultInputFallback;
              inputDeviceAlreadyApplied = microphoneEnableResult.inputDeviceAlreadyApplied;
            }

            if (normalizedInputId && !usedDefaultInputFallback && !inputDeviceAlreadyApplied) {
              logMuteDebug("unmute-switch-input-device", { syncId, nextInputId });
              await nextRoom.switchActiveDevice("audioinput", normalizedInputId)
                .then(() => setLastDeviceSwitchResult("input:ok"))
                .catch((caughtError) => {
                  const message =
                    caughtError instanceof Error ? caughtError.message : String(caughtError);
                  setLastDeviceSwitchResult(`input:failed:${message}`);
                  recordAudioDiagnosticEvent("input-device-switch-failed", {
                    syncId,
                    error: message
                  });
                });
            }
          } else {
            if (shouldPrepareKrispBeforePublish) {
              await syncLocalAudioProcessing(
                microphoneTrack,
                true,
                !krispFailedRef.current,
                nextInputGain,
                voiceGateExperimentRef.current,
                "before-existing-track-resume",
                nextRoom
              );
            } else {
              await nextRoom.localParticipant
                .setMicrophoneEnabled(true, undefined, nextMicrophonePublishOptions)
                .catch((caughtError) => {
                  const message =
                    caughtError instanceof Error ? caughtError.message : String(caughtError);
                  setLastAudioError(message);
                  recordAudioDiagnosticEvent("microphone-unmute-failed", {
                    syncId,
                    error: message
                  });
                });
            }
          }

          microphonePublication = getLocalMicrophonePublication(nextRoom.localParticipant);
          microphoneTrack =
            microphonePublication?.audioTrack ?? getMicrophoneTrack(nextRoom.localParticipant);
          mediaStreamTrack = getTrackMediaStreamTrack(microphoneTrack);

          logMuteDebug("unmute-after-enable", {
            syncId,
            shouldCreateOrSwitchTrack,
            mediaReadyState: mediaStreamTrack?.readyState ?? null,
            mediaLabel: mediaStreamTrack?.label ?? null
          });
          if (mediaStreamTrack) {
            const settings = getMediaTrackSettings(mediaStreamTrack) as
              | (MediaTrackSettings & {
                  echoCancellation?: boolean;
                  noiseSuppression?: boolean;
                  autoGainControl?: boolean;
                  voiceIsolation?: boolean;
                })
              | null;
            const actualTrackSettings = getAudioTrackSettingsDiagnostics(settings);
            recordAudioDiagnosticEvent("microphone-track-settings", {
              syncId,
              profile: nextAudioProfile,
              mode: nextAudioMode,
              actualTrackSettings,
              echoCancellation: settings?.echoCancellation ?? null,
              noiseSuppression: settings?.noiseSuppression ?? null,
              autoGainControl: settings?.autoGainControl ?? null,
              voiceIsolation: settings?.voiceIsolation ?? null,
              channelCount: settings?.channelCount ?? null,
              deviceId: settings?.deviceId ?? null
            });
          }
          scheduleLocalAudioStatsSample(
            microphonePublication,
            nextMicrophonePublishOptions,
            previousMicrophoneAudioStatsRef
          );

          if (!audioIntentStillCurrent()) {
            logMuteDebug("sync-cancelled-stale-after-enable", {
              syncId,
              nextMuted,
              nextOutputMuted,
              desiredMuted: desiredInputMutedRef.current,
              desiredOutputMuted: desiredOutputMutedRef.current
            });
            return;
          }

          await ensureLocalMicrophoneUnmuted(nextRoom.localParticipant, microphonePublication);
          logMuteDebug("unmute-after-track-unmute", { syncId });

          for (let attempt = 0; attempt < 4; attempt += 1) {
            if (!audioIntentStillCurrent()) {
              logMuteDebug("sync-cancelled-stale-during-unmute-retry", {
                syncId,
                attempt,
                nextMuted,
                nextOutputMuted,
                desiredMuted: desiredInputMutedRef.current,
                desiredOutputMuted: desiredOutputMutedRef.current
              });
              return;
            }

            const currentPublication = getLocalMicrophonePublication(nextRoom.localParticipant);
            const currentTrack =
              currentPublication?.audioTrack ?? getMicrophoneTrack(nextRoom.localParticipant);
            const currentMediaTrack = getTrackMediaStreamTrack(currentTrack);

            if (
              currentPublication &&
              !currentPublication.isMuted &&
              !currentPublication.isUpstreamPaused &&
              currentMediaTrack?.readyState === "live" &&
              currentMediaTrack.enabled
            ) {
              logMuteDebug("unmute-confirmed", { syncId, attempt });
              break;
            }

            logMuteDebug("unmute-retry-needed", { syncId, attempt });
            await wait(70);
            if (!audioIntentStillCurrent()) {
              logMuteDebug("sync-cancelled-stale-before-unmute-retry", {
                syncId,
                attempt,
                nextMuted,
                nextOutputMuted,
                desiredMuted: desiredInputMutedRef.current,
                desiredOutputMuted: desiredOutputMutedRef.current
              });
              return;
            }
            await ensureLocalMicrophoneUnmuted(nextRoom.localParticipant, currentPublication);
          }

          activeInputDeviceIdRef.current = microphonePublication
            ? usedDefaultInputFallback
              ? null
              : normalizedInputId
            : null;
          setLastDeviceSwitchResult((previous) => previous ?? "input:ok");

          const localTrackAfterUnmute = getMicrophoneTrack(nextRoom.localParticipant);
          const localTrackAlreadyPrepared = Boolean(
            shouldPrepareKrispBeforePublish && localTrackAfterUnmute?.getProcessor()
          );
          if (localTrackAlreadyPrepared) {
            recordAudioDiagnosticEvent("local-audio-processing-already-prepared", {
              syncId,
              enhancedNoiseSuppressionEnabled: nextEnhancedNoiseSuppressionEnabled,
              hasLocalTrack: true
            });
          } else if (room === nextRoom) {
            await syncLocalAudioProcessing(
              localTrackAfterUnmute,
              nextEnhancedNoiseSuppressionEnabled,
              !krispFailedRef.current,
              nextInputGain,
              voiceGateExperimentRef.current,
              "after-unmute",
              nextRoom
            );
          } else {
            recordAudioDiagnosticEvent("local-audio-processing-deferred", {
              syncId,
              reason: "room-state-not-committed",
              enhancedNoiseSuppressionEnabled: nextEnhancedNoiseSuppressionEnabled,
              hasLocalTrack: Boolean(localTrackAfterUnmute)
            });
            if (nextEnhancedNoiseSuppressionEnabled) {
              updateKrispLifecycle("loading", {
                reason: "deferred-until-room-connected",
                processorEnabled: null,
                attachedTrackId: getTrackSourceMediaStreamTrack(localTrackAfterUnmute)?.id ?? null
              });
            }
          }
          logMuteDebug("unmute-apply-complete", { syncId });
        }

        if (!audioIntentStillCurrent()) {
          logMuteDebug("sync-cancelled-stale-before-output-apply", {
            syncId,
            nextMuted,
            nextOutputMuted,
            desiredMuted: desiredInputMutedRef.current,
            desiredOutputMuted: desiredOutputMutedRef.current
          });
          return;
        }

        refreshParticipants(nextRoom);

        if (outputSupported && activeOutputDeviceIdRef.current !== normalizedOutputId) {
          if (normalizedOutputId) {
            await nextRoom.switchActiveDevice("audiooutput", normalizedOutputId)
              .then(() => setLastDeviceSwitchResult("output:ok"))
              .catch((caughtError) => {
                const message =
                  caughtError instanceof Error ? caughtError.message : String(caughtError);
                setLastDeviceSwitchResult(`output:failed:${message}`);
                recordAudioDiagnosticEvent("output-device-switch-failed", {
                  syncId,
                  error: message
                });
              });
          }
          activeOutputDeviceIdRef.current = normalizedOutputId;
        }

        applyRemoteAudioPreferences(
          nextOutputId,
          nextOutputMuted,
          nextVoiceVolume,
          nextStreamMuted,
          nextStreamVolume,
          nextThirdPartyMutedIds
        );

        logMuteDebug("sync-complete", { syncId, nextMuted });
      });

    const syncTask = runTimedAudioOperation(
      syncOperation,
      AUDIO_DEVICE_SYNC_TIMEOUT_MS,
      "audio-device-sync-timeout",
      {
        syncId,
        syncRequestId,
        nextMuted,
        nextOutputMuted,
        enhancedNoiseSuppressionEnabled: nextEnhancedNoiseSuppressionEnabled,
        nextAudioProfile
      }
    ).then((result) => {
      if (result.status === "ok") {
        return;
      }

      if (audioDeviceSyncRequestRef.current === syncRequestId) {
        audioDeviceSyncRequestRef.current += 1;
      }

      if (result.status === "timeout") {
        const message = "Audio setup timed out. Try leaving and rejoining voice if your mic is not live.";
        setLastAudioError(message);
        recordAudioDiagnosticEvent("audio-device-sync-failed", {
          syncId,
          syncRequestId,
          status: "timeout"
        });
        throw new Error(message);
      }

      const message = getAudioErrorMessage(result.error);
      setLastAudioError(message);
      recordAudioDiagnosticEvent("audio-device-sync-failed", {
        syncId,
        syncRequestId,
        status: "error",
        error: message
      });
      throw result.error;
    });

    audioDeviceSyncQueueRef.current = syncTask.catch(() => undefined);
    await syncTask;

    const recoveryPublication = nextRoom
      ? getLocalMicrophonePublication(nextRoom.localParticipant)
      : null;
    const recoveryTrack = nextRoom
      ? recoveryPublication?.audioTrack ?? getMicrophoneTrack(nextRoom.localParticipant)
      : null;
    const recoveryMediaTrack = getTrackMediaStreamTrack(recoveryTrack);
    const microphoneRecovered = isPublishedMicrophoneLive({
      publicationExists: Boolean(recoveryPublication),
      publicationMuted: recoveryPublication?.isMuted ?? true,
      upstreamPaused: recoveryPublication?.isUpstreamPaused ?? true,
      mediaReadyState: recoveryMediaTrack?.readyState ?? null,
      mediaEnabled: recoveryMediaTrack?.enabled ?? false
    });

    if (
      !nextMuted &&
      isActiveRoomInstance(nextRoom) &&
      microphoneJoinDegradedRef.current &&
      microphoneRecovered
    ) {
      microphoneJoinDegradedRef.current = false;
      setLastAudioError(null);
      setError(null);
      if (!krispFailedRef.current) {
        setStatus("connected");
      }
      recordAudioDiagnosticEvent("voice-join-microphone-recovered", {
        status: "connected",
        usedDefaultInput: activeInputDeviceIdRef.current === null
      });
    }
  }

  function queueAudioDeviceSync(...args: Parameters<typeof syncAudioDevices>) {
    void syncAudioDevices(...args).catch((caughtError) => {
      recordAudioDiagnosticEvent("audio-device-sync-background-failed", {
        error: getAudioErrorMessage(caughtError)
      });
    });
  }

  async function restartMicrophoneForNoiseFilterToggle(
    activeRoom: Room,
    currentAudioState: ReturnType<typeof audioSettingsStore.getState>,
    nextNoiseFilterEnabled: boolean
  ) {
    const restartRequestId = manualNoiseFilterRestartRequestRef.current + 1;
    manualNoiseFilterRestartRequestRef.current = restartRequestId;
    manualNoiseFilterRestartInFlightRef.current = true;
    const currentPublication = getLocalMicrophonePublication(activeRoom.localParticipant);
    const currentTrack =
      currentPublication?.audioTrack ?? getMicrophoneTrack(activeRoom.localParticipant);
    const reason = nextNoiseFilterEnabled
      ? "manual-krisp-toggle-on-restart"
      : "manual-krisp-toggle-off-restart";
    const previousNoiseFilterEnabled = currentAudioState.noiseFilterEnabled;

    const hasLivePublishedMicrophone = () => {
      const publication = getLocalMicrophonePublication(activeRoom.localParticipant);
      const track = publication?.audioTrack ?? getMicrophoneTrack(activeRoom.localParticipant);
      const mediaTrack = getTrackMediaStreamTrack(track);

      return isPublishedMicrophoneLive({
        publicationExists: Boolean(publication),
        publicationMuted: publication?.isMuted ?? true,
        upstreamPaused: publication?.isUpstreamPaused ?? true,
        mediaReadyState: mediaTrack?.readyState ?? null,
        mediaEnabled: mediaTrack?.enabled ?? false
      });
    };

    const restorePreviousNoiseFilterPreference = (nativeFallbackActive: boolean) => {
      audioSettingsStore.patch({ noiseFilterEnabled: previousNoiseFilterEnabled });
      setNoiseFilterEnabled(previousNoiseFilterEnabled);

      if (previousNoiseFilterEnabled && nativeFallbackActive) {
        krispFailedRef.current = true;
        setKrispFailed(true);
        setKrispPrewarmState("degraded");
        updateKrispLifecycle("fallback-standard", {
          reason: "manual-noise-filter-toggle-native-recovery",
          processorEnabled: false,
          attachedTrackId: null
        });
        return;
      }

      if (!previousNoiseFilterEnabled) {
        krispFailedRef.current = false;
        setKrispFailed(false);
        setKrispPrewarmState("idle");
        updateKrispLifecycle("disabled", {
          reason: "manual-noise-filter-toggle-rollback",
          processorEnabled: false,
          attachedTrackId: null
        });
      }
    };

    recordAudioDiagnosticEvent("manual-noise-filter-toggle-microphone-restart", {
      enabled: nextNoiseFilterEnabled,
      muted: currentAudioState.inputMuted,
      hasTrack: Boolean(currentTrack)
    });

    try {
      await stopLocalAudioProcessing(currentTrack, reason);

      if (currentTrack) {
        await activeRoom.localParticipant.unpublishTrack(currentTrack, true).catch((caughtError) => {
          recordAudioDiagnosticEvent("manual-noise-filter-toggle-unpublish-failed", {
            enabled: nextNoiseFilterEnabled,
            error: getAudioErrorMessage(caughtError)
          });
        });
      }

      await activeRoom.localParticipant.setMicrophoneEnabled(false).catch((caughtError) => {
        recordAudioDiagnosticEvent("manual-noise-filter-toggle-stop-failed", {
          enabled: nextNoiseFilterEnabled,
          error: getAudioErrorMessage(caughtError)
        });
      });

      previousMicrophoneAudioStatsRef.current = null;
      await wait(120);

      const latestNoiseFilterEnabled = audioSettingsStore.getState().noiseFilterEnabled;
      if (
        activeRoom !== activeRoomRef.current ||
        restartRequestId !== manualNoiseFilterRestartRequestRef.current ||
        latestNoiseFilterEnabled !== nextNoiseFilterEnabled
      ) {
        recordAudioDiagnosticEvent("manual-noise-filter-toggle-restart-skipped-stale-request", {
          enabled: nextNoiseFilterEnabled,
          latestEnabled: latestNoiseFilterEnabled
        });
        return;
      }

      await syncAudioDevices(
        activeRoom,
        currentAudioState.selectedInputId,
        currentAudioState.selectedOutputId,
        currentAudioState.inputMuted,
        nextNoiseFilterEnabled,
        currentAudioState.inputGain,
        currentAudioState.outputMuted,
        currentAudioState.outputVolume,
        currentAudioState.streamMuted,
        currentAudioState.streamVolume,
        thirdPartyMutedIds
      );
      if (!currentAudioState.inputMuted && !hasLivePublishedMicrophone()) {
        throw new Error("The microphone did not become live after changing the noise filter.");
      }
    } catch (caughtError) {
      if (
        activeRoom !== activeRoomRef.current ||
        restartRequestId !== manualNoiseFilterRestartRequestRef.current
      ) {
        recordAudioDiagnosticEvent("manual-noise-filter-toggle-failure-stale", {
          enabled: nextNoiseFilterEnabled,
          error: getAudioErrorMessage(caughtError)
        });
        return;
      }

      const toggleFailureMessage = getAudioErrorMessage(caughtError);
      recordAudioDiagnosticEvent("manual-noise-filter-toggle-recovery-start", {
        enabled: nextNoiseFilterEnabled,
        previousEnabled: previousNoiseFilterEnabled,
        muted: currentAudioState.inputMuted,
        error: toggleFailureMessage
      });
      restorePreviousNoiseFilterPreference(false);

      try {
        // Recovery uses native browser cleanup so it cannot recurse through the
        // failed Krisp path. syncAudioDevices already has a bounded timeout and
        // selected-device fallback.
        await syncAudioDevices(
          activeRoom,
          currentAudioState.selectedInputId,
          currentAudioState.selectedOutputId,
          currentAudioState.inputMuted,
          false,
          currentAudioState.inputGain,
          currentAudioState.outputMuted,
          currentAudioState.outputVolume,
          currentAudioState.streamMuted,
          currentAudioState.streamVolume,
          thirdPartyMutedIds
        );
        if (!currentAudioState.inputMuted && !hasLivePublishedMicrophone()) {
          throw new Error("Native microphone recovery did not publish a live track.");
        }

        if (
          activeRoom !== activeRoomRef.current ||
          restartRequestId !== manualNoiseFilterRestartRequestRef.current
        ) {
          return;
        }

        restorePreviousNoiseFilterPreference(true);
        const recoveredMessage =
          "The noise filter change failed, but your microphone was restored using browser audio cleanup.";
        setLastAudioError(recoveredMessage);
        if (previousNoiseFilterEnabled) {
          setStatus("degraded");
        }
        recordAudioDiagnosticEvent("manual-noise-filter-toggle-recovery-complete", {
          enabled: nextNoiseFilterEnabled,
          restoredEnabled: previousNoiseFilterEnabled,
          nativeFallback: true
        });
      } catch (recoveryError) {
        if (
          activeRoom !== activeRoomRef.current ||
          restartRequestId !== manualNoiseFilterRestartRequestRef.current
        ) {
          return;
        }

        restorePreviousNoiseFilterPreference(previousNoiseFilterEnabled);
        const recoveryMessage = `The noise filter change failed and SovChat could not restore your microphone. Leave and rejoin voice. ${getAudioErrorMessage(
          recoveryError
        )}`;
        setLastAudioError(recoveryMessage);
        setError(recoveryMessage);
        setStatus("degraded");
        recordAudioDiagnosticEvent("manual-noise-filter-toggle-recovery-failed", {
          enabled: nextNoiseFilterEnabled,
          restoredEnabled: previousNoiseFilterEnabled,
          toggleError: toggleFailureMessage,
          error: getAudioErrorMessage(recoveryError)
        });
      }
    } finally {
      if (restartRequestId === manualNoiseFilterRestartRequestRef.current) {
        manualNoiseFilterRestartInFlightRef.current = false;
      }
    }
  }

  async function resetLocalMicrophoneForNoiseGuard(details: Record<string, unknown>) {
    const activeRoom = room;
    const now = Date.now();

    if (
      !activeRoom ||
      isMuted ||
      desiredInputMutedRef.current ||
      whiteNoiseResetInFlightRef.current ||
      now - whiteNoiseResetLastTriggeredAtRef.current < WHITE_NOISE_GUARD_COOLDOWN_MS
    ) {
      return;
    }

    whiteNoiseResetInFlightRef.current = true;
    whiteNoiseResetLastTriggeredAtRef.current = now;
    logMuteDebug("white-noise-guard-reset-start", details);

    try {
      await activeRoom.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
      await wait(180);
      await syncAudioDevices(
        activeRoom,
        selectedInputId,
        selectedOutputId,
        false,
        noiseFilterEnabled,
        inputGain,
        outputMuted,
        outputVolume,
        streamMuted,
        streamVolume,
        thirdPartyMutedIds
      );
      logMuteDebug("white-noise-guard-reset-complete", details);
    } catch (error) {
      logMuteDebug("white-noise-guard-reset-failed", {
        ...details,
        error: error instanceof Error ? error.message : String(error)
      });
    } finally {
      whiteNoiseResetInFlightRef.current = false;
    }
  }

  async function safeAudioReset(reason = "manual") {
    const activeRoom = room;
    recordAudioDiagnosticEvent("safe-audio-reset-start", { reason });
    setLastAudioError(null);
    setLastProcessorFailure("Safe reset disabled Krisp for this session.");
    krispFailedRef.current = true;
    diagnosticFallbackActiveRef.current = reason === "diagnostic-fallback";
    setKrispFailed(true);
    setDiagnosticFallbackActive(reason === "diagnostic-fallback");

    if (!activeRoom) {
      detachAllRemoteAudio();
      recordAudioDiagnosticEvent("safe-audio-reset-complete", { reason, hadRoom: false });
      return;
    }

    const currentTrack = getMicrophoneTrack(activeRoom.localParticipant);

    try {
      await stopLocalAudioProcessing(currentTrack, "safe-audio-reset");
      await activeRoom.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
      detachAllRemoteAudio();
      await wait(180);
      await syncAudioDevices(
        activeRoom,
        selectedInputId,
        selectedOutputId,
        isMuted,
        noiseFilterEnabled,
        inputGain,
        outputMuted,
        outputVolume,
        streamMuted,
        streamVolume,
        thirdPartyMutedIds
      );
      reattachSubscribedRemoteAudio(activeRoom);
      refreshParticipants(activeRoom);
      recordAudioDiagnosticEvent("safe-audio-reset-complete", { reason, hadRoom: true });
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
      setLastAudioError(message);
      recordAudioDiagnosticEvent("safe-audio-reset-failed", { reason, error: message });
    }
  }

  useEffect(() => {
    return undefined;
  }, []);

  useEffect(() => {
    setKrispSupported(false);
    setKrispFailed(false);
    updateKrispLifecycle("disabled", {
      reason: "enhanced-noise-suppression-off",
      processorEnabled: false,
      attachedTrackId: null,
      record: false
    });
  }, []);

  useEffect(() => {
    const unsubscribe = audioSettingsStore.subscribe(() => {
      setForcedPerformanceMode(audioSettingsStore.getState().performanceMode);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = advancedSettingsStore.subscribe(() => {
      setAfkLeaveMinutes(advancedSettingsStore.getState().afkLeaveMinutes);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!room || !isVoiceConnectedStatus(status)) {
      setIsAfk(false);
      return undefined;
    }

    const desktopBridgeForIdle = getDesktopBridge();

    if (desktopBridgeForIdle?.getSystemIdleTime) {
      let interval = 0;
      let cancelled = false;
      let checkInFlight = false;
      const delaySeconds = AFK_SLEEP_BADGE_MS / 1000;

      const checkDesktopIdleTime = async () => {
        if (checkInFlight) {
          return;
        }

        checkInFlight = true;

        try {
          const idleSeconds = await desktopBridgeForIdle.getSystemIdleTime?.();
          if (!cancelled && typeof idleSeconds === "number") {
            setIsAfk(idleSeconds >= delaySeconds);
          }
        } finally {
          checkInFlight = false;
        }
      };

      interval = window.setInterval(() => {
        void checkDesktopIdleTime();
      }, 15_000);
      void checkDesktopIdleTime();

      return () => {
        cancelled = true;
        if (interval) {
          window.clearInterval(interval);
        }
      };
    }

    let timeout = 0;

    const resetTimer = () => {
      setIsAfk(false);
      if (timeout) {
        window.clearTimeout(timeout);
      }

      timeout = window.setTimeout(() => {
        setIsAfk(true);
      }, AFK_SLEEP_BADGE_MS);
    };

    const events = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
    events.forEach((eventName) => window.addEventListener(eventName, resetTimer, { passive: true }));
    resetTimer();

    return () => {
      if (timeout) {
        window.clearTimeout(timeout);
      }
      events.forEach((eventName) => window.removeEventListener(eventName, resetTimer));
    };
  }, [room, status]);

  useEffect(() => {
    if (!room || !isVoiceConnectedStatus(status)) {
      return undefined;
    }

    const limitMinutes =
      afkLeaveMinutes > 0
        ? Math.min(afkLeaveMinutes, HARD_IDLE_DISCONNECT_MINUTES)
        : HARD_IDLE_DISCONNECT_MINUTES;
    const desktopBridge = getDesktopBridge();
    if (desktopBridge?.getSystemIdleTime) {
      let interval = 0;
      let cancelled = false;
      let checkInFlight = false;
      const delaySeconds = limitMinutes * 60;

      const checkDesktopIdleTime = async () => {
        if (checkInFlight) {
          return;
        }

        checkInFlight = true;

        try {
          const idleSeconds = await desktopBridge.getSystemIdleTime?.();
          if (!cancelled && typeof idleSeconds === "number" && idleSeconds >= delaySeconds) {
            setError("Left voice because you were AFK.");
            void leaveRoom();
          }
        } finally {
          checkInFlight = false;
        }
      };

      interval = window.setInterval(() => {
        void checkDesktopIdleTime();
      }, 15_000);
      void checkDesktopIdleTime();

      return () => {
        cancelled = true;
        if (interval) {
          window.clearInterval(interval);
        }
      };
    }

    let timeout = 0;
    const delay = limitMinutes * 60 * 1000;
    const resetTimer = () => {
      if (timeout) {
        window.clearTimeout(timeout);
      }

      timeout = window.setTimeout(() => {
        setError("Left voice because you were AFK.");
        void leaveRoom();
      }, delay);
    };

    const events = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
    events.forEach((eventName) => window.addEventListener(eventName, resetTimer, { passive: true }));
    resetTimer();

    return () => {
      if (timeout) {
        window.clearTimeout(timeout);
      }
      events.forEach((eventName) => window.removeEventListener(eventName, resetTimer));
    };
  }, [room, status, afkLeaveMinutes]);

  useEffect(() => {
    if (!room || !isVoiceConnectedStatus(status) || !isSharing) {
      streamAfkStopInFlightRef.current = false;
      return undefined;
    }

    const stopShareForAfk = async () => {
      if (streamAfkStopInFlightRef.current) {
        return;
      }

      streamAfkStopInFlightRef.current = true;

      try {
        setError(`Stopped your stream after ${STREAM_AFK_STOP_MINUTES} minutes AFK.`);
        await stopLocalScreenShare(room);
        await refreshParticipants(room);
      } finally {
        streamAfkStopInFlightRef.current = false;
      }
    };

    if (desktopBridge?.getSystemIdleTime) {
      let interval = 0;
      let cancelled = false;
      let checkInFlight = false;
      const delaySeconds = STREAM_AFK_STOP_MS / 1000;

      const checkDesktopIdleTime = async () => {
        if (checkInFlight || cancelled || !screenShareSessionRef.current) {
          return;
        }

        checkInFlight = true;

        try {
          const idleSeconds = await desktopBridge.getSystemIdleTime?.();
          if (!cancelled && typeof idleSeconds === "number" && idleSeconds >= delaySeconds) {
            await stopShareForAfk();
          }
        } finally {
          checkInFlight = false;
        }
      };

      interval = window.setInterval(() => {
        void checkDesktopIdleTime();
      }, 15_000);
      void checkDesktopIdleTime();

      return () => {
        cancelled = true;
        if (interval) {
          window.clearInterval(interval);
        }
      };
    }

    let timeout = 0;
    const resetTimer = () => {
      if (timeout) {
        window.clearTimeout(timeout);
      }

      timeout = window.setTimeout(() => {
        void stopShareForAfk();
      }, STREAM_AFK_STOP_MS);
    };

    const events = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
    events.forEach((eventName) => window.addEventListener(eventName, resetTimer, { passive: true }));
    resetTimer();

    return () => {
      if (timeout) {
        window.clearTimeout(timeout);
      }
      events.forEach((eventName) => window.removeEventListener(eventName, resetTimer));
    };
  }, [desktopBridge, isSharing, room, status]);

  useEffect(() => {
    const unregisterController = audioSettingsStore.registerController({
      setInputDevice: (value) => {
        const currentAudioState = audioSettingsStore.getState();
        logMuteDebug("controller-set-input-device", {
          value,
          snapshotMuted: currentAudioState.inputMuted
        });
        setSelectedInputId(value);
        queueAudioDeviceSync(
          room,
          value,
          currentAudioState.selectedOutputId,
          currentAudioState.inputMuted,
          currentAudioState.noiseFilterEnabled,
          currentAudioState.inputGain,
          currentAudioState.outputMuted,
          currentAudioState.outputVolume,
          currentAudioState.streamMuted,
          currentAudioState.streamVolume,
          thirdPartyMutedIds
        );
      },
      setOutputDevice: (value) => {
        const currentAudioState = audioSettingsStore.getState();
        setSelectedOutputId(value);
        void syncOutputOnlyPreferences(
          value,
          currentAudioState.outputMuted,
          currentAudioState.outputVolume,
          currentAudioState.streamMuted,
          currentAudioState.streamVolume,
          thirdPartyMutedIds,
          "set-output-device"
        );
      },
      setInputMuted: (value) => {
        const currentAudioState = audioSettingsStore.getState();
        const nextOutputMuted = currentAudioState.outputMuted;
        logMuteDebug("controller-set-input-muted", {
          value,
          previousStoreMuted: currentAudioState.inputMuted
        });
        if (value !== currentAudioState.inputMuted || value !== isMuted) {
          void playUiCue(value ? "self-mute" : "self-unmute");
        }
        audioSettingsStore.patch({
          inputMuted: value,
          outputMuted: nextOutputMuted
        });
        setIsMuted(value);
        setOutputMuted(nextOutputMuted);
        syncLocalSelfContext(value, nextOutputMuted);
        queueAudioDeviceSync(
          room,
          currentAudioState.selectedInputId,
          currentAudioState.selectedOutputId,
          value,
          currentAudioState.noiseFilterEnabled,
          currentAudioState.inputGain,
          nextOutputMuted,
          currentAudioState.outputVolume,
          currentAudioState.streamMuted,
          currentAudioState.streamVolume,
          thirdPartyMutedIds
        );
      },
      setOutputMuted: (value) => {
        const currentAudioState = audioSettingsStore.getState();
        const nextInputMuted = currentAudioState.inputMuted;
        logMuteDebug("controller-set-output-muted", {
          value,
          snapshotInputMuted: nextInputMuted
        });
        if (value !== currentAudioState.outputMuted || value !== outputMuted) {
          void playUiCue(value ? "self-deafen" : "self-undeafen");
        }
        audioSettingsStore.patch({
          inputMuted: nextInputMuted,
          outputMuted: value
        });
        setIsMuted(nextInputMuted);
        setOutputMuted(value);
        syncLocalSelfContext(nextInputMuted, value);
        void syncOutputOnlyPreferences(
          currentAudioState.selectedOutputId,
          value,
          currentAudioState.outputVolume,
          currentAudioState.streamMuted,
          currentAudioState.streamVolume,
          thirdPartyMutedIds,
          "set-output-muted"
        );
      },
      setNoiseFilterEnabled: (value) => {
        const currentAudioState = audioSettingsStore.getState();
        logMuteDebug("controller-set-noise-filter", {
          value,
          snapshotMuted: currentAudioState.inputMuted
        });
        if (value) {
          krispFailedRef.current = false;
          setKrispFailed(false);
          setLastProcessorFailure(null);
          updateKrispLifecycle("loading", {
            reason: "manual-krisp-retry",
            processorEnabled: null,
            attachedTrackId: null
          });
        } else {
          krispFailedRef.current = false;
          setKrispFailed(false);
          setLastProcessorFailure(null);
        }
        audioSettingsStore.patch({ noiseFilterEnabled: value });
        setNoiseFilterEnabled(value);

        if (room && isVoiceConnectedStatus(status)) {
          void restartMicrophoneForNoiseFilterToggle(room, currentAudioState, value).catch(
            (caughtError) => {
              recordAudioDiagnosticEvent("manual-noise-filter-toggle-restart-failed", {
                enabled: value,
                error: getAudioErrorMessage(caughtError)
              });
            }
          );
          return;
        }

        queueAudioDeviceSync(
          room,
          currentAudioState.selectedInputId,
          currentAudioState.selectedOutputId,
          currentAudioState.inputMuted,
          value,
          currentAudioState.inputGain,
          currentAudioState.outputMuted,
          currentAudioState.outputVolume,
          currentAudioState.streamMuted,
          currentAudioState.streamVolume,
          thirdPartyMutedIds
        );
      },
      setAudioProfile: (value) => {
        const currentAudioState = audioSettingsStore.getState();
        logMuteDebug("controller-set-audio-profile", {
          value,
          snapshotMuted: currentAudioState.inputMuted
        });
        setAudioProfile("standard");
        queueAudioDeviceSync(
          room,
          currentAudioState.selectedInputId,
          currentAudioState.selectedOutputId,
          currentAudioState.inputMuted,
          currentAudioState.noiseFilterEnabled,
          currentAudioState.inputGain,
          currentAudioState.outputMuted,
          currentAudioState.outputVolume,
          currentAudioState.streamMuted,
          currentAudioState.streamVolume,
          thirdPartyMutedIds
        );
      },
      setInputGain: (value) => {
        if (Math.abs(value - 1) > 0.01) {
          recordAudioDiagnosticEvent("input-gain-ignored-stable-mode", { requestedValue: value });
        }
        setInputGain(1);
      },
      setOutputVolume: (value) => {
        const currentAudioState = audioSettingsStore.getState();
        const nextOutputVolume = getClampedGainVolume(value, MAX_SPEAKER_VOLUME_PERCENT);
        logMuteDebug("controller-set-output-volume", {
          value: nextOutputVolume,
          snapshotMuted: currentAudioState.inputMuted
        });
        setOutputVolume(nextOutputVolume);
        void syncOutputOnlyPreferences(
          currentAudioState.selectedOutputId,
          currentAudioState.outputMuted,
          nextOutputVolume,
          currentAudioState.streamMuted,
          currentAudioState.streamVolume,
          thirdPartyMutedIds,
          "set-output-volume"
        );
      }
    });

    return unregisterController;
  }, [
    room,
    selectedInputId,
    selectedOutputId,
    status,
    isMuted,
    outputMuted,
    noiseFilterEnabled,
    audioProfile,
    inputGain,
    krispSupported,
    outputVolume,
    streamMuted,
    streamVolume,
    outputSupported,
    thirdPartyMutedIds
  ]);

  useEffect(() => {
    const localTrack = getMicrophoneTrack(room?.localParticipant ?? null);
    if (manualNoiseFilterRestartInFlightRef.current) {
      return;
    }

    if (isMuted && noiseFilterEnabled) {
      return;
    }

    void syncLocalAudioProcessing(
      localTrack,
      noiseFilterEnabled,
      !krispFailedRef.current,
      inputGain,
      voiceGateExperiment,
      "settings-effect"
    );
  }, [
    room,
    noiseFilterEnabled,
    isMuted,
    krispFailed,
    inputGain,
    voiceGateExperiment
  ]);

  useEffect(() => {
    if (!room) {
      return;
    }

    const nextMetadata = JSON.stringify({
      userId,
      nickname,
      selfMuted: isMuted,
      selfDeafened: outputMuted,
      isAfk,
      avatarId: localAvatarDataUrl ? undefined : localAvatarId,
      avatarDataUrl: localAvatarDataUrl ?? undefined
    });

    if (room.localParticipant.metadata === nextMetadata) {
      return;
    }

    void room.localParticipant
      .setMetadata(nextMetadata)
      .then(() => refreshParticipants(room))
      .catch(() => undefined);
  }, [room, userId, nickname, isMuted, outputMuted, isAfk, localAvatarId, localAvatarDataUrl]);

  useEffect(() => {
    setOutputSupported(
      typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype
    );
  }, []);

  useEffect(() => {
    const currentVoiceIds = mergedParticipants.map((participant) => participant.displayName);
    const currentVoiceSet = new Set(currentVoiceIds);
    const onlineSet = new Set(onlineNicknames);

    for (const previousIdentity of previousVoiceIdsRef.current) {
      if (currentVoiceSet.has(previousIdentity)) {
        continue;
      }

      setTransitionLobbyNicknames((previous) =>
        previous.includes(previousIdentity) ? previous : [...previous, previousIdentity]
      );

      const existingTimeout = disconnectTimeoutsRef.current.get(previousIdentity);
      if (existingTimeout) {
        window.clearTimeout(existingTimeout);
      }

      const timeout = window.setTimeout(() => {
        setTransitionLobbyNicknames((previous) =>
          previous.filter((nicknameEntry) => nicknameEntry !== previousIdentity)
        );
        disconnectTimeoutsRef.current.delete(previousIdentity);
      }, onlineSet.has(previousIdentity) ? 1600 : 1200);

      disconnectTimeoutsRef.current.set(previousIdentity, timeout);
    }

    for (const currentIdentity of currentVoiceIds) {
      const timeout = disconnectTimeoutsRef.current.get(currentIdentity);
      if (timeout) {
        window.clearTimeout(timeout);
        disconnectTimeoutsRef.current.delete(currentIdentity);
      }
    }

    previousVoiceIdsRef.current = currentVoiceIds;
  }, [mergedParticipants, onlineNicknames]);

  useEffect(() => {
    return () => {
      for (const timeout of disconnectTimeoutsRef.current.values()) {
        window.clearTimeout(timeout);
      }
      disconnectTimeoutsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const target = fullscreenTarget === "remote"
      ? fullscreenScreenContainerRef.current
      : dockedScreenContainerRef.current;
    const attachedRemote = attachedRemoteScreenRef.current;

    if (isStreamPoppedOut && attachedRemote?.track === selectedRemoteScreenTrack) {
      attachedRemote.element.className = "h-full w-full bg-black object-contain";
      return;
    }

    if (!target || !selectedRemoteScreenTrack) {
      if (attachedRemote) {
        attachedRemote.track.detach(attachedRemote.element);
        attachedRemote.element.remove();
        attachedRemoteScreenRef.current = null;
      }
      return;
    }

    if (
      attachedRemote?.track === selectedRemoteScreenTrack &&
      attachedRemote.element.parentElement === target
    ) {
      attachedRemote.element.className = "h-full w-full bg-black/45 object-contain rounded-[1.1rem]";
      return;
    }

    if (attachedRemote) {
      attachedRemote.track.detach(attachedRemote.element);
      attachedRemote.element.remove();
    }

    const element = selectedRemoteScreenTrack.attach() as HTMLVideoElement;
    element.className = "h-full w-full bg-black/45 object-contain rounded-[1.1rem]";
    if (target.firstChild !== element) {
      target.replaceChildren(element);
    }
    attachedRemoteScreenRef.current = { track: selectedRemoteScreenTrack, element };
    const stopRenderFpsMonitor = monitorVideoRenderFps(element, (fps) => {
      remoteVideoRenderFpsRef.current = fps;
    });

    return () => {
      stopRenderFpsMonitor();
      if (
        attachedRemoteScreenRef.current?.element === element &&
        !documentPipVideoContainerRef.current?.contains(element)
      ) {
        selectedRemoteScreenTrack.detach(element);
        element.remove();
        attachedRemoteScreenRef.current = null;
      }
    };
  }, [dockedScreenContainerRef, fullscreenScreenContainerRef, fullscreenTarget, isStreamPoppedOut, selectedRemoteScreenTrack]);

  useEffect(() => {
    function handleFullscreenChange() {
      const fullscreenElement = document.fullscreenElement;
      if (
        fullscreenElement &&
        ((fullscreenStreamStageRef.current &&
          (fullscreenElement === fullscreenStreamStageRef.current ||
            fullscreenStreamStageRef.current.contains(fullscreenElement))) ||
          (dockedStreamStageRef.current &&
            (fullscreenElement === dockedStreamStageRef.current ||
              dockedStreamStageRef.current.contains(fullscreenElement))))
      ) {
        setFullscreenTarget("remote");
        return;
      }

      setFullscreenTarget(null);
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  useEffect(() => {
    if (fullscreenTarget !== "remote" || !selectedStreamIdentity) {
      return;
    }

    const container = fullscreenStreamStageRef.current;
    if (!container || document.fullscreenElement === container) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const nextContainer = fullscreenStreamStageRef.current;
      if (!nextContainer || document.fullscreenElement === nextContainer) {
        return;
      }

      void nextContainer.requestFullscreen?.().catch(() => {
        setFullscreenTarget(null);
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [fullscreenTarget, selectedStreamIdentity]);

  useEffect(() => {
    if (!room || isMuted) {
      paintVoiceEnergy(0, true);
      return;
    }

    if (!LEGACY_MIC_ANALYSER_RECOVERY_ENABLED) {
      if (typeof AudioContext === "undefined") {
        let frameId = 0;
        let disposed = false;

        const paintSmoothedFallbackEnergy = (targetEnergy: number) => {
          const previousEnergy = voiceEnergyRef.current;
          const coefficient =
            targetEnergy > previousEnergy ? VOICE_RING_VISUAL_ATTACK : VOICE_RING_VISUAL_RELEASE;
          paintVoiceEnergy(previousEnergy + (targetEnergy - previousEnergy) * coefficient);
        };

        const tick = () => {
          if (disposed) {
            return;
          }

          const level = (room.localParticipant as { audioLevel?: number }).audioLevel ?? 0;
          const targetEnergy = Math.max(0, Math.min(1, level * 2.8));
          paintSmoothedFallbackEnergy(targetEnergy);
          frameId = window.requestAnimationFrame(tick);
        };

        tick();

        return () => {
          disposed = true;
          if (frameId) {
            window.cancelAnimationFrame(frameId);
          }
          paintVoiceEnergy(0, true);
          if (noiseFloorWarningActiveRef.current) {
            noiseFloorWarningActiveRef.current = false;
            setNoiseFloorDiagnostics({
              warningActive: false,
              rms: null,
              durationMs: null,
              recommendedProfile: null
            });
            audioSettingsStore.patch({ noiseFloorWarning: null });
          }
        };
      }

      let retryTimeout = 0;
      let frameId = 0;
      let sampleTimeout = 0;
      let audioContext: AudioContext | null = null;
      let stream: MediaStream | null = null;
      let source: MediaStreamAudioSourceNode | null = null;
      let analyser: AnalyserNode | null = null;
      let disposed = false;
      let lastAnalyserBlockReason = "";

      const cleanupVisualizer = () => {
        if (frameId) {
          window.cancelAnimationFrame(frameId);
          frameId = 0;
        }
        if (sampleTimeout) {
          window.clearTimeout(sampleTimeout);
          sampleTimeout = 0;
        }
        source?.disconnect();
        analyser?.disconnect();
        stream?.getTracks().forEach((track) => track.stop());
        source = null;
        analyser = null;
        stream = null;

        if (audioContext) {
          void audioContext.close().catch(() => undefined);
          audioContext = null;
        }
      };

      const paintSmoothedVisualizerEnergy = (targetEnergy: number) => {
        const previousEnergy = voiceEnergyRef.current;
        const coefficient =
          targetEnergy > previousEnergy ? VOICE_RING_VISUAL_ATTACK : VOICE_RING_VISUAL_RELEASE;
        paintVoiceEnergy(previousEnergy + (targetEnergy - previousEnergy) * coefficient);
      };

      const startLiveKitLevelFallback = () => {
        const tick = () => {
          if (disposed) {
            return;
          }

          const level = (room.localParticipant as { audioLevel?: number }).audioLevel ?? 0;
          const targetEnergy = Math.max(0, Math.min(1, level * 2.8));
          paintSmoothedVisualizerEnergy(targetEnergy);
          frameId = window.requestAnimationFrame(tick);
        };

        tick();
      };

      const tryAttachVisualizer = () => {
        if (disposed) {
          return;
        }

        const publication = getTrackPublication(room.localParticipant, Track.Source.Microphone);
        const localTrack = publication?.track;
        const mediaStreamTrack = (localTrack as { mediaStreamTrack?: MediaStreamTrack } | undefined)
          ?.mediaStreamTrack;
        const blockReason = !publication
          ? "missing-publication"
          : publication.isMuted
            ? "publication-muted"
            : !mediaStreamTrack
              ? "missing-media-track"
              : mediaStreamTrack.readyState !== "live"
                ? `media-${mediaStreamTrack.readyState}`
                : mediaStreamTrack.muted
                  ? "media-muted"
                  : !mediaStreamTrack.enabled
                    ? "media-disabled"
                    : "";

        if (
          !publication ||
          publication.isMuted ||
          !mediaStreamTrack ||
          mediaStreamTrack.readyState !== "live" ||
          mediaStreamTrack.muted ||
          !mediaStreamTrack.enabled
        ) {
          if (blockReason !== lastAnalyserBlockReason) {
            lastAnalyserBlockReason = blockReason;
            logMuteDebug("voice-ring-visualizer-waiting", { reason: blockReason });
          }
          paintSmoothedVisualizerEnergy(0);
          retryTimeout = window.setTimeout(tryAttachVisualizer, 140);
          return;
        }

        lastAnalyserBlockReason = "";
        logMuteDebug("voice-ring-visualizer-attached");
        try {
          // Visualizer-only clone; it never touches the published mic chain or speaker output.
          stream = new MediaStream([mediaStreamTrack.clone()]);
          audioContext = new AudioContext();
          source = audioContext.createMediaStreamSource(stream);
          analyser = audioContext.createAnalyser();
          analyser.fftSize = VOICE_RING_ANALYSER_FFT_SIZE;
          analyser.smoothingTimeConstant = 0.82;
          source.connect(analyser);
        } catch (error) {
          logMuteDebug("voice-ring-visualizer-fallback", {
            error: error instanceof Error ? error.message : String(error)
          });
          cleanupVisualizer();
          startLiveKitLevelFallback();
          return;
        }

        if (!analyser) {
          cleanupVisualizer();
          startLiveKitLevelFallback();
          return;
        }

        const timeData = new Float32Array(analyser.fftSize);

        const tick = () => {
          if (!analyser) {
            return;
          }

          if (
            disposed ||
            mediaStreamTrack.readyState !== "live" ||
            mediaStreamTrack.muted ||
            !mediaStreamTrack.enabled ||
            publication.isMuted
          ) {
            logMuteDebug("voice-ring-visualizer-detached", {
              mediaReadyState: mediaStreamTrack.readyState,
              mediaMuted: mediaStreamTrack.muted,
              mediaEnabled: mediaStreamTrack.enabled,
              publicationMuted: publication.isMuted
            });
            cleanupVisualizer();
            paintSmoothedVisualizerEnergy(0);
            retryTimeout = window.setTimeout(tryAttachVisualizer, 140);
            return;
          }

          if (typeof document !== "undefined" && document.hidden) {
            paintSmoothedVisualizerEnergy(0);
            sampleTimeout = window.setTimeout(tick, 220);
            return;
          }

          analyser.getFloatTimeDomainData(timeData);

          let sumSquares = 0;
          for (let index = 0; index < timeData.length; index += 1) {
            sumSquares += timeData[index] * timeData[index];
          }

          const rms = Math.sqrt(sumSquares / timeData.length);
          const liftedEnergy = Math.max(0, rms - VOICE_RING_VISUAL_NOISE_FLOOR_RMS);
          const targetEnergy = Math.min(
            1,
            Math.pow(liftedEnergy * VOICE_RING_VISUAL_GAIN, VOICE_RING_VISUAL_CURVE)
          );

          paintSmoothedVisualizerEnergy(targetEnergy);
          frameId = window.requestAnimationFrame(tick);
        };

        void audioContext.resume().catch(() => undefined);
        tick();
      };

      paintVoiceEnergy(0, true);
      tryAttachVisualizer();

      return () => {
        disposed = true;
        if (retryTimeout) {
          window.clearTimeout(retryTimeout);
        }
        cleanupVisualizer();
        if (frameId) {
          window.cancelAnimationFrame(frameId);
        }
        paintVoiceEnergy(0, true);
        if (noiseFloorWarningActiveRef.current) {
          noiseFloorWarningActiveRef.current = false;
          setNoiseFloorDiagnostics({
            warningActive: false,
            rms: null,
            durationMs: null,
            recommendedProfile: null
          });
          audioSettingsStore.patch({ noiseFloorWarning: null });
        }
      };
    }

    if (typeof AudioContext === "undefined") {
      paintVoiceEnergy(0, true);
      return;
    }

    let retryTimeout = 0;
    let sampleTimeout = 0;
    let frameId = 0;
    let audioContext: AudioContext | null = null;
    let stream: MediaStream | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    let disposed = false;
    let lastAnalyserBlockReason = "";
    let whiteNoiseStartedAt: number | null = null;
    let noiseFloorStartedAt: number | null = null;
    let noiseFloorLastRecordedAt = 0;

    const cleanupAnalyser = () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
        frameId = 0;
      }
      if (sampleTimeout) {
        window.clearTimeout(sampleTimeout);
        sampleTimeout = 0;
      }
      source?.disconnect();
      analyser?.disconnect();
      stream?.getTracks().forEach((track) => track.stop());
      source = null;
      analyser = null;
      stream = null;

      if (audioContext) {
        void audioContext.close().catch(() => undefined);
        audioContext = null;
      }
    };

    paintVoiceEnergy(0, true);

    const tryAttachAnalyser = () => {
      if (disposed) {
        return;
      }

      const publication = getTrackPublication(room.localParticipant, Track.Source.Microphone);
      const localTrack = publication?.track;
      const mediaStreamTrack = (localTrack as { mediaStreamTrack?: MediaStreamTrack } | undefined)
        ?.mediaStreamTrack;
      const blockReason = !publication
        ? "missing-publication"
        : publication.isMuted
          ? "publication-muted"
          : !mediaStreamTrack
            ? "missing-media-track"
            : mediaStreamTrack.readyState !== "live"
              ? `media-${mediaStreamTrack.readyState}`
              : mediaStreamTrack.muted
                ? "media-muted"
                : !mediaStreamTrack.enabled
                  ? "media-disabled"
                  : "";

      if (
        !publication ||
        publication.isMuted ||
        !mediaStreamTrack ||
        mediaStreamTrack.readyState !== "live" ||
        mediaStreamTrack.muted ||
        !mediaStreamTrack.enabled
      ) {
        if (blockReason !== lastAnalyserBlockReason) {
          lastAnalyserBlockReason = blockReason;
          logMuteDebug("analyser-waiting", { reason: blockReason });
        }
        paintVoiceEnergy(0, true);
        retryTimeout = window.setTimeout(tryAttachAnalyser, 120);
        return;
      }

      lastAnalyserBlockReason = "";
      logMuteDebug("analyser-attached");
      stream = new MediaStream([mediaStreamTrack.clone()]);
      audioContext = new AudioContext();
      source = audioContext.createMediaStreamSource(stream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.68;
      source.connect(analyser);

      const timeData = new Float32Array(analyser.fftSize);
      const frequencyData = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        if (!analyser) {
          return;
        }

        if (
          disposed ||
          mediaStreamTrack.readyState !== "live" ||
          mediaStreamTrack.muted ||
          !mediaStreamTrack.enabled ||
          publication.isMuted
        ) {
          logMuteDebug("analyser-detached", {
            mediaReadyState: mediaStreamTrack.readyState,
            mediaMuted: mediaStreamTrack.muted,
            mediaEnabled: mediaStreamTrack.enabled,
            publicationMuted: publication.isMuted
          });
          cleanupAnalyser();
          paintVoiceEnergy(0, true);
          retryTimeout = window.setTimeout(tryAttachAnalyser, 120);
          return;
        }

        if (typeof document !== "undefined" && document.hidden) {
          paintVoiceEnergy(0);
          sampleTimeout = window.setTimeout(tick, 260);
          return;
        }

        analyser.getFloatTimeDomainData(timeData);
        analyser.getByteFrequencyData(frequencyData);

        let sumSquares = 0;
        for (let index = 0; index < timeData.length; index += 1) {
          sumSquares += timeData[index] * timeData[index];
        }
        const rms = Math.sqrt(sumSquares / timeData.length);

        let weighted = 0;
        let total = 0;
        let activeBins = 0;
        let highBandTotal = 0;
        for (let index = 0; index < frequencyData.length; index += 1) {
          const value = frequencyData[index] / 255;
          weighted += value * index;
          total += value;
          if (value > 0.2) {
            activeBins += 1;
          }
          if (index > frequencyData.length * 0.38) {
            highBandTotal += value;
          }
        }
        const centroid = total > 0 ? weighted / total / frequencyData.length : 0;
        const averageSpectrum = total / frequencyData.length;
        const activeBinRatio = activeBins / frequencyData.length;
        const highBandRatio = total > 0 ? highBandTotal / total : 0;
        const rawEnergy = Math.min(1, rms * 9.4 + Math.min(1, centroid * 1.08) * 0.5);
        const looksLikeWhiteNoise =
          rms > 0.16 &&
          averageSpectrum > 0.18 &&
          activeBinRatio > 0.42 &&
          centroid > 0.36 &&
          highBandRatio > 0.34;

        if (looksLikeWhiteNoise) {
          const now = Date.now();
          whiteNoiseStartedAt ??= now;

          if (now - whiteNoiseStartedAt > WHITE_NOISE_GUARD_WINDOW_MS) {
            whiteNoiseStartedAt = now;
            void resetLocalMicrophoneForNoiseGuard({
              rms,
              centroid,
              averageSpectrum,
              activeBinRatio,
              highBandRatio,
              mediaLabel: mediaStreamTrack.label
            });
          }
        } else {
          whiteNoiseStartedAt = null;
        }

        const localParticipantSpeaking = Boolean(room.localParticipant.isSpeaking);
        const sustainedNoiseFloor =
          !localParticipantSpeaking &&
          rms > NOISE_FLOOR_WARNING_RMS &&
          !looksLikeWhiteNoise;
        if (sustainedNoiseFloor) {
          const now = Date.now();
          noiseFloorStartedAt ??= now;
          const durationMs = now - noiseFloorStartedAt;

          if (
            durationMs > NOISE_FLOOR_WARNING_WINDOW_MS &&
            now - noiseFloorLastRecordedAt > NOISE_FLOOR_WARNING_COOLDOWN_MS
          ) {
            noiseFloorLastRecordedAt = now;
            const recommendedProfile: SovChatAudioProfile =
              audioProfile === "speaker" ? "speaker" : "noisy-room";
            const warning =
              recommendedProfile === "speaker"
                ? "Persistent mic noise detected. Speaker mode is active; check speaker volume or move the microphone away from speakers."
                : "Persistent background noise detected. Noisy room mode may reduce fan or room noise.";
            setNoiseFloorDiagnostics({
              warningActive: true,
              rms,
              durationMs,
              recommendedProfile
            });
            noiseFloorWarningActiveRef.current = true;
            audioSettingsStore.patch({ noiseFloorWarning: warning });
            recordAudioDiagnosticEvent("noise-floor-warning", {
              profile: audioProfile,
              recommendedProfile,
              rms,
              durationMs,
              centroid,
              averageSpectrum,
              activeBinRatio,
              highBandRatio
            });
          }
        } else {
          noiseFloorStartedAt = null;
          if (noiseFloorWarningActiveRef.current) {
            setNoiseFloorDiagnostics({
              warningActive: false,
              rms: null,
              durationMs: null,
              recommendedProfile: null
            });
            noiseFloorWarningActiveRef.current = false;
            audioSettingsStore.patch({ noiseFloorWarning: null });
          }
        }

        const nextEnergy =
          rawEnergy < 0.12 ? rawEnergy * 0.92 : Math.min(1, Math.pow(rawEnergy, 0.78) * 1.03);
        const smoothingCoefficient = nextEnergy > voiceEnergyRef.current ? 0.34 : 0.16;
        const smoothedEnergy =
          voiceEnergyRef.current + (nextEnergy - voiceEnergyRef.current) * smoothingCoefficient;

        paintVoiceEnergy(smoothedEnergy);
        frameId = window.requestAnimationFrame(tick);
      };

      void audioContext.resume().catch(() => undefined);
      tick();
    };

    tryAttachAnalyser();

    return () => {
      disposed = true;
      if (retryTimeout) {
        window.clearTimeout(retryTimeout);
      }
      cleanupAnalyser();
      paintVoiceEnergy(0, true);
      if (noiseFloorWarningActiveRef.current) {
        noiseFloorWarningActiveRef.current = false;
        setNoiseFloorDiagnostics({
          warningActive: false,
          rms: null,
          durationMs: null,
          recommendedProfile: null
        });
        audioSettingsStore.patch({ noiseFloorWarning: null });
      }
    };
  }, [
    room,
    isMuted,
    status,
    audioProfile,
    noiseFilterEnabled,
    selectedInputId,
    selectedOutputId,
    effectiveKrispSupported,
    inputGain,
    outputMuted,
    outputVolume,
    streamMuted,
    streamVolume,
    thirdPartyMutedIds,
    performanceMode
  ]);

  function attachRemoteAudio(
    track: RemoteAudioTrack,
    participantIdentity: string,
    source: Track.Source
  ) {
    if (
      source === Track.Source.ScreenShareAudio &&
      participantIdentity !== selectedStreamIdentityRef.current
    ) {
      return;
    }

    remoteOutputRouter.attach(track, participantIdentity, source, latestAudioPreferencesRef.current);
  }

  function detachRemoteAudio(track: RemoteAudioTrack) {
    remoteOutputRouter.detachTrack(track);
  }

  function detachRemoteAudioByParticipant(participantIdentity: string, source?: Track.Source) {
    remoteOutputRouter.detachParticipant(participantIdentity, source);
  }

  function reattachSubscribedRemoteAudio(activeRoom: Room) {
    for (const participant of activeRoom.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (publication.track?.kind !== Track.Kind.Audio) {
          continue;
        }

        attachRemoteAudio(
          publication.track as RemoteAudioTrack,
          participant.identity,
          publication.source
        );
      }
    }
  }

  useEffect(() => {
    let active = true;
    let timeout = 0;

    setOnlineNicknames(roomId ? [nickname] : []);
    setOnlineProfiles([]);

    async function loadPresence() {
      const response = await apiFetch("/api/presence", { cache: "no-store" }).catch(() => null);
      if (!response?.ok) {
        return;
      }

      const payload = (await response.json().catch(() => null)) as PresenceResponse | null;
      if (!active || !payload) {
        return;
      }

      mergeKnownAvatarSources(
        payload.profiles.flatMap((profile) =>
          profile.avatarSrc
            ? [
                [profile.userId, profile.avatarSrc] as [string, string],
                [profile.nickname, profile.avatarSrc] as [string, string]
              ]
            : []
        )
      );

      setOnlineProfiles(payload.profiles);
      setOnlineNicknames((previous) => {
        const nicknames = payload.nicknames.includes(nickname)
          ? payload.nicknames
          : [nickname, ...payload.nicknames];
        if (previous.join("|") === nicknames.join("|")) {
          return previous;
        }
        return nicknames;
      });
    }

    const scheduleNextLoad = () => {
      timeout = window.setTimeout(() => {
        if (!active) {
          return;
        }

        void loadPresence().finally(scheduleNextLoad);
      }, typeof document !== "undefined" && document.hidden ? 8000 : 2500);
    };

    void loadPresence().finally(scheduleNextLoad);

    return () => {
      active = false;
      if (timeout) {
        window.clearTimeout(timeout);
      }
    };
  }, [mergeKnownAvatarSources, nickname, roomId]);

  useEffect(() => {
    let active = true;
    let timeout = 0;

    setVoicePresenceParticipants([]);

    async function loadVoicePresence() {
      const response = await apiFetch("/api/voice/participants", { cache: "no-store" }).catch(
        () => null
      );
      if (!response?.ok) {
        return;
      }

      const payload = (await response.json().catch(() => null)) as VoicePresenceResponse | null;
      if (!active || !payload) {
        return;
      }

      setVoicePresenceParticipants((previous) => {
        const next = payload.participants.filter(
          (participant) =>
            participant.participantId !== nickname && participant.displayName !== nickname
        );

        if (
          previous.length === next.length &&
          previous.every((participant, index) => {
            const nextParticipant = next[index];
            return (
              participant?.participantId === nextParticipant?.participantId &&
              participant?.userId === nextParticipant?.userId &&
              participant?.displayName === nextParticipant?.displayName &&
              participant?.isStreaming === nextParticipant?.isStreaming &&
              participant?.isSelfMuted === nextParticipant?.isSelfMuted &&
              participant?.isSelfDeafened === nextParticipant?.isSelfDeafened &&
              participant?.isAfk === nextParticipant?.isAfk
            );
          })
        ) {
          return previous;
        }

        return next;
      });
    }

    const scheduleNextLoad = () => {
      timeout = window.setTimeout(() => {
        if (!active) {
          return;
        }

        void loadVoicePresence().finally(scheduleNextLoad);
      }, typeof document !== "undefined" && document.hidden ? 8000 : 2500);
    };

    void loadVoicePresence().finally(scheduleNextLoad);

    return () => {
      active = false;
      if (timeout) {
        window.clearTimeout(timeout);
      }
    };
  }, [nickname, roomId]);

  useEffect(() => {
    selectedStreamIdentityRef.current = selectedStreamIdentity;
  }, [selectedStreamIdentity]);

  useEffect(() => {
    nativePopoutStreamIdentityRef.current = nativePopoutStreamIdentity;
  }, [nativePopoutStreamIdentity]);

  useEffect(() => {
    const desktopBridge = getDesktopBridge();
    if (!desktopBridge?.subscribeStreamPopoutCommand) {
      return;
    }

    return desktopBridge.subscribeStreamPopoutCommand((command) => {
      if (command === "toggle-input-muted") {
        const currentAudioState = audioSettingsStore.getState();
        audioSettingsStore.getController().setInputMuted(!currentAudioState.inputMuted);
        return;
      }

      if (command === "toggle-output-muted") {
        const currentAudioState = audioSettingsStore.getState();
        audioSettingsStore.getController().setOutputMuted(!currentAudioState.outputMuted);
        return;
      }

      if (typeof command === "object" && command?.type === "set-stream-muted") {
        const nextMuted = Boolean(command.value);
        setStreamMuted(nextMuted);
        audioSettingsStore.patch({ streamMuted: nextMuted });
        applyRemoteAudioPreferences(
          selectedOutputId,
          outputMuted,
          outputVolume,
          nextMuted,
          streamVolume,
          thirdPartyMutedIds,
          participantVolumes,
          participantVolumeKeys
        );
        return;
      }

      if (typeof command === "object" && command?.type === "set-stream-volume") {
        const nextVolume = getClampedGainVolume(command.value, MAX_STREAM_VOLUME_PERCENT);
        setStreamVolume(nextVolume);
        audioSettingsStore.patch({ streamVolume: nextVolume });
        applyRemoteAudioPreferences(
          selectedOutputId,
          outputMuted,
          outputVolume,
          streamMuted,
          nextVolume,
          thirdPartyMutedIds,
          participantVolumes,
          participantVolumeKeys
        );
        return;
      }

      if (command === "leave-room") {
        suppressNextPopoutRestoreRef.current = true;
        void leaveRoom();
        void desktopBridge.closeStreamPopout?.();
        return;
      }

      if (command === "stop-watching") {
        suppressNextPopoutRestoreRef.current = true;
        setSelectedStreamIdentity(null);
        setNativePopoutStreamIdentity(null);
        setIsStreamPoppedOut(false);
        void desktopBridge.closeStreamPopout?.();
        return;
      }

      if (command === "pop-back-in") {
        void popStreamBackIn();
      }
    });
  }, [
    outputMuted,
    outputVolume,
    participantVolumeKeys,
    participantVolumes,
    room,
    selectedOutputId,
    streamMuted,
    streamVolume,
    thirdPartyMutedIds
  ]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!event.ctrlKey || !event.shiftKey || event.key.toLowerCase() !== "s") {
        return;
      }

      event.preventDefault();
      setShowStreamStats((previous) => !previous);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    previousLocalStreamStatsRef.current = null;
    previousRemoteStreamStatsRef.current = null;
    autoStreamTierRef.current = "high";
  }, [streamQualityMode]);

  useEffect(() => {
    const session = screenShareSessionRef.current;
    const localVideoTrack = session?.videoTrack ?? null;
    const remoteReceiver = (selectedRemoteScreenTrack as { receiver?: RTCRtpReceiver } | null)
      ?.receiver;

    if (!localVideoTrack && !remoteReceiver) {
      setStreamStats(null);
      previousLocalStreamStatsRef.current = null;
      previousRemoteStreamStatsRef.current = null;
      return;
    }

    let disposed = false;

    const collectStats = async () => {
      if (disposed) {
        return;
      }

      const activeSession = screenShareSessionRef.current;
      const activeLocalTrack = activeSession?.videoTrack ?? null;
      const activeRemoteReceiver = (selectedRemoteScreenTrack as { receiver?: RTCRtpReceiver } | null)
        ?.receiver;

      if (activeLocalTrack?.sender?.getStats) {
        const report = await activeLocalTrack.sender.getStats().catch(() => null);
        if (report && !disposed) {
          const result = buildOutboundStreamStats(
            report,
            activeSession?.mode ?? streamQualityMode,
            previousLocalStreamStatsRef.current
          );

          if (result) {
            previousLocalStreamStatsRef.current = result.sample;
            const snapshot = {
              ...result.snapshot,
              renderFps: selectedStreamIsLocal ? remoteVideoRenderFpsRef.current : null
            } satisfies StreamStatsSnapshot;
            recordStreamStats(snapshot);
            void applyAutoStreamTuning(activeLocalTrack, result.snapshot);

            if (!selectedRemoteScreenTrack || selectedStreamIsLocal) {
              setStreamStats(snapshot);
            }
          }
        }
      }

      if (activeRemoteReceiver?.getStats) {
        const report = await activeRemoteReceiver.getStats().catch(() => null);
        if (report && !disposed) {
          const result = buildInboundStreamStats(
            report,
            streamQualityMode,
            previousRemoteStreamStatsRef.current
          );

          if (result) {
            previousRemoteStreamStatsRef.current = result.sample;
            const snapshot = {
              ...result.snapshot,
              renderFps: remoteVideoRenderFpsRef.current
            } satisfies StreamStatsSnapshot;
            recordStreamStats(snapshot);
            setStreamStats(snapshot);
          }
        }
      }
    };

    void collectStats();
    const interval = window.setInterval(() => void collectStats(), STREAM_STATS_INTERVAL_MS);

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [selectedRemoteScreenTrack, selectedStreamIsLocal, streamQualityMode, isSharing, showStreamStats]);

  useEffect(() => {
    if (!room || !isVoiceConnectedStatus(status)) {
      return;
    }

    let interval = 0;

    const refreshLiveLevels = () => {
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }

      refreshParticipants(room);
    };

    interval = window.setInterval(refreshLiveLevels, PARTICIPANT_REFRESH_INTERVAL_MS);

    return () => {
      if (interval) {
        window.clearInterval(interval);
      }
    };
  }, [room, status]);

  useEffect(() => {
    if (!room) {
      return;
    }

    syncRemoteTrackSubscriptions(room, selectedStreamIdentity, nativePopoutStreamIdentity);
  }, [fullscreenTarget, nativePopoutStreamIdentity, room, selectedStreamIdentity]);

  useEffect(() => {
    if (!isVoiceConnectedStatus(status)) {
      return;
    }

    if (!roomId) {
      void leaveRoom();
      return;
    }

    if (!room) {
      return;
    }

    if (connectedRoomIdRef.current === null) {
      connectedRoomIdRef.current = roomId;
      return;
    }

    if (connectedRoomIdRef.current === roomId) {
      return;
    }

    void leaveRoom();
  }, [leaveRoom, room, roomId, status]);

  function armAudioPlaybackResume(nextRoom: Room, message: string) {
    playbackResumeCleanupRef.current?.();

    const cleanup = () => {
      document.removeEventListener("pointerdown", retryPlayback, true);
      document.removeEventListener("keydown", retryPlayback, true);
      if (playbackResumeCleanupRef.current === cleanup) {
        playbackResumeCleanupRef.current = null;
      }
    };
    const retryPlayback = () => {
      cleanup();
      if (!isActiveRoomInstance(nextRoom)) {
        return;
      }

      void runTimedAudioOperation(
        nextRoom.startAudio(),
        JOIN_AUDIO_START_TIMEOUT_MS,
        "voice-playback-resume-timeout"
      ).then((result) => {
        if (!isActiveRoomInstance(nextRoom)) {
          return;
        }

        if (result.status === "ok" && nextRoom.canPlaybackAudio) {
          recordAudioDiagnosticEvent("voice-playback-resumed");
          setError((current) => (current === message ? null : current));
          setLastAudioError((current) => (current === message ? null : current));
          return;
        }

        recordAudioDiagnosticEvent("voice-playback-resume-deferred", {
          status: result.status,
          error:
            result.status === "error" ? getAudioErrorMessage(result.error) : null
        });
        armAudioPlaybackResume(nextRoom, message);
      });
    };

    document.addEventListener("pointerdown", retryPlayback, { capture: true, once: true });
    document.addEventListener("keydown", retryPlayback, { capture: true, once: true });
    playbackResumeCleanupRef.current = cleanup;
  }

  async function keepRoomConnectedWithoutMicrophone(
    nextRoom: Room,
    attemptId: number,
    caughtError: unknown,
    reason: string
  ): Promise<{ degraded: true }> {
    if (!isActiveRoomInstance(nextRoom)) {
      throw new JoinCancelledError();
    }

    const participant = nextRoom.localParticipant;
    const publication = getLocalMicrophonePublication(participant);
    const publishedTrack = publication?.audioTrack ?? null;
    const pendingTrack = pendingJoinMicrophoneTrackRef.current;
    pendingJoinMicrophoneTrackRef.current = null;

    if (publishedTrack) {
      await stopLocalAudioProcessing(publishedTrack, "voice-join-microphone-degraded").catch(
        () => undefined
      );
      await participant.unpublishTrack(publishedTrack, true).catch(() => undefined);
    }
    if (pendingTrack && pendingTrack !== publishedTrack) {
      await stopLocalAudioProcessing(pendingTrack, "voice-join-microphone-degraded").catch(
        () => undefined
      );
      stopUnpublishedLocalAudioTrack(pendingTrack);
    }
    await participant.setMicrophoneEnabled(false).catch(() => undefined);

    const failureKind = classifyVoiceJoinMicrophoneFailure(caughtError);
    const message = getVoiceJoinMicrophoneFailureMessage(caughtError, isLinuxAudioRuntime());
    microphoneJoinDegradedRef.current = true;
    desiredInputMutedRef.current = true;
    audioSettingsStore.patch({ inputMuted: true });
    setIsMuted(true);
    syncLocalSelfContext(true, desiredOutputMutedRef.current);
    setLastAudioError(message);
    setLastDeviceSwitchResult(`join:microphone-${failureKind}`);
    setError(message);
    applyRemoteAudioPreferences(
      selectedOutputId,
      outputMuted,
      outputVolume,
      streamMuted,
      streamVolume,
      thirdPartyMutedIds
    );
    refreshParticipants(nextRoom);
    recordAudioDiagnosticEvent("voice-join-microphone-degraded", {
      attemptId,
      reason,
      status: failureKind,
      errorName: getAudioErrorName(caughtError) || null,
      error: getAudioErrorMessage(caughtError),
      isLinux: isLinuxAudioRuntime()
    });

    return { degraded: true };
  }

  function createManagedRoom() {
    const publishPlan = microphonePublishPlan;
    const publishOptions = publishPlan.options;

    logMuteDebug("microphone-publish-plan-selected", {
      ...publishPlan.diagnostics,
      voiceGateExperiment
    });

    const nextRoom = new Room({
      adaptiveStream: false,
      dynacast: true,
      publishDefaults: {
        audioPreset: publishOptions.audioPreset,
        dtx: publishOptions.dtx,
        red: publishOptions.red,
        forceStereo: publishOptions.forceStereo
      }
    });

    const guard = (callback: () => void) => {
      if (!isActiveRoomInstance(nextRoom)) {
        return;
      }

      callback();
    };

    nextRoom.on(RoomEvent.Connected, () => {
      guard(() => {
        recordAudioDiagnosticEvent("livekit-room-connected", {
          state: nextRoom.state
        });
      });
    });
    nextRoom.on(RoomEvent.ConnectionStateChanged, (state) => {
      guard(() => {
        recordAudioDiagnosticEvent("livekit-connection-state-changed", {
          state
        });
      });
    });
    nextRoom.on(RoomEvent.Reconnecting, () => {
      guard(() => {
        recordAudioDiagnosticEvent("livekit-room-reconnecting", {
          state: nextRoom.state
        });
      });
    });
    nextRoom.on(RoomEvent.Reconnected, () => {
      guard(() => {
        recordAudioDiagnosticEvent("livekit-room-reconnected", {
          state: nextRoom.state
        });
        refreshParticipants(nextRoom);
      });
    });
    nextRoom.on(RoomEvent.MediaDevicesError, (error) => {
      guard(() => {
        const message = getAudioErrorMessage(error);
        setLastAudioError(message);
        recordAudioDiagnosticEvent("livekit-media-devices-error", {
          errorName: getAudioErrorName(error) || null,
          error: message
        });
      });
    });
    nextRoom.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      guard(() => {
        if (nextRoom.canPlaybackAudio) {
          const playbackMessage = getVoiceJoinPlaybackFailureMessage();
          playbackResumeCleanupRef.current?.();
          setError((current) => (current === playbackMessage ? null : current));
          setLastAudioError((current) =>
            current === playbackMessage ? null : current
          );
        }
        recordAudioDiagnosticEvent("livekit-audio-playback-status-changed", {
          canPlaybackAudio: nextRoom.canPlaybackAudio
        });
      });
    });
    nextRoom.on(RoomEvent.Disconnected, (reason) => {
      recordAudioDiagnosticEvent("livekit-room-disconnected", {
        reason: reason ?? null
      });
      guard(() => resetRoomState());
    });
    nextRoom.on(RoomEvent.ParticipantConnected, () => {
      guard(() => {
        void playUiCue("join");
        syncRemoteTrackSubscriptions(
          nextRoom,
          selectedStreamIdentityRef.current,
          nativePopoutStreamIdentityRef.current
        );
        refreshParticipants(nextRoom);
      });
    });
    nextRoom.on(RoomEvent.ParticipantDisconnected, (participant) => {
      guard(() => {
        void playUiCue("leave");
        detachRemoteAudioByParticipant(participant.identity);
        refreshParticipants(nextRoom);
      });
    });
    nextRoom.on(RoomEvent.ActiveSpeakersChanged, () => {
      guard(() => refreshParticipants(nextRoom));
    });
    nextRoom.on(RoomEvent.ParticipantMetadataChanged, () => {
      guard(() => refreshParticipants(nextRoom));
    });
    nextRoom.on(RoomEvent.TrackMuted, (publication, participant) => {
      guard(() => {
        if (participant?.identity === nextRoom.localParticipant.identity) {
          logMuteDebug("livekit-track-muted", {
            source: publication.source,
            publicationMuted: publication.isMuted
          });
          if (publication.source === Track.Source.ScreenShare && screenShareSessionRef.current) {
            setError("Your stream was stopped because another user went live.");
            void stopLocalScreenShare(nextRoom, false).finally(() => refreshParticipants(nextRoom));
          }
        }
        refreshParticipants(nextRoom);
      });
    });
    nextRoom.on(RoomEvent.TrackUnmuted, (publication, participant) => {
      guard(() => {
        if (participant?.identity === nextRoom.localParticipant.identity) {
          logMuteDebug("livekit-track-unmuted", {
            source: publication.source,
            publicationMuted: publication.isMuted
          });
        }
        refreshParticipants(nextRoom);
      });
    });
    nextRoom.on(RoomEvent.LocalTrackPublished, (publication) => {
      guard(() => {
        logMuteDebug("livekit-local-track-published", {
          source: publication.source,
          publicationMuted: publication.isMuted
        });
        refreshParticipants(nextRoom);
      });
    });
    nextRoom.on(RoomEvent.LocalTrackUnpublished, (publication) => {
      guard(() => {
        logMuteDebug("livekit-local-track-unpublished", {
          source: publication.source,
          publicationMuted: publication.isMuted
        });
        refreshParticipants(nextRoom);
      });
    });
    nextRoom.on(RoomEvent.TrackPublished, (publication) => {
      guard(() => {
        if (publication.source === Track.Source.ScreenShare) {
          void playUiCue("stream-start");
          if (screenShareSessionRef.current) {
            void stopLocalScreenShare(nextRoom).finally(() => refreshParticipants(nextRoom));
          }
        }
        syncRemoteTrackSubscriptions(
          nextRoom,
          selectedStreamIdentityRef.current,
          nativePopoutStreamIdentityRef.current
        );
        refreshParticipants(nextRoom);
      });
    });
    nextRoom.on(RoomEvent.TrackUnpublished, (publication) => {
      guard(() => {
        if (publication.source === Track.Source.ScreenShare) {
          void playUiCue("stream-stop");
        }
        syncRemoteTrackSubscriptions(
          nextRoom,
          selectedStreamIdentityRef.current,
          nativePopoutStreamIdentityRef.current
        );
        refreshParticipants(nextRoom);
      });
    });
    nextRoom.on(
      RoomEvent.TrackSubscribed,
      (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
        guard(() => {
          if (track.kind === Track.Kind.Audio) {
            attachRemoteAudio(track as RemoteAudioTrack, participant.identity, publication.source);
          }
          refreshParticipants(nextRoom);
        });
      }
    );
    nextRoom.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      guard(() => {
        if (track.kind === Track.Kind.Audio) {
          detachRemoteAudio(track as RemoteAudioTrack);
        }
        refreshParticipants(nextRoom);
      });
    });

    return nextRoom;
  }

  async function completeAudioSetupAfterJoin(
    nextRoom: Room,
    attemptId: number,
    options: {
      selectedInputId: string;
      selectedOutputId: string;
      isMuted: boolean;
      noiseFilterEnabled: boolean;
      inputGain: number;
      outputMuted: boolean;
      outputVolume: number;
      streamMuted: boolean;
      streamVolume: number;
      thirdPartyMutedIds: Set<string>;
      microphonePublishOptions: TrackPublishOptions;
      playbackPromise: Promise<TimedAudioOperationResult<void>>;
      preparedMicrophonePromise: Promise<PreparedJoinMicrophone> | null;
    }
  ): Promise<{ degraded: boolean }> {
    if (!isActiveJoinAttempt(attemptId) || !isActiveRoomInstance(nextRoom)) {
      throw new JoinCancelledError();
    }

    let degraded = false;
    const playbackResult = await options.playbackPromise;
    if (playbackResult.status !== "ok" || !nextRoom.canPlaybackAudio) {
      degraded = true;
      const message = getVoiceJoinPlaybackFailureMessage();
      setLastAudioError(message);
      setError(message);
      recordAudioDiagnosticEvent("voice-join-playback-degraded", {
        attemptId,
        status: playbackResult.status,
        canPlaybackAudio: nextRoom.canPlaybackAudio,
        error:
          playbackResult.status === "error"
            ? getAudioErrorMessage(playbackResult.error)
            : null
      });
      armAudioPlaybackResume(nextRoom, message);
    }

    if (!isActiveJoinAttempt(attemptId) || !isActiveRoomInstance(nextRoom)) {
      throw new JoinCancelledError();
    }

    if (options.isMuted) {
      try {
        await syncAudioDevices(
          nextRoom,
          options.selectedInputId,
          options.selectedOutputId,
          options.isMuted,
          options.noiseFilterEnabled,
          options.inputGain,
          options.outputMuted,
          options.outputVolume,
          options.streamMuted,
          options.streamVolume,
          options.thirdPartyMutedIds,
          options.microphonePublishOptions
        );
      } catch (caughtError) {
        if (!isActiveJoinAttempt(attemptId) || !isActiveRoomInstance(nextRoom)) {
          throw new JoinCancelledError();
        }

        degraded = true;
        const message =
          "You joined voice, but audio devices could not be fully prepared. Check Audio settings and retry the affected control.";
        setLastAudioError(message);
        setError(message);
        recordAudioDiagnosticEvent("voice-join-muted-audio-degraded", {
          attemptId,
          status: "error",
          error: getAudioErrorMessage(caughtError)
        });
      }
      recordAudioDiagnosticEvent("voice-join-audio-ready", {
        attemptId,
        muted: true,
        degraded
      });
      refreshParticipants(nextRoom);
      return { degraded };
    }

    if (!options.preparedMicrophonePromise) {
      return await keepRoomConnectedWithoutMicrophone(
        nextRoom,
        attemptId,
        new Error("Microphone preparation did not start."),
        "preparation-missing"
      );
    }

    let localTrack: LocalAudioTrack | null = null;
    try {
      const prepared = await options.preparedMicrophonePromise;
      localTrack = prepared.localTrack;
      if (!isActiveJoinAttempt(attemptId) || !isActiveRoomInstance(nextRoom)) {
        stopUnpublishedLocalAudioTrack(localTrack);
        throw new JoinCancelledError();
      }

      attachParticipantAudioContextToTrack(
        nextRoom.localParticipant,
        localTrack,
        "voice-join-prepared-microphone",
        `join-${attemptId}`
      );

      if (options.noiseFilterEnabled) {
        const processingStartedAt = getPerformanceNow();
        await syncLocalAudioProcessing(
          localTrack,
          true,
          !krispFailedRef.current,
          options.inputGain,
          voiceGateExperimentRef.current,
          "voice-join-prepared-microphone",
          nextRoom
        );
        const activeProcessor = getKrispProcessorForTrack(localTrack);
        const processingDegraded =
          krispFailedRef.current ||
          !activeProcessor ||
          readKrispProcessorEnabled(activeProcessor) === false;
        degraded ||= processingDegraded;
        recordPerformanceTiming("voice.join.optional-processing", processingStartedAt, {
          attemptId,
          status: processingDegraded ? "degraded" : "success"
        });

        if (processingDegraded) {
          await stopLocalAudioProcessing(localTrack, "voice-join-krisp-fallback").catch(
            () => undefined
          );
          await applyNativeVoiceCleanupConstraints(localTrack, "voice-join-krisp-fallback");
          setKrispPrewarmState("degraded");
        }
      } else {
        await applyNativeVoiceCleanupConstraints(localTrack, "voice-join-native-processing");
      }

      if (!isActiveJoinAttempt(attemptId) || !isActiveRoomInstance(nextRoom)) {
        stopUnpublishedLocalAudioTrack(localTrack);
        throw new JoinCancelledError();
      }

      const publishStartedAt = getPerformanceNow();
      const publication = await publishPreparedMicrophoneTrack(
        nextRoom.localParticipant,
        localTrack,
        options.microphonePublishOptions,
        `join-${attemptId}`
      );
      if (!publication) {
        throw new Error("SovChat could not publish the prepared microphone track.");
      }
      if (!isActiveJoinAttempt(attemptId) || !isActiveRoomInstance(nextRoom)) {
        await nextRoom.localParticipant.unpublishTrack(localTrack, true).catch(() => undefined);
        await stopLocalAudioProcessing(localTrack, "stale-voice-join-publish").catch(
          () => undefined
        );
        stopUnpublishedLocalAudioTrack(localTrack);
        if (pendingJoinMicrophoneTrackRef.current === localTrack) {
          pendingJoinMicrophoneTrackRef.current = null;
        }
        throw new JoinCancelledError();
      }
      pendingJoinMicrophoneTrackRef.current = null;
      await ensureLocalMicrophoneUnmuted(nextRoom.localParticipant, publication);

      const publishedTrack = publication.audioTrack ?? getMicrophoneTrack(nextRoom.localParticipant);
      const publishedMediaTrack = getTrackMediaStreamTrack(publishedTrack);
      if (
        publication.isMuted ||
        publication.isUpstreamPaused ||
        !publishedMediaTrack ||
        publishedMediaTrack.readyState !== "live" ||
        !publishedMediaTrack.enabled
      ) {
        throw new Error("Microphone publication did not become live.");
      }
      recordPerformanceTiming("voice.join.microphone-publish", publishStartedAt, {
        attemptId,
        status: "success",
        degraded
      });

      const normalizedOutputId = getConcreteDeviceId(options.selectedOutputId) || null;
      if (outputSupported && normalizedOutputId) {
        await nextRoom.switchActiveDevice("audiooutput", normalizedOutputId).catch((caughtError) => {
          recordAudioDiagnosticEvent("voice-join-output-device-failed", {
            attemptId,
            error: getAudioErrorMessage(caughtError)
          });
        });
        activeOutputDeviceIdRef.current = normalizedOutputId;
      }
      activeInputDeviceIdRef.current = prepared.usedDefaultInputFallback
        ? null
        : getConcreteDeviceId(options.selectedInputId) || null;
      applyRemoteAudioPreferences(
        options.selectedOutputId,
        options.outputMuted,
        options.outputVolume,
        options.streamMuted,
        options.streamVolume,
        options.thirdPartyMutedIds
      );
      microphoneJoinDegradedRef.current = false;
      if (!degraded) {
        setLastAudioError(null);
      }
      refreshParticipants(nextRoom);
      recordAudioDiagnosticEvent("voice-join-audio-ready", {
        attemptId,
        muted: false,
        degraded
      });
      return { degraded };
    } catch (caughtError) {
      if (
        isJoinCancelledError(caughtError) ||
        !isActiveJoinAttempt(attemptId) ||
        !isActiveRoomInstance(nextRoom)
      ) {
        if (localTrack && pendingJoinMicrophoneTrackRef.current === localTrack) {
          stopUnpublishedLocalAudioTrack(localTrack);
          pendingJoinMicrophoneTrackRef.current = null;
        }
        throw new JoinCancelledError();
      }

      return await keepRoomConnectedWithoutMicrophone(
        nextRoom,
        attemptId,
        caughtError,
        "microphone-setup"
      );
    }
  }

  async function connectToResolvedRoom(options: {
    previousRoom?: Room | null;
    nextRoomId?: string | null;
    playJoinCue?: boolean;
    attemptId: number;
    nextRoom: Room;
    playbackPromise: Promise<TimedAudioOperationResult<void>>;
    preparedMicrophonePromise: Promise<PreparedJoinMicrophone> | null;
    signal: AbortSignal;
    abort: () => void;
  }) {
    const previousRoom = options?.previousRoom ?? null;
    const nextRoomId = options?.nextRoomId ?? roomId ?? null;
    const attemptId = options.attemptId;

    const nextRoom = options.nextRoom;
    const payload = await getLiveKitVoiceTokenForJoin(
      attemptId,
      nextRoomId,
      options.signal,
      options.abort
    );
    if (!isActiveJoinAttempt(attemptId)) {
      throw new JoinCancelledError();
    }

    const serverUrl = resolveLiveKitServerUrl(payload.serverUrl, fallbackLiveKitUrl);
    const endpoint = getLiveKitEndpointDetails(serverUrl);
    preconnectToUrl(serverUrl, "livekit");
    recordAudioDiagnosticEvent("livekit-connect-start", {
      attemptId,
      endpoint
    });

    await runTimedJoinOperation(
      nextRoom.connect(serverUrl, payload.token, {
        autoSubscribe: false
      }),
      "connect",
      JOIN_ROOM_CONNECT_TIMEOUT_MS,
      { attemptId, roomName: payload.roomName ?? null, endpoint },
      () => nextRoom.disconnect()
    );
    if (!isActiveJoinAttempt(attemptId)) {
      nextRoom.disconnect();
      throw new JoinCancelledError();
    }
    syncRemoteTrackSubscriptions(
      nextRoom,
      selectedStreamIdentityRef.current,
      nativePopoutStreamIdentityRef.current
    );
    refreshParticipants(nextRoom);
    setRoom(nextRoom);
    connectedRoomIdRef.current = nextRoomId;
    setStatus("preparing-audio");

    if (previousRoom && previousRoom !== nextRoom) {
      if (screenShareSessionRef.current) {
        await stopLocalScreenShare(previousRoom, false).catch(() => undefined);
      }

      detachAllRemoteAudio();

      window.setTimeout(() => {
        previousRoom.disconnect();
      }, 0);
    }

    const audioSetupPromise = completeAudioSetupAfterJoin(nextRoom, attemptId, {
      selectedInputId,
      selectedOutputId,
      isMuted,
      noiseFilterEnabled,
      inputGain,
      outputMuted,
      outputVolume,
      streamMuted,
      streamVolume,
      thirdPartyMutedIds,
      microphonePublishOptions,
      playbackPromise: options.playbackPromise,
      preparedMicrophonePromise: options.preparedMicrophonePromise
    });
    void audioSetupPromise.catch(() => undefined);
    const audioSetupResult = await runTimedAudioOperation(
      audioSetupPromise,
      JOIN_AUDIO_READY_TIMEOUT_MS,
      "voice-join-audio-ready-timeout",
      { attemptId, audioDeviceSyncTimeoutMs: AUDIO_DEVICE_SYNC_TIMEOUT_MS },
    );

    if (!isActiveRoomInstance(nextRoom)) {
      throw new JoinCancelledError();
    }

    let audioDegraded = false;
    if (audioSetupResult.status === "ok") {
      audioDegraded = audioSetupResult.value.degraded;
    } else {
      if (isActiveJoinAttempt(attemptId)) {
        joinAttemptRef.current += 1;
      }
      audioDeviceSyncRequestRef.current += 1;
      beginKrispProcessingRequest();
      if (pendingJoinMicrophoneTrackRef.current) {
        stopUnpublishedLocalAudioTrack(pendingJoinMicrophoneTrackRef.current);
        pendingJoinMicrophoneTrackRef.current = null;
      }

      const audioSetupError =
        audioSetupResult.status === "timeout"
          ? new Error(`Voice audio setup timed out after ${JOIN_AUDIO_READY_TIMEOUT_MS}ms.`)
          : audioSetupResult.error;
      await keepRoomConnectedWithoutMicrophone(
        nextRoom,
        attemptId,
        audioSetupError,
        audioSetupResult.status === "timeout" ? "audio-ready-timeout" : "audio-ready-error"
      );
      audioDegraded = true;
    }

    setStatus(audioDegraded ? "degraded" : "connected");
    if (options?.playJoinCue) {
      void playUiCue("join");
    }

    return nextRoom;
  }

  async function joinRoom() {
    const attemptId = joinAttemptRef.current + 1;
    joinAttemptRef.current = attemptId;
    const timingStartedAt = getPerformanceNow();
    setStatus("connecting");
    setError(null);
    setLastAudioError(null);

    const nextRoom = createManagedRoom();
    activeRoomRef.current = nextRoom;
    const joinAbortController = new AbortController();
    joinAbortControllerRef.current?.abort();
    joinAbortControllerRef.current = joinAbortController;
    void recordVoiceJoinEnvironment(attemptId);
    const playbackPromise = runTimedAudioOperation(
      nextRoom.startAudio(),
      JOIN_AUDIO_START_TIMEOUT_MS,
      "voice-join-audio-playback-timeout",
      { attemptId }
    );
    const preparedMicrophonePromise = isMuted
      ? null
      : prepareMicrophoneForJoin(
          attemptId,
          selectedInputId,
          audioSettingsStore.getState().audioProfile
        );
    void preparedMicrophonePromise?.catch(() => undefined);

    try {
      await connectToResolvedRoom({
        nextRoomId: roomId ?? null,
        playJoinCue: true,
        attemptId,
        nextRoom,
        playbackPromise,
        preparedMicrophonePromise,
        signal: joinAbortController.signal,
        abort: () => joinAbortController.abort()
      });
      recordPerformanceTiming("voice.join", timingStartedAt, { attemptId, status: "success" });
    } catch (caughtError) {
      const wasExplicitlyCancelled = shouldTreatJoinFailureAsCancelled({
        explicitCancellation: isJoinCancelledError(caughtError),
        stageTimeout: caughtError instanceof JoinStageTimeoutError,
        signalAborted: joinAbortController.signal.aborted,
        attemptActive: isActiveJoinAttempt(attemptId),
        roomActive: isActiveRoomInstance(nextRoom)
      });

      if (wasExplicitlyCancelled) {
        recordPerformanceTiming("voice.join", timingStartedAt, { attemptId, status: "cancelled" });
        return;
      }
      recordPerformanceTiming("voice.join", timingStartedAt, { attemptId, status: "error" });
      recordAudioDiagnosticEvent("voice-join-failed", {
        attemptId,
        ...getLiveKitErrorDetails(caughtError)
      });
      nextRoom.disconnect();
      resetRoomState("error");
      setError(getLiveKitErrorMessage(caughtError, "Unable to join voice right now."));
    } finally {
      if (joinAbortControllerRef.current === joinAbortController) {
        joinAbortControllerRef.current = null;
      }
    }
  }

  function cancelJoin() {
    const pendingRoom = activeRoomRef.current;
    joinAttemptRef.current += 1;
    audioDeviceSyncRequestRef.current += 1;
    setError(null);
    recordAudioDiagnosticEvent("voice-join-cancelled");
    resetRoomState();
    pendingRoom?.disconnect();
  }

  async function leaveRoom() {
    if (!room) {
      return;
    }

    const activeRoom = room;
    void playUiCue("leave");
    const currentTrack = getMicrophoneTrack(activeRoom.localParticipant);
    await stopLocalAudioProcessing(currentTrack, "leave-room");
    await activeRoom.localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
    if (currentTrack) {
      await activeRoom.localParticipant.unpublishTrack(currentTrack, true).catch(() => undefined);
      getTrackMediaStreamTrack(currentTrack)?.stop();
    }
    resetRoomState();
    window.setTimeout(() => {
      activeRoom.disconnect();
    }, 0);
  }

  function getStreamOwnerLabel(identity: string) {
    return (
      mergedParticipants.find((participant) => participant.participantId === identity)
        ?.displayName ?? identity
    );
  }

  async function stopRemoteStreamForTakeover(identity: string) {
    const response = await apiFetch("/api/voice/stream-takeover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetIdentity: identity })
    });
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;

    if (!response.ok) {
      throw new Error(payload?.error ?? "Unable to stop the active stream.");
    }
  }

  function clearDesktopScreenShareSelection() {
    screenShareSourceRequestRef.current += 1;
    const clearRequest = desktopBridge?.clearScreenShareSourceSelection?.();
    void clearRequest?.catch(() => undefined);
  }

  async function beginScreenShareStart(takeoverIdentity: string | null = null) {
    if (!room) {
      return;
    }

    if (isDesktopShell && desktopBridge) {
      const sourceRequestId = ++screenShareSourceRequestRef.current;
      streamTakeoverOverrideIdentityRef.current = takeoverIdentity;
      setError(null);
      setScreenShareSources([]);
      setScreenShareSourcesLoading(true);
      setIsScreenSharePickerOpen(true);

      try {
        const sources = await desktopBridge.listDisplayMediaSources();
        if (sourceRequestId !== screenShareSourceRequestRef.current) {
          return;
        }
        setScreenShareSources(sources);
      } catch (caughtError) {
        if (sourceRequestId !== screenShareSourceRequestRef.current) {
          return;
        }
        streamTakeoverOverrideIdentityRef.current = null;
        setIsScreenSharePickerOpen(false);
        setError(
          caughtError instanceof Error
            ? caughtError.message
            : "Unable to list available screens and windows."
        );
      } finally {
        if (sourceRequestId === screenShareSourceRequestRef.current) {
          setScreenShareSourcesLoading(false);
        }
      }

      return;
    }

    try {
      await startLocalScreenShare(
        room,
        screenShareSystemAudioSupported && screenShareIncludeSystemAudio,
        streamQualityMode,
        { takeoverIdentity }
      );
      refreshParticipants(room);
    } catch (caughtError) {
      if (
        caughtError instanceof Error &&
        (caughtError.name === "NotAllowedError" || caughtError.name === "AbortError")
      ) {
        return;
      }

      setError(caughtError instanceof Error ? caughtError.message : "Unable to start screen sharing.");
    }
  }

  function requestStreamTakeover(identity: string) {
    setStreamTakeoverPrompt({
      identity,
      label: getStreamOwnerLabel(identity)
    });
  }

  async function confirmStreamTakeover() {
    if (!room || !streamTakeoverPrompt) {
      setStreamTakeoverPrompt(null);
      return;
    }

    const takeoverIdentity = streamTakeoverPrompt.identity;
    setStreamTakeoverBusy(true);
    setError(null);

    try {
      await stopRemoteStreamForTakeover(takeoverIdentity);
      setStreamTakeoverPrompt(null);
      await beginScreenShareStart(takeoverIdentity);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to stop the active stream.");
    } finally {
      setStreamTakeoverBusy(false);
    }
  }

  function cancelStreamTakeover() {
    if (streamTakeoverBusy) {
      return;
    }

    setStreamTakeoverPrompt(null);
  }

  async function toggleScreenShare() {
    if (!room) {
      return;
    }

    if (isSharing) {
      setIsScreenSharePickerOpen(false);
      await stopLocalScreenShare(room).catch(() => undefined);
      refreshParticipants(room);
      return;
    }

    const activeRemoteStreamIdentity = getActiveRemoteStreamIdentity(room);
    if (activeRemoteStreamIdentity) {
      requestStreamTakeover(activeRemoteStreamIdentity);
      return;
    }

    await beginScreenShareStart();
  }

  async function shareDesktopSource(source: DesktopDisplayMediaSource) {
    if (!room || !desktopBridge) {
      return;
    }

    const includeSystemAudio = screenShareSystemAudioSupported && screenShareIncludeSystemAudio;
    setError(null);
    setScreenShareSourcesLoading(true);

    try {
      const remainingSeconds = await getScreenShareRemainingSeconds();
      if (remainingSeconds <= 0) {
        throw new Error("Daily streaming limit reached. You can stream again tomorrow.");
      }

      const prepared = await desktopBridge.prepareScreenShareSource({
        id: source.id,
        kind: source.kind,
        includeSystemAudio
      });

      if (!prepared) {
        throw new Error("The selected source could not be prepared for screen sharing.");
      }

      await startLocalScreenShare(room, includeSystemAudio, streamQualityMode, {
        takeoverIdentity: streamTakeoverOverrideIdentityRef.current,
        remainingSeconds
      });
      setIsScreenSharePickerOpen(false);
      refreshParticipants(room);
    } catch (caughtError) {
      setError(
        caughtError instanceof Error &&
          (caughtError.name === "NotAllowedError" || caughtError.name === "AbortError")
          ? "Screen sharing was cancelled or could not start. Choose a source and try again."
          : caughtError instanceof Error
            ? caughtError.message
            : "Unable to start screen sharing."
      );
    } finally {
      clearDesktopScreenShareSelection();
      streamTakeoverOverrideIdentityRef.current = null;
      setScreenShareSourcesLoading(false);
    }
  }

  async function toggleScreenFullscreen() {
    if (fullscreenTarget === "remote" || document.fullscreenElement) {
      if (document.fullscreenElement) {
        await document.exitFullscreen().catch(() => undefined);
      }
      setFullscreenTarget(null);
      return;
    }

    setFullscreenTarget("remote");
  }

  function toggleThirdPartyMute(identity: string) {
    setThirdPartyMutedIds((previous) => {
      const next = new Set(previous);
      const nextVolume = next.has(identity)
        ? participantVolumes[identity] && participantVolumes[identity] > 0
          ? participantVolumes[identity]
          : 1
        : 0;
      if (next.has(identity)) {
        next.delete(identity);
      } else {
        next.add(identity);
      }
      setParticipantVolumes((volumes) => {
        const nextVolumes = {
          ...volumes,
          [identity]: nextVolume
        };
        persistParticipantVolumes(nextVolumes);
        return nextVolumes;
      });
      return next;
    });
  }

  function setParticipantVolume(identity: string, volume: number) {
    const nextVolume = getClampedGainVolume(volume, MAX_PARTICIPANT_VOLUME_PERCENT);
    setParticipantVolumes((previous) => {
      const nextVolumes = {
        ...previous,
        [identity]: nextVolume
      };
      persistParticipantVolumes(nextVolumes);
      return nextVolumes;
    });
    setThirdPartyMutedIds((previous) => {
      const next = new Set(previous);
      if (nextVolume <= 0) {
        next.add(identity);
      } else {
        next.delete(identity);
      }
      return next;
    });
  }

  async function inspectStream(identity: string) {
    if (compactMode) {
      const streamLabel =
        mergedParticipants.find((participant) => participant.participantId === identity)
          ?.displayName ?? identity;
      const desktopBridge = getDesktopBridge();

      if (isDesktopShell && desktopBridge?.openStreamPopout) {
        try {
          const opened = await desktopBridge.openStreamPopout({
            streamIdentity: identity,
            streamLabel
          });

          if (opened) {
            setNativePopoutStreamIdentity(identity);
            setIsStreamPoppedOut(true);
          }
        } catch (caughtError) {
          setError(
            caughtError instanceof Error
              ? caughtError.message
              : "Unable to open the stream popout."
          );
        }
        return;
      }

      const popoutUrl = new URL("/desktop-popout", window.location.origin);
      popoutUrl.searchParams.set("streamIdentity", identity);
      popoutUrl.searchParams.set("streamLabel", streamLabel);
      const popup = window.open(
        popoutUrl.toString(),
        `sovchat-stream-${identity.replace(/[^a-z0-9_-]/giu, "-")}`,
        "popup=yes,width=960,height=560"
      );

      if (!popup) {
        setError("Allow popups for SovChat to open screen shares from compact view.");
      } else {
        popup.focus();
      }
      return;
    }

    setSelectedStreamIdentity((previous) => (previous === identity ? null : identity));
  }

  function getCurrentRemoteScreenVideoElement() {
    const attachedElement = attachedRemoteScreenRef.current?.element;

    if (attachedElement?.isConnected) {
      return attachedElement;
    }

    return (
      fullscreenScreenContainerRef.current?.querySelector("video") ??
      dockedScreenContainerRef.current?.querySelector("video") ??
      null
    );
  }

  function getRemoteScreenRestoreTarget() {
    return fullscreenTarget === "remote"
      ? fullscreenScreenContainerRef.current
      : dockedScreenContainerRef.current;
  }

  function restorePoppedOutStreamElement() {
    const videoElement = getCurrentRemoteScreenVideoElement();
    const target = getRemoteScreenRestoreTarget();

    if (!videoElement || !target) {
      return;
    }

    videoElement.className = "h-full w-full bg-black/45 object-contain rounded-[1.1rem]";
    target.replaceChildren(videoElement);
  }

  function renderDocumentPipStreamDock(pipWindow = documentPipWindowRef.current) {
    if (!pipWindow || pipWindow.closed || !documentPipVideoContainerRef.current) {
      return;
    }

    const pipDocument = pipWindow.document;
    const shell = pipDocument.querySelector("[data-sovchat-popout-shell]");
    if (!shell) {
      return;
    }

    const dock = shell.querySelector("[data-sovchat-popout-dock]");
    if (!dock) {
      return;
    }

    const clampedVolume = getClampedGainVolume(streamVolume, MAX_STREAM_VOLUME_PERCENT);
    const volumePercent = Math.round(clampedVolume * 100);
    const fillPercent = getStreamVolumePercent(clampedVolume);

    dock.replaceChildren();

    const outputLabel = pipDocument.createElement("div");
    outputLabel.textContent = "Audio";
    outputLabel.style.cssText = [
      "min-width:52px",
      "font-size:10px",
      "font-weight:700",
      "letter-spacing:0.22em",
      "text-transform:uppercase",
      "color:rgba(244,247,247,0.62)"
    ].join(";");

    const muteButton = pipDocument.createElement("button");
    muteButton.type = "button";
    muteButton.textContent = streamMuted ? "Sound" : "Mute";
    muteButton.title = streamMuted ? "Unmute stream audio" : "Mute stream audio";
    muteButton.style.cssText = getDocumentPipButtonStyles(streamMuted);
    muteButton.addEventListener("click", handleToggleStreamOutputMuted);

    const sliderWrap = pipDocument.createElement("div");
    sliderWrap.style.cssText = "position:relative;min-width:160px;flex:1;padding:0 4px;";

    const slider = pipDocument.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = String(MAX_STREAM_VOLUME_PERCENT);
    slider.value = String(volumePercent);
    slider.setAttribute("aria-label", "Stream volume");
    slider.style.cssText = getDocumentPipSliderStyles(fillPercent);
    slider.addEventListener("input", () => {
      const nextPercent = Number(slider.value);
      slider.style.cssText = getDocumentPipSliderStyles((nextPercent / MAX_STREAM_VOLUME_PERCENT) * 100);
      handleStreamOutputVolumeChange(nextPercent / 100);
    });
    sliderWrap.append(slider);

    const closeButton = pipDocument.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "Stop watching";
    closeButton.style.cssText = getDocumentPipButtonStyles(false);
    closeButton.addEventListener("click", onDocumentPipStopWatching);

    const popBackButton = pipDocument.createElement("button");
    popBackButton.type = "button";
    popBackButton.textContent = "Return to stage";
    popBackButton.style.cssText = getDocumentPipButtonStyles(false);
    popBackButton.addEventListener("click", () => {
      void popStreamBackIn();
    });

    dock.append(outputLabel, muteButton, sliderWrap, closeButton, popBackButton);
  }

  function getDocumentPipButtonStyles(isActive: boolean) {
    return [
      "appearance:none",
      "border:1px solid rgba(255,255,255,0.1)",
      "border-radius:8px",
      `background:${isActive ? "rgba(255,123,123,0.16)" : "rgba(31,47,51,0.88)"}`,
      `color:${isActive ? "#ffb5b5" : "#f4f7f7"}`,
      "font:600 12px/1.1 system-ui,-apple-system,Segoe UI,sans-serif",
      "padding:9px 11px",
      "box-shadow:inset 0 1px 0 rgba(255,255,255,0.06),0 10px 22px rgba(0,0,0,0.22)",
      "cursor:pointer",
      "white-space:nowrap"
    ].join(";");
  }

  function getDocumentPipSliderStyles(fillPercent: number) {
    const fill = Math.max(0, Math.min(100, fillPercent));
    return [
      "width:100%",
      "height:8px",
      "appearance:none",
      "border-radius:999px",
      "outline:none",
      "cursor:pointer",
      `background:linear-gradient(90deg,#ffca2a 0%,#ffca2a ${fill}%,rgba(36,53,58,0.96) ${fill}%,rgba(36,53,58,0.96) 100%)`,
      "box-shadow:inset 0 1px 0 rgba(255,255,255,0.08),0 0 0 1px rgba(255,255,255,0.08)"
    ].join(";");
  }

  function onDocumentPipStopWatching() {
    void popStreamBackIn();
    closeInspectedStream();
  }

  async function openDocumentPictureInPicture(videoElement: HTMLVideoElement) {
    if (isDesktopShell) {
      return false;
    }

    const documentPictureInPicture = window.documentPictureInPicture;

    if (!documentPictureInPicture?.requestWindow) {
      return false;
    }

    let pipWindow: Window;
    try {
      pipWindow = await documentPictureInPicture.requestWindow({
        width: 860,
        height: 540
      });
    } catch {
      return false;
    }
    const pipDocument = pipWindow.document;

    pipDocument.documentElement.style.cssText = "height:100%;margin:0;background:#0f2023;";
    pipDocument.body.style.cssText = "height:100%;margin:0;overflow:hidden;background:#0f2023;";
    pipDocument.body.replaceChildren();

    const style = pipDocument.createElement("style");
    style.textContent = `
      * { box-sizing: border-box; }
      video::-webkit-media-controls { display: none !important; }
      input[type="range"]::-webkit-slider-thumb {
        appearance: none;
        width: 18px;
        height: 18px;
        border: 0;
        border-radius: 999px;
        background: #ffca2a;
        box-shadow: 0 8px 18px rgba(255,202,42,0.28), 0 0 0 5px rgba(255,202,42,0.08);
      }
      input[type="range"]::-moz-range-thumb {
        width: 18px;
        height: 18px;
        border: 0;
        border-radius: 999px;
        background: #ffca2a;
        box-shadow: 0 8px 18px rgba(255,202,42,0.28), 0 0 0 5px rgba(255,202,42,0.08);
      }
    `;
    pipDocument.head.append(style);

    const shell = pipDocument.createElement("main");
    shell.dataset.sovchatPopoutShell = "true";
    shell.style.cssText = [
      "position:relative",
      "height:100%",
      "width:100%",
      "overflow:hidden",
      "background:#05090a",
      "font-family:system-ui,-apple-system,Segoe UI,sans-serif",
      "color:#f4f7f7"
    ].join(";");

    const videoContainer = pipDocument.createElement("div");
    videoContainer.style.cssText = "height:100%;width:100%;background:#05090a;";
    videoElement.className = "h-full w-full bg-black object-contain";
    videoElement.style.cssText = "height:100%;width:100%;background:#05090a;object-fit:contain;";
    videoContainer.append(videoElement);

    const dock = pipDocument.createElement("div");
    dock.dataset.sovchatPopoutDock = "true";
    dock.style.cssText = [
      "position:absolute",
      "left:50%",
      "bottom:14px",
      "z-index:2",
      "display:flex",
      "width:min(calc(100% - 28px),720px)",
      "transform:translateX(-50%)",
      "align-items:center",
      "gap:10px",
      "border:1px solid rgba(255,255,255,0.1)",
      "border-radius:12px",
      "background:rgba(12,20,23,0.82)",
      "padding:11px 12px",
      "box-shadow:0 18px 42px rgba(0,0,0,0.34),inset 0 1px 0 rgba(255,255,255,0.06)",
      "backdrop-filter:blur(16px)"
    ].join(";");

    shell.append(videoContainer, dock);
    pipDocument.body.append(shell);

    documentPipWindowRef.current = pipWindow;
    documentPipVideoContainerRef.current = videoContainer;
    renderDocumentPipStreamDock(pipWindow);
    setIsStreamPoppedOut(true);

    pipWindow.addEventListener(
      "pagehide",
      () => {
        restorePoppedOutStreamElement();
        documentPipWindowRef.current = null;
        documentPipVideoContainerRef.current = null;
        setIsStreamPoppedOut(false);
      },
      { once: true }
    );

    return true;
  }

  async function popOutSelectedStream() {
    const desktopBridge = getDesktopBridge();
    if (isDesktopShell && desktopBridge?.openStreamPopout && selectedStreamIdentity) {
      const streamIdentity = selectedStreamIdentity;
      try {
        const opened = await desktopBridge.openStreamPopout({
          streamIdentity,
          streamLabel: selectedStreamLabel
        });

        if (opened) {
          setNativePopoutStreamIdentity(streamIdentity);
          setSelectedStreamIdentity(null);
          if (fullscreenTarget === "remote" && document.fullscreenElement) {
            void document.exitFullscreen().catch(() => undefined);
          }
          setFullscreenTarget((previous) => (previous === "remote" ? null : previous));
          setIsStreamPoppedOut(true);
          return;
        }
      } catch (error) {
        setError(error instanceof Error ? error.message : "Unable to pop out the stream.");
        return;
      }
    }

    const videoElement = getCurrentRemoteScreenVideoElement();

    if (!videoElement) {
      setError("Stream popout is only available once the live video has loaded.");
      return;
    }

    try {
      if (documentPipWindowRef.current && !documentPipWindowRef.current.closed) {
        await popStreamBackIn();
        return;
      }

      if (await openDocumentPictureInPicture(videoElement)) {
        return;
      }

      if (typeof videoElement.requestPictureInPicture !== "function") {
        setError("Stream popout is only available once the live video has loaded.");
        return;
      }

      if (document.pictureInPictureElement === videoElement) {
        await document.exitPictureInPicture?.();
        return;
      }

      await videoElement.requestPictureInPicture();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to pop out the stream.");
    }
  }

  async function popStreamBackIn() {
    const desktopBridge = getDesktopBridge();
    if (nativePopoutStreamIdentityRef.current && desktopBridge?.closeStreamPopout) {
      const streamIdentity = nativePopoutStreamIdentityRef.current;
      await desktopBridge.closeStreamPopout().catch(() => undefined);
      setNativePopoutStreamIdentity(null);
      if (!compactMode) {
        setSelectedStreamIdentity(streamIdentity);
      }
      setIsStreamPoppedOut(false);
      return;
    }

    if (documentPipWindowRef.current && !documentPipWindowRef.current.closed) {
      const pipWindow = documentPipWindowRef.current;
      restorePoppedOutStreamElement();
      documentPipWindowRef.current = null;
      documentPipVideoContainerRef.current = null;
      pipWindow.close();
      setIsStreamPoppedOut(false);
      return;
    }

    if (!document.pictureInPictureElement) {
      setIsStreamPoppedOut(false);
      return;
    }

    await document.exitPictureInPicture?.().catch(() => undefined);
    setIsStreamPoppedOut(false);
  }

  function closeInspectedStream() {
    void popStreamBackIn();
    if (fullscreenTarget === "remote" && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      setFullscreenTarget(null);
    }
    setSelectedStreamIdentity(null);
  }

  function recordStreamStats(snapshot: StreamStatsSnapshot) {
    if (typeof window === "undefined") {
      return;
    }

    const history = window.__sovchatStreamStats ?? [];
    history.push(snapshot);
    window.__sovchatStreamStats = history.slice(-180);

    if (showStreamStats) {
      console.info("[voice:stream]", snapshot.direction, snapshot);
    }
  }

  async function applyAutoStreamTuning(
    videoTrack: LocalVideoTrack,
    snapshot: StreamStatsSnapshot
  ) {
    if (streamQualityMode !== "auto") {
      return;
    }

    const sender = videoTrack.sender;
    if (!sender?.getParameters || !sender.setParameters) {
      return;
    }

    const limited =
      snapshot.qualityLimitationReason === "cpu" ||
      snapshot.qualityLimitationReason === "bandwidth" ||
      (typeof snapshot.fps === "number" && snapshot.fps < 38);
    const healthy =
      snapshot.qualityLimitationReason === "none" &&
      typeof snapshot.fps === "number" &&
      snapshot.fps > 54 &&
      typeof snapshot.bitrateKbps === "number" &&
      snapshot.bitrateKbps > 5200;

    let nextTier = autoStreamTierRef.current;

    if (limited) {
      nextTier = nextTier === "high" ? "medium" : "low";
    } else if (healthy) {
      nextTier = nextTier === "low" ? "medium" : "high";
    }

    if (nextTier === autoStreamTierRef.current) {
      return;
    }

    autoStreamTierRef.current = nextTier;

    const nextLimits =
      nextTier === "high"
        ? { maxBitrate: 8_500_000, maxFramerate: 60 }
        : nextTier === "medium"
          ? { maxBitrate: 6_000_000, maxFramerate: 45 }
          : { maxBitrate: 4_000_000, maxFramerate: 30 };
    const parameters = sender.getParameters();
    parameters.encodings = (parameters.encodings ?? [{}]).map((encoding) => ({
      ...encoding,
      maxBitrate: nextLimits.maxBitrate,
      maxFramerate: nextLimits.maxFramerate
    }));

    await sender.setParameters(parameters).catch(() => undefined);
  }

  const selectedStreamIsPlaceholder = Boolean(
    fillerMode &&
    selectedStreamIdentity &&
      DEMO_STREAM_PLACEHOLDERS.has(selectedStreamIdentity) &&
      screenTrackIdentity !== selectedStreamIdentity
  );
  const selectedStreamLabel =
    mergedParticipants.find((participant) => participant.participantId === selectedStreamIdentity)
      ?.displayName ??
    selectedStreamIdentity;
  const selectedStreamIsLive = Boolean(selectedStreamIdentity && selectedRemoteScreenTrack);
  const selectedStreamIsPending =
    Boolean(selectedStreamIdentity) &&
    !selectedStreamIsPlaceholder &&
    !selectedStreamIsLive &&
    mergedParticipants.some(
      (participant) =>
        participant.participantId === selectedStreamIdentity && participant.isStreaming
    );
  const isRemoteFullscreen = fullscreenTarget === "remote";
  const isStreamViewerOpen =
    Boolean(selectedStreamIdentity) &&
    (selectedStreamIsPlaceholder || selectedStreamIsLive || selectedStreamIsPending);

  useEffect(() => {
    const desktopBridge = getDesktopBridge();
    if (!desktopBridge?.publishStreamPopoutVoiceState) {
      return;
    }

    void desktopBridge.publishStreamPopoutVoiceState({
      connected: Boolean(room && isVoiceConnectedStatus(status)),
      inputMuted: isMuted,
      outputMuted,
      streamMuted,
      streamVolume,
      nickname,
      streamLabel: selectedStreamLabel ?? null
    });
  }, [
    isMuted,
    nativePopoutStreamIdentity,
    nickname,
    outputMuted,
    room,
    selectedStreamLabel,
    status,
    streamMuted,
    streamVolume
  ]);

  useEffect(() => {
    if (!selectedStreamIdentity || isStreamViewerOpen) {
      return;
    }

    if (fullscreenTarget === "remote" && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    }

    setFullscreenTarget((previous) => (previous === "remote" ? null : previous));
    setSelectedStreamIdentity(null);
  }, [fullscreenTarget, isStreamViewerOpen, selectedStreamIdentity]);

  const handleToggleStreamOutputMuted = useCallback(() => {
    setStreamMuted((previous) => {
      const nextValue = !previous;
      audioSettingsStore.patch({ streamMuted: nextValue });
      applyRemoteAudioPreferences(
        selectedOutputId,
        outputMuted,
        outputVolume,
        nextValue,
        streamVolume,
        thirdPartyMutedIds,
        participantVolumes,
        participantVolumeKeys
      );
      return nextValue;
    });
  }, [outputMuted, outputVolume, participantVolumeKeys, participantVolumes, selectedOutputId, streamVolume, thirdPartyMutedIds]);

  const handleStreamOutputVolumeChange = useCallback(
    (nextVolume: number) => {
      setStreamVolume(nextVolume);
      audioSettingsStore.patch({ streamVolume: nextVolume });
      applyRemoteAudioPreferences(
        selectedOutputId,
        outputMuted,
        outputVolume,
        streamMuted,
        nextVolume,
        thirdPartyMutedIds,
        participantVolumes,
        participantVolumeKeys
      );
    },
    [outputMuted, outputVolume, participantVolumeKeys, participantVolumes, selectedOutputId, streamMuted, thirdPartyMutedIds]
  );

  const handleToggleRemoteFullscreen = useCallback(() => {
    void toggleScreenFullscreen();
  }, []);

  useEffect(() => {
    if (performanceMode) {
      setSuppressPillLayoutMotion(true);
      return;
    }

    const timeout = window.setTimeout(() => setSuppressPillLayoutMotion(false), 260);
    return () => window.clearTimeout(timeout);
  }, [performanceMode]);

  useEffect(() => {
    applyRemoteAudioPreferences(
      selectedOutputId,
      outputMuted,
      outputVolume,
      streamMuted,
      streamVolume,
      thirdPartyMutedIds,
      participantVolumes,
      participantVolumeKeys
    );
  }, [selectedOutputId, outputMuted, outputVolume, streamMuted, streamVolume, outputSupported, thirdPartyMutedIds, participantVolumes, participantVolumeKeys]);

  useEffect(() => {
    const handleEnterPictureInPicture = () => setIsStreamPoppedOut(true);
    const handleLeavePictureInPicture = () => setIsStreamPoppedOut(false);

    document.addEventListener("enterpictureinpicture", handleEnterPictureInPicture);
    document.addEventListener("leavepictureinpicture", handleLeavePictureInPicture);

    return () => {
      document.removeEventListener("enterpictureinpicture", handleEnterPictureInPicture);
      document.removeEventListener("leavepictureinpicture", handleLeavePictureInPicture);
    };
  }, []);

  useEffect(() => {
    const desktopBridge = getDesktopBridge();
    if (!desktopBridge?.subscribeStreamPopoutClosed) {
      return;
    }

    return desktopBridge.subscribeStreamPopoutClosed((event) => {
      const shouldRestore =
        !compactMode && Boolean(event.streamIdentity) && !suppressNextPopoutRestoreRef.current;
      suppressNextPopoutRestoreRef.current = false;
      setNativePopoutStreamIdentity((previous) =>
        !event.streamIdentity || previous === event.streamIdentity ? null : previous
      );
      if (shouldRestore) {
        setSelectedStreamIdentity(event.streamIdentity);
      }
      setIsStreamPoppedOut(false);
    });
  }, [compactMode]);

  useEffect(() => {
    renderDocumentPipStreamDock();
  }, [streamMuted, streamVolume, selectedStreamLabel]);

  useEffect(() => {
    return () => {
      void popStreamBackIn();
      if (desktopAudioProcessingTimeoutRef.current) {
        window.clearTimeout(desktopAudioProcessingTimeoutRef.current);
        desktopAudioProcessingTimeoutRef.current = 0;
      }

      if (uiAudioContextRef.current) {
        void uiAudioContextRef.current.close().catch(() => undefined);
        uiAudioContextRef.current = null;
      }

      remoteOutputRouter.clear();

      if (attachedRemoteScreenRef.current) {
        attachedRemoteScreenRef.current.track.detach(attachedRemoteScreenRef.current.element);
        attachedRemoteScreenRef.current.element.remove();
        attachedRemoteScreenRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      void stopLocalScreenShare(room);
      room?.disconnect();
    };
  }, [room]);

  const stageNicknames = Array.from(new Set([...onlineNicknames, ...transitionLobbyNicknames]));
  const isPrimaryPickerOpen = showMainPanel && isScreenSharePickerOpen;

  useEffect(() => {
    onPrimaryOverlayChange?.(isPrimaryPickerOpen);

    return () => {
      onPrimaryOverlayChange?.(false);
    };
  }, [isPrimaryPickerOpen, onPrimaryOverlayChange]);

  const voiceStageProps: VoiceStageProps = {
    roomName,
    nickname,
    status,
    error,
    isSharing,
    participants: mergedParticipants,
    onlineNicknames: stageNicknames,
    onlineProfiles,
    transitionLobbyNicknames,
    lingeringNicknames: previousVoiceIdsRef.current,
    selfMuted: isMuted,
    selfDeafened: outputMuted,
    thirdPartyMutedIds,
    participantVolumes,
    suppressLayoutMotion: suppressPillLayoutMotion,
    selectedStreamLabel: selectedStreamLabel ?? null,
    selectedStreamIsPlaceholder,
    selectedStreamIsPending,
    isStreamViewerOpen,
    isUpdateInstallStageActive,
    isChatPanelOpen,
    chatPanelContent,
    isRemoteFullscreen,
    outputMuted: streamMuted,
    outputVolume: streamVolume,
    showStreamStats,
    streamStats,
    onWhisperParticipant,
    onToggleThirdPartyMute: toggleThirdPartyMute,
    onParticipantVolumeChange: setParticipantVolume,
    onInspectStream: (identity) => {
      void inspectStream(identity);
    },
    dockedStreamStageRef,
    dockedScreenContainerRef,
    onCloseStreamViewer: closeInspectedStream,
    onPopOutStream: popOutSelectedStream,
    onToggleRemoteFullscreen: handleToggleRemoteFullscreen,
    onToggleStreamOutputMuted: handleToggleStreamOutputMuted,
    onOutputVolumeChange: handleStreamOutputVolumeChange,
    localAvatarSrc,
    knownAvatarSources,
    onJoin: joinRoom,
    onPrimeJoin: primeVoiceJoin,
    onCancelJoin: cancelJoin,
    onLeave: leaveRoom,
    onToggleScreenShare: toggleScreenShare,
    fillerMode,
    performanceMode,
    krispSupported,
    krispFailed,
    krispPrewarmState,
    noiseFilterEnabled,
    onToggleNoiseFilter: () => {
      audioSettingsStore.getController().setNoiseFilterEnabled(!noiseFilterEnabled);
    },
    hubRef: voiceHubRef,
    ringRef: voiceRingRef
  };

  return (
    <>
      <div className={cn("flex h-full flex-col", compactMode ? "min-h-0" : "min-h-[72vh]")}>
        <AnimatePresence initial={false} mode="wait">
          {isPrimaryPickerOpen ? (
            <motion.div
              key="screen-share-picker"
              className={cn(
                "flex h-full flex-col overflow-hidden",
                compactMode ? "min-h-0" : "min-h-[72vh]"
              )}
              initial={{ opacity: 0, y: 18, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -12, scale: 0.985 }}
              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            >
              <ScreenShareSourcePicker
                isOpen
                isLoading={screenShareSourcesLoading}
                sources={screenShareSources}
                compactMode={compactMode}
                includeSystemAudio={screenShareIncludeSystemAudio}
                systemAudioSupported={screenShareSystemAudioSupported}
                streamQualityMode={streamQualityMode}
                onToggleIncludeSystemAudio={setScreenShareIncludeSystemAudio}
                onStreamQualityModeChange={setStreamQualityMode}
                onClose={() => {
                  clearDesktopScreenShareSelection();
                  streamTakeoverOverrideIdentityRef.current = null;
                  setScreenShareSourcesLoading(false);
                  setIsScreenSharePickerOpen(false);
                }}
                onSelect={(source) => {
                  void shareDesktopSource(source);
                }}
              />
            </motion.div>
          ) : showMainPanel ? (
            <motion.div
              key="voice-stage"
              className={cn(
                "flex h-full flex-col overflow-hidden",
                compactMode ? "min-h-0 gap-0" : "min-h-[72vh] gap-5"
              )}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
            >
        {compactMode ? (
          <CompactVoiceStage {...voiceStageProps} />
        ) : (
          <VoiceStage {...voiceStageProps} />
        )}
            </motion.div>
          ) : fallbackContent ? (
            <motion.div
              key="fallback-panel"
              className={cn(
                "flex h-full flex-col overflow-hidden",
                compactMode ? "min-h-0" : "min-h-[72vh]"
              )}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16, ease: "easeOut" }}
            >
              {fallbackContent}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      <StreamViewerOverlay
        isOpen={!compactMode && showMainPanel && !isPrimaryPickerOpen && isStreamViewerOpen && isRemoteFullscreen}
        selectedStreamLabel={selectedStreamLabel ?? null}
        selectedStreamIsPlaceholder={selectedStreamIsPlaceholder}
        selectedStreamIsPending={selectedStreamIsPending}
        isRemoteFullscreen={isRemoteFullscreen}
        isStreamPoppedOut={isStreamPoppedOut}
        outputMuted={streamMuted}
        outputVolume={streamVolume}
        showStreamStats={showStreamStats}
        streamStats={streamStats}
        onClose={closeInspectedStream}
        onPopOut={popOutSelectedStream}
        onPopBackIn={popStreamBackIn}
        onToggleOutputMuted={handleToggleStreamOutputMuted}
        onOutputVolumeChange={handleStreamOutputVolumeChange}
        onToggleRemoteFullscreen={handleToggleRemoteFullscreen}
        fullscreenStreamStageRef={fullscreenStreamStageRef}
        fullscreenScreenContainerRef={fullscreenScreenContainerRef}
      />

      <AnimatePresence>
        {streamTakeoverPrompt ? (
          <motion.div
            className="fixed inset-0 z-[90] flex items-center justify-center bg-black/42 px-4 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="stream-takeover-title"
          >
            <motion.div
              className="w-full max-w-[360px] rounded-[1.1rem] border border-white/10 bg-[rgba(18,41,45,0.96)] p-5 text-white shadow-[0_28px_70px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.05)]"
              initial={{ y: 18, scale: 0.96 }}
              animate={{ y: 0, scale: 1 }}
              exit={{ y: 10, scale: 0.97 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="mb-4 flex items-start gap-3">
                <span className="mt-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[rgba(92,231,238,0.1)] text-[var(--accent)] shadow-[inset_0_0_0_1px_rgba(92,231,238,0.16)]">
                  <MonitorUp className="h-5 w-5" strokeWidth={2.1} />
                </span>
                <div className="min-w-0">
                  <h2 id="stream-takeover-title" className="text-base font-medium leading-tight text-white/92">
                    {streamTakeoverPrompt.label} is live
                  </h2>
                  <p className="mt-2 text-sm leading-5 text-white/62">
                    Stop their stream and start yours, or cancel and leave the current stream running.
                  </p>
                </div>
              </div>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={cancelStreamTakeover}
                  disabled={streamTakeoverBusy}
                  className="inline-flex h-10 cursor-pointer items-center justify-center rounded-full px-4 text-sm text-white/62 transition hover:bg-white/6 hover:text-white disabled:cursor-default disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void confirmStreamTakeover();
                  }}
                  disabled={streamTakeoverBusy}
                  className="inline-flex h-10 cursor-pointer items-center justify-center rounded-full bg-[rgba(92,231,238,0.16)] px-4 text-sm font-medium text-[var(--accent)] shadow-[inset_0_0_0_1px_rgba(92,231,238,0.22)] transition hover:bg-[rgba(92,231,238,0.22)] disabled:cursor-default disabled:opacity-60"
                >
                  {streamTakeoverBusy ? "Stopping..." : "Stop stream and go live"}
                </button>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div ref={audioContainerRef} className="hidden" />
    </>
  );
}
