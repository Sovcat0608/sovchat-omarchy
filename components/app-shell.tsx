"use client";

import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeftRight,
  Check,
  HeadphoneOff,
  MicOff,
  MessageSquareText,
  Pencil,
  Settings
} from "lucide-react";
import { type PropsWithChildren, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { RefObject } from "react";
import { AvatarDrawer } from "@/components/avatar-drawer";
import { useAppLayout } from "@/components/app-layout-context";
import { ChatView } from "@/components/chat-view";
import { VoiceRoom } from "@/components/voice-room";
import { SettingsPanelBridge } from "@/components/settings-panel-bridge";
import { VersionHighlightsPanel } from "@/components/version-highlights-panel";
import { HoverTooltip } from "@/components/hover-tooltip";
import { OmarchyGlyph } from "@/components/omarchy-glyph";
import { RoomOnboardingModal } from "@/components/room-onboarding-modal";
import { apiFetch, createApiEventSource, resolveApiUrl } from "@/lib/api-client";
import { audioSettingsStore } from "@/lib/audio-settings-store";
import { clearDesktopSessionToken } from "@/lib/desktop-auth";
import { getDesktopBridge } from "@/lib/desktop";
import { APP_BUILD_VERSION } from "@/lib/generated/build-meta";
import { profileSettingsStore } from "@/lib/profile-settings-store";
import { useAppFocusState } from "@/lib/use-app-focus-state";
import { cn } from "@/lib/utils";
import { VERSION_HIGHLIGHTS_STAGE_EVENT } from "@/lib/version-highlights-event";
import logoMark from "@/images/logo.svg";
import logoIcon from "@/images/ico.svg";
import type { ChatMessage, ProfileResponse, RoomStateResponse, RoomSummary, WhisperTarget } from "@/types";

type AppShellProps = PropsWithChildren<{
  userId: string;
  nickname: string;
  forceVoiceRoute?: boolean;
  logoutRedirectPath?: "/desktop";
  onLogout?: () => void;
}>;

type PrimaryView = "voice" | "settings" | "chat" | "version";
type SettingsTab = "audio" | "appearance" | "rooms" | "livekit-usage" | "developer" | "advanced";
type ChatMessageEvent =
  | {
      type: "message-created" | "message-updated";
      message: ChatMessage;
    }
  | {
      type: "message-deleted";
      messageId: string;
    };

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function messageMentionsNickname(body: string, nickname: string) {
  const trimmedNickname = nickname.trim();
  if (!trimmedNickname) {
    return false;
  }

  if (trimmedNickname.includes(" ")) {
    const quotedMentionPattern = new RegExp(`(^|[\\s(])@"${escapeRegExp(trimmedNickname)}"(?=$|[\\s),.!?:;])`, "i");
    return quotedMentionPattern.test(body);
  }

  const mentionPattern = new RegExp(`(^|[\\s(])@${escapeRegExp(trimmedNickname)}(?=$|[\\s),.!?:;])`, "i");
  return mentionPattern.test(body);
}

async function playMentionNote(audioContextRef: RefObject<AudioContext | null>) {
  if (typeof window === "undefined" || typeof AudioContext === "undefined") {
    return;
  }

  audioContextRef.current ??= new AudioContext();
  const audioContext = audioContextRef.current;

  if (audioContext.state === "suspended") {
    await audioContext.resume().catch(() => undefined);
  }

  const now = audioContext.currentTime;
  const masterGain = audioContext.createGain();
  masterGain.connect(audioContext.destination);
  masterGain.gain.setValueAtTime(0.0001, now);
  masterGain.gain.exponentialRampToValueAtTime(0.16, now + 0.02);
  masterGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.48);

  const firstOscillator = audioContext.createOscillator();
  firstOscillator.type = "sine";
  firstOscillator.frequency.setValueAtTime(880, now);
  firstOscillator.frequency.exponentialRampToValueAtTime(1174.66, now + 0.16);
  firstOscillator.connect(masterGain);
  firstOscillator.start(now);
  firstOscillator.stop(now + 0.18);

  const secondOscillator = audioContext.createOscillator();
  secondOscillator.type = "triangle";
  secondOscillator.frequency.setValueAtTime(1318.51, now + 0.17);
  secondOscillator.frequency.exponentialRampToValueAtTime(1760, now + 0.34);
  secondOscillator.connect(masterGain);
  secondOscillator.start(now + 0.17);
  secondOscillator.stop(now + 0.38);

  window.setTimeout(() => {
    firstOscillator.disconnect();
    secondOscillator.disconnect();
    masterGain.disconnect();
  }, 700);
}

async function playWhisperNote(audioContextRef: RefObject<AudioContext | null>) {
  if (typeof window === "undefined" || typeof AudioContext === "undefined") {
    return;
  }

  audioContextRef.current ??= new AudioContext();
  const audioContext = audioContextRef.current;

  if (audioContext.state === "suspended") {
    await audioContext.resume().catch(() => undefined);
  }

  const now = audioContext.currentTime;
  const masterGain = audioContext.createGain();
  masterGain.connect(audioContext.destination);
  masterGain.gain.setValueAtTime(0.0001, now);
  masterGain.gain.exponentialRampToValueAtTime(0.13, now + 0.018);
  masterGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.62);

  const chime = audioContext.createOscillator();
  chime.type = "triangle";
  chime.frequency.setValueAtTime(987.77, now);
  chime.frequency.exponentialRampToValueAtTime(1567.98, now + 0.18);
  chime.connect(masterGain);
  chime.start(now);
  chime.stop(now + 0.22);

  const shimmer = audioContext.createOscillator();
  shimmer.type = "sine";
  shimmer.frequency.setValueAtTime(2093, now + 0.16);
  shimmer.frequency.exponentialRampToValueAtTime(2637.02, now + 0.3);
  shimmer.connect(masterGain);
  shimmer.start(now + 0.16);
  shimmer.stop(now + 0.34);

  const tail = audioContext.createOscillator();
  tail.type = "sine";
  tail.frequency.setValueAtTime(1760, now + 0.34);
  tail.frequency.exponentialRampToValueAtTime(1174.66, now + 0.54);
  tail.connect(masterGain);
  tail.start(now + 0.34);
  tail.stop(now + 0.58);

  window.setTimeout(() => {
    chime.disconnect();
    shimmer.disconnect();
    tail.disconnect();
    masterGain.disconnect();
  }, 900);
}

function ChatRoundLineIcon() {
  return (
    <svg
      className="chat-fab-icon"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <path
        className="chat-fab-icon__bubble"
        d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 13.5997 2.37562 15.1116 3.04346 16.4525C3.22094 16.8088 3.28001 17.2161 3.17712 17.6006L2.58151 19.8267C2.32295 20.793 3.20701 21.677 4.17335 21.4185L6.39939 20.8229C6.78393 20.72 7.19121 20.7791 7.54753 20.9565C8.88836 21.6244 10.4003 22 12 22Z"
      />
      <path
        className="chat-fab-icon__line"
        d="M7.825 12.85C7.36937 12.85 7 13.2194 7 13.675C7 14.1306 7.36937 14.5 7.825 14.5H13.875C14.3306 14.5 14.7 14.1306 14.7 13.675C14.7 13.2194 14.3306 12.85 13.875 12.85H7.825Z"
      />
      <path
        className="chat-fab-icon__line"
        d="M7.825 9C7.36937 9 7 9.36937 7 9.825C7 10.2806 7.36937 10.65 7.825 10.65H16.625C17.0806 10.65 17.45 10.2806 17.45 9.825C17.45 9.36937 17.0806 9 16.625 9H7.825Z"
      />
    </svg>
  );
}

export function AppShell({
  userId,
  nickname,
  children,
  forceVoiceRoute = false,
  logoutRedirectPath = "/desktop",
  onLogout
}: AppShellProps) {
  const router = useRouter();
  const getProfileServerSnapshot = () => ({
    nickname,
    avatarId: "avatar-1",
    avatarDataUrl: null
  });
  const [activePrimaryView, setActivePrimaryView] = useState<PrimaryView>("voice");
  const [activeSettingsTab, setActiveSettingsTab] = useState<SettingsTab>("audio");
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [voiceOverlayOpen, setVoiceOverlayOpen] = useState(false);
  const [isDockVisible, setIsDockVisible] = useState(true);
  const [isRoomSwitcherOpen, setIsRoomSwitcherOpen] = useState(false);
  const primaryDockRef = useRef<HTMLDivElement>(null);
  const roomSwitcherRef = useRef<HTMLDivElement>(null);
  const [primaryDockWidth, setPrimaryDockWidth] = useState(0);
  const isVoiceRoute = forceVoiceRoute || usePathname() === "/app/voice";
  const audioState = useSyncExternalStore(
    audioSettingsStore.subscribe,
    audioSettingsStore.getState,
    audioSettingsStore.getState
  );
  const profileState = useSyncExternalStore(
    profileSettingsStore.subscribe,
    profileSettingsStore.getState,
    getProfileServerSnapshot
  );
  const controller = audioSettingsStore.getController();
  const displayName = profileState.nickname?.trim() || nickname;
  const avatarSrc = profileState.avatarDataUrl || `/avatars/${profileState.avatarId}.png`;
  const isDesktopShell = Boolean(getDesktopBridge()?.isDesktop);
  const { isCompact: isCompactLayout } = useAppLayout();
  const { isAppFocused } = useAppFocusState();
  const performanceMode = audioState.performanceMode || !isAppFocused;
  const [roomState, setRoomState] = useState<RoomStateResponse | null>(null);
  const [isRoomsLoading, setIsRoomsLoading] = useState(true);
  const [isRoomsPending, setIsRoomsPending] = useState(false);
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [roomsStatus, setRoomsStatus] = useState<string | null>(null);
  const [hasUnreadChatMessages, setHasUnreadChatMessages] = useState(false);
  const [unreadMentionCount, setUnreadMentionCount] = useState(0);
  const [unreadWhisperCount, setUnreadWhisperCount] = useState(0);
  const [pendingWhisperTarget, setPendingWhisperTarget] = useState<WhisperTarget | null>(null);
  const currentRoom = roomState?.currentRoom ?? null;
  const isDesktopVoiceLayout = isDesktopShell && isVoiceRoute;
  const isWebStageChatLayout = !isDesktopShell && isVoiceRoute && activePrimaryView === "chat";
  const hasMentionedUnreadChatMessage = unreadMentionCount > 0;
  const hasUnreadWhisperMessage = unreadWhisperCount > 0;
  const availableRooms = useMemo(() => {
    const ordered: RoomSummary[] = [];
    const seen = new Set<string>();

    const appendRoom = (room: RoomSummary | null | undefined) => {
      if (!room || seen.has(room.id)) {
        return;
      }

      seen.add(room.id);
      ordered.push(room);
    };

    appendRoom(roomState?.currentRoom);
    appendRoom(roomState?.ownedRoom);
    (roomState?.joinedRooms ?? []).forEach(appendRoom);
    return ordered;
  }, [roomState?.currentRoom, roomState?.joinedRooms, roomState?.ownedRoom]);
  const shouldHidePrimaryDock = activePrimaryView !== "voice" || voiceOverlayOpen;
  const mentionAudioContextRef = useRef<AudioContext | null>(null);
  const heardMentionMessageIdsRef = useRef<string[]>([]);
  const heardWhisperMessageIdsRef = useRef<string[]>([]);
  const primaryDockShellWidth = Math.max(primaryDockWidth, 320);
  const primaryDockShellHeight = 72;
  const primaryDockShellInset = Math.min(174, Math.max(118, primaryDockShellWidth * 0.26));
  const primaryDockShellPath = [
    `M ${primaryDockShellInset} 16`,
    `L ${primaryDockShellInset - 34} 50`,
    `C ${primaryDockShellInset - 44} 60 ${primaryDockShellInset - 58} 66 ${primaryDockShellInset - 72} 66`,
    `L 0 ${primaryDockShellHeight}`,
    `L ${primaryDockShellWidth} ${primaryDockShellHeight}`,
    `L ${primaryDockShellWidth - primaryDockShellInset + 72} 66`,
    `C ${primaryDockShellWidth - primaryDockShellInset + 58} 66 ${primaryDockShellWidth - primaryDockShellInset + 44} 60 ${primaryDockShellWidth - primaryDockShellInset + 34} 50`,
    `L ${primaryDockShellWidth - primaryDockShellInset} 16`,
    `C ${primaryDockShellWidth - primaryDockShellInset - 10} 6 ${primaryDockShellWidth - primaryDockShellInset - 24} 0 ${primaryDockShellWidth - primaryDockShellInset - 38} 0`,
    `L ${primaryDockShellInset + 38} 0`,
    `C ${primaryDockShellInset + 24} 0 ${primaryDockShellInset + 10} 6 ${primaryDockShellInset} 16`,
    "Z"
  ].join(" ");
  const panelMotionProps = {
    initial: { opacity: 0, y: 18, scale: 0.985 },
    animate: { opacity: 1, y: 0, scale: 1 },
    exit: { opacity: 0, y: -12, scale: 0.985 },
    transition: {
      duration: 0.24,
      ease: [0.22, 1, 0.36, 1]
    }
  } as const;
  const chatNotificationState = hasUnreadWhisperMessage
    ? "whisper"
    : hasMentionedUnreadChatMessage
    ? "mention"
    : hasUnreadChatMessages
      ? "unread"
      : "default";
  const isChatVisibleToUser = activePrimaryView === "chat" && isAppFocused;
  const chatLauncherLabel =
    chatNotificationState === "whisper"
      ? "Open room chat, unread whisper"
      : chatNotificationState === "mention"
      ? "Open room chat, mentioned unread message"
      : chatNotificationState === "unread"
        ? "Open room chat, unread messages"
        : "Open room chat";

  async function refreshRooms() {
    const response = await apiFetch("/api/rooms", {
      cache: "no-store"
    });
    const payload = (await response.json().catch(() => null)) as
      | (RoomStateResponse & { error?: string })
      | null;

    if (!response.ok || !payload) {
      throw new Error(payload?.error ?? "Unable to load your rooms right now.");
    }

    setRoomState(payload);
    setRoomsError(null);
  }

  async function mutateRooms(
    request: RequestInit & {
      url?: string;
    },
    statusMessage?: string
  ) {
    setIsRoomsPending(true);
    setRoomsError(null);
    setRoomsStatus(null);

    try {
      const response = await apiFetch(request.url ?? "/api/rooms", request);
      const payload = (await response.json().catch(() => null)) as
        | (RoomStateResponse & { error?: string })
        | null;

      if (!response.ok || !payload) {
        throw new Error(payload?.error ?? "Unable to update your room right now.");
      }

      setRoomState(payload);
      if (statusMessage) {
        setRoomsStatus(statusMessage);
      }
    } catch (error) {
      setRoomsError(
        error instanceof Error ? error.message : "Unable to update your room right now."
      );
      throw error;
    } finally {
      setIsRoomsPending(false);
    }
  }

  useLayoutEffect(() => {
    if (isCompactLayout) {
      setPrimaryDockWidth(0);
      return;
    }

    const element = primaryDockRef.current;

    if (!element) {
      return;
    }

    const updateDockWidth = () => {
      setPrimaryDockWidth(element.offsetWidth || element.getBoundingClientRect().width);
    };

    updateDockWidth();

    const animationFrame = window.requestAnimationFrame(updateDockWidth);
    window.addEventListener("resize", updateDockWidth);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateDockWidth);
    observer?.observe(element);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", updateDockWidth);
      observer?.disconnect();
    };
  }, [displayName, isCompactLayout, isDockVisible]);

  function openChatPanel() {
    setPendingWhisperTarget(null);
    setHasUnreadChatMessages(false);
    setUnreadMentionCount(0);
    setUnreadWhisperCount(0);
    setActivePrimaryView("chat");
    setAvatarOpen(false);
  }

  function openWhisperTarget(target: WhisperTarget) {
    setPendingWhisperTarget({
      ...target,
      requestId: Date.now()
    });
    setHasUnreadChatMessages(false);
    setUnreadMentionCount(0);
    setUnreadWhisperCount(0);
    setActivePrimaryView("chat");
    setAvatarOpen(false);
  }

  function openRoomSettings() {
    setIsRoomSwitcherOpen(false);
    setAvatarOpen(false);
    setActiveSettingsTab("rooms");
    setActivePrimaryView("settings");
  }

  function openVersionHighlights() {
    setIsRoomSwitcherOpen(false);
    setPendingWhisperTarget(null);
    setAvatarOpen(false);
    setActivePrimaryView("version");
  }

  async function switchRoom(roomId: string) {
    const targetRoom =
      roomState?.ownedRoom?.id === roomId
        ? roomState.ownedRoom
        : roomState?.joinedRooms.find((room) => room.id === roomId) ?? roomState?.currentRoom;
    await mutateRooms({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "switch", roomId })
    }, `Switched to "${targetRoom?.name ?? "room"}".`);
  }

  function sendOfflineBeacon() {
    if (typeof window === "undefined") {
      return;
    }

    const url = resolveApiUrl("/api/presence/offline");

    if (
      !isDesktopShell &&
      typeof navigator !== "undefined" &&
      typeof navigator.sendBeacon === "function"
    ) {
      const payload = new Blob(["{}"], { type: "application/json" });
      navigator.sendBeacon(url, payload);
      return;
    }

    void apiFetch("/api/presence/offline", {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: "{}"
    }).catch(() => undefined);
  }

  useEffect(() => {
    profileSettingsStore.syncNickname(nickname);
  }, [nickname]);

  useEffect(() => {
    let active = true;

    void apiFetch("/api/profile", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (!active || !payload) {
          return;
        }

        const profile = payload as ProfileResponse;
        profileSettingsStore.patch({
          nickname: profile.nickname,
          avatarId: profile.avatarId,
          avatarDataUrl: profile.avatarDataUrl
        });
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;

    void refreshRooms()
      .catch((error) => {
        if (!active) {
          return;
        }

        setRoomsError(
          error instanceof Error ? error.message : "Unable to load your rooms right now."
        );
      })
      .finally(() => {
        if (active) {
          setIsRoomsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    let timeout = 0;

    const scheduleNextLoad = () => {
      timeout = window.setTimeout(() => {
        if (!active) {
          return;
        }

        void refreshRooms()
          .catch(() => undefined)
          .finally(scheduleNextLoad);
      }, typeof document !== "undefined" && document.hidden ? 8000 : 2500);
    };

    scheduleNextLoad();

    return () => {
      active = false;
      if (timeout) {
        window.clearTimeout(timeout);
      }
    };
  }, []);

  useEffect(() => {
    if (!isRoomSwitcherOpen) {
      return undefined;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (roomSwitcherRef.current?.contains(event.target as Node)) {
        return;
      }

      setIsRoomSwitcherOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsRoomSwitcherOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isRoomSwitcherOpen]);

  useEffect(() => {
    setIsRoomSwitcherOpen(false);
  }, [currentRoom?.id]);

  useEffect(() => {
    setHasUnreadChatMessages(false);
    setUnreadMentionCount(0);
    setUnreadWhisperCount(0);
    setPendingWhisperTarget(null);
  }, [currentRoom?.id]);

  useEffect(() => {
    if (isChatVisibleToUser) {
      setHasUnreadChatMessages(false);
      setUnreadMentionCount(0);
      setUnreadWhisperCount(0);
    } else if (activePrimaryView !== "chat") {
      setPendingWhisperTarget(null);
    }
  }, [activePrimaryView, isChatVisibleToUser]);

  useEffect(() => {
    const desktopBridge = getDesktopBridge();
    const setTrayChatState = desktopBridge?.setTrayChatState;

    if (!setTrayChatState) {
      return;
    }

    void setTrayChatState({
      whisperCount: unreadWhisperCount,
      mentionCount: unreadMentionCount,
      hasUnreadMessages: hasUnreadChatMessages
    }).catch(() => undefined);
  }, [hasUnreadChatMessages, unreadMentionCount, unreadWhisperCount]);

  useEffect(() => {
    const desktopBridge = getDesktopBridge();
    const setTrayChatState = desktopBridge?.setTrayChatState;

    if (!setTrayChatState) {
      return undefined;
    }

    return () => {
      void setTrayChatState({
        whisperCount: 0,
        mentionCount: 0,
        hasUnreadMessages: false
      }).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (!currentRoom) {
      return;
    }

    const source = createApiEventSource("/api/messages/stream");

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as ChatMessageEvent;

        if (
          payload.type === "message-created" &&
          payload.message.userId !== userId
        ) {
          const mentionsCurrentUser = messageMentionsNickname(payload.message.body, displayName);
          const isWhisper = Boolean(payload.message.whisper);
          const shouldMarkChatUnread = !isChatVisibleToUser;

          if (shouldMarkChatUnread) {
            setHasUnreadChatMessages(true);
            if (isWhisper) {
              setUnreadWhisperCount((count) => count + 1);
            }
            if (mentionsCurrentUser) {
              setUnreadMentionCount((count) => count + 1);
            }
          }

          if (isWhisper) {
            if (!heardWhisperMessageIdsRef.current.includes(payload.message.id)) {
              heardWhisperMessageIdsRef.current = [
                ...heardWhisperMessageIdsRef.current.slice(-39),
                payload.message.id
              ];
              void playWhisperNote(mentionAudioContextRef);
            }
          } else if (
            mentionsCurrentUser &&
            !heardMentionMessageIdsRef.current.includes(payload.message.id)
          ) {
            heardMentionMessageIdsRef.current = [
              ...heardMentionMessageIdsRef.current.slice(-39),
              payload.message.id
            ];
            void playMentionNote(mentionAudioContextRef);
          }
        }
      } catch {
        return;
      }
    };

    return () => {
      source.close();
    };
  }, [currentRoom?.id, displayName, isChatVisibleToUser, userId]);

  useEffect(() => {
    const handlePageHide = () => {
      sendOfflineBeacon();
    };

    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, []);

  useEffect(() => {
    document.body.dataset.performanceMode = String(performanceMode);

    return () => {
      delete document.body.dataset.performanceMode;
    };
  }, [performanceMode]);

  useEffect(() => {
    return () => {
      if (mentionAudioContextRef.current) {
        void mentionAudioContextRef.current.close().catch(() => undefined);
        mentionAudioContextRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (shouldHidePrimaryDock) {
      setIsDockVisible(false);
      return;
    }

    const timeout = window.setTimeout(() => {
      setIsDockVisible(true);
    }, 180);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [shouldHidePrimaryDock]);

  useEffect(() => {
    if (!roomsStatus) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setRoomsStatus((current) => (current === roomsStatus ? null : current));
    }, 2600);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [roomsStatus]);

  async function handleLogout() {
    sendOfflineBeacon();
    await apiFetch("/api/auth/logout", { method: "POST", keepalive: true }).catch(() => null);
    clearDesktopSessionToken();
    onLogout?.();
    router.replace(logoutRedirectPath);
    router.refresh();
  }

  function handleRemoteSessionExpired() {
    sendOfflineBeacon();
    clearDesktopSessionToken();
    onLogout?.();
    router.replace(logoutRedirectPath);
    router.refresh();
  }

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_DESKTOP_DEV_MODE === "true") {
      return;
    }

    let active = true;
    let timeout = 0;

    const checkSession = () => {
      timeout = window.setTimeout(() => {
        if (!active) {
          return;
        }

        void apiFetch("/api/auth/session", { cache: "no-store" })
          .then((response) => {
            if (!active) {
              return;
            }

            if (response.status === 401) {
              active = false;
              handleRemoteSessionExpired();
            }
          })
          .catch(() => undefined)
          .finally(() => {
            if (active) {
              checkSession();
            }
          });
      }, typeof document !== "undefined" && document.hidden ? 15_000 : 5_000);
    };

    checkSession();

    return () => {
      active = false;
      if (timeout) {
        window.clearTimeout(timeout);
      }
    };
  }, [logoutRedirectPath, onLogout, router]);

  useEffect(() => {
    const desktopBridge = getDesktopBridge();
    if (!desktopBridge?.subscribeTrayCommand) {
      return undefined;
    }

    return desktopBridge.subscribeTrayCommand((command) => {
      if (command === "open-chat") {
        openChatPanel();
        return;
      }

      if (command === "toggle-input-muted") {
        controller.setInputMuted(!audioSettingsStore.getState().inputMuted);
        return;
      }

      if (command === "toggle-output-muted") {
        controller.setOutputMuted(!audioSettingsStore.getState().outputMuted);
        return;
      }

      if (command === "logout") {
        void handleLogout();
      }
    });
  }, [controller]);

  useEffect(() => {
    const handleOpenVersionHighlights = () => {
      openVersionHighlights();
    };

    window.addEventListener(VERSION_HIGHLIGHTS_STAGE_EVENT, handleOpenVersionHighlights);

    return () => {
      window.removeEventListener(VERSION_HIGHLIGHTS_STAGE_EVENT, handleOpenVersionHighlights);
    };
  }, []);

  return (
    <>
      <div
        className={cn(
          "app-select-root relative overflow-hidden",
          isDesktopShell
            ? "h-[calc(100vh-48px)] min-h-0"
            : isCompactLayout
              ? "h-[100dvh] min-h-0"
              : "min-h-screen"
        )}
      >
        {!isDesktopShell && (!isCompactLayout || activePrimaryView === "voice") ? (
          <div
            className={cn(
              "pointer-events-none absolute z-20 flex items-start gap-3",
              isCompactLayout ? "left-3 top-3" : "left-6 top-6 sm:left-8 sm:top-7"
            )}
          >
            <Image
              src={isCompactLayout ? logoIcon : logoMark}
              alt="SovChat logo"
              width={isCompactLayout ? 32 : 154}
              height={isCompactLayout ? 32 : 40}
              priority
              className={cn(
                "h-auto object-contain opacity-95",
                isCompactLayout ? "w-8" : "w-[92px]"
              )}
            />
            <div className={cn("flex flex-col", isCompactLayout && "hidden")}>
              <button
                type="button"
                onClick={openVersionHighlights}
                className="version-indicator-button pointer-events-auto text-left text-[11px] tracking-[0.14em] text-white/34 transition hover:text-[#8cf4f7] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[rgba(126,227,231,0.55)]"
                aria-label="Open version highlights"
                title="Open version highlights"
              >
                {APP_BUILD_VERSION}
              </button>
            </div>
          </div>
        ) : null}

        {!shouldHidePrimaryDock ? (
          <div
            className={cn(
              "pointer-events-none fixed inset-x-0 z-30 flex justify-center px-6",
              isCompactLayout
                ? isDesktopShell
                  ? "top-[52px] px-14"
                  : "top-2 px-14"
                : isDesktopShell
                  ? "top-[44px]"
                  : "top-6 sm:top-7"
            )}
          >
            <div
              ref={roomSwitcherRef}
              className={cn(
                "pointer-events-auto relative flex justify-center",
                isCompactLayout ? "max-w-[min(62vw,18rem)]" : "max-w-[min(52vw,34rem)]"
              )}
            >
              <button
                type="button"
                onClick={() => setIsRoomSwitcherOpen((current) => !current)}
                className={cn(
                  "room-switcher-trigger flex w-full cursor-pointer items-center px-3 py-2 text-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[rgba(126,227,231,0.55)]",
                  isCompactLayout ? "flex-row justify-center gap-2" : "flex-col gap-2"
                )}
                aria-label="Open room switcher"
                aria-expanded={isRoomSwitcherOpen}
                aria-haspopup="menu"
              >
                <div className="room-switcher-emblem" aria-hidden="true">
                  <span className="room-switcher-emblem-face room-switcher-emblem-face-front">
                    {currentRoom?.avatarDataUrl ? (
                      <img src={currentRoom.avatarDataUrl} alt="" className="h-full w-full object-contain" />
                    ) : (
                      <span className="room-switcher-emblem-fallback">
                        {(currentRoom?.name ?? "?").slice(0, 2)}
                      </span>
                    )}
                  </span>
                  <span className="room-switcher-emblem-face room-switcher-emblem-face-back">
                    <ArrowLeftRight className="h-5 w-5" />
                  </span>
                </div>
                <div className="voice-lane-label-text truncate text-center">
                  {currentRoom?.name ?? (isRoomsLoading ? "Loading room" : "No room")}
                </div>
              </button>

              <AnimatePresence>
                {isRoomSwitcherOpen ? (
                  <motion.div
                    key="room-switcher"
                    initial={{ opacity: 0, y: -8, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -6, scale: 0.98 }}
                    transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                    className="absolute top-full mt-3 w-[min(26rem,calc(100vw-3rem))] overflow-hidden rounded-lg border border-white/10 bg-[rgba(13,22,25,0.96)] p-2 shadow-[0_20px_50px_rgba(0,0,0,0.35)] backdrop-blur-xl"
                    role="menu"
                    aria-label="Switch rooms"
                  >
                    <div className="px-2 pb-2 pt-1 text-[10px] uppercase tracking-[0.12em] text-white/45">
                      Quick switch
                    </div>
                    <div className="flex max-h-[min(22rem,48vh)] flex-col gap-1 overflow-y-auto">
                      {availableRooms.length > 0 ? (
                        availableRooms.map((room) => {
                          const isCurrent = room.id === currentRoom?.id;
                          return (
                            <button
                              key={room.id}
                              type="button"
                              role="menuitemradio"
                              aria-checked={isCurrent}
                              disabled={isRoomsPending || isCurrent}
                              onClick={() => {
                                setIsRoomSwitcherOpen(false);
                                if (!isCurrent) {
                                  void switchRoom(room.id);
                                }
                              }}
                              className={cn(
                                "flex items-center gap-3 rounded-lg px-3 py-2 text-left transition",
                                isCurrent
                                  ? "bg-white/8 text-white"
                                  : "text-white/78 hover:bg-white/6 hover:text-white",
                                isRoomsPending ? "cursor-wait" : "cursor-pointer"
                              )}
                            >
                              {room.avatarDataUrl ? (
                                <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-white/4">
                                  <img src={room.avatarDataUrl} alt="" className="h-full w-full object-contain" />
                                </div>
                              ) : (
                                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-white/5 text-xs uppercase tracking-[0.08em] text-white/42">
                                  {room.name.slice(0, 2)}
                                </div>
                              )}
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm">{room.name}</div>
                                <div className="truncate text-[11px] text-white/42">
                                  {room.isOwned ? "Your room" : `Code ${room.code}`}
                                </div>
                              </div>
                              <div className="flex h-5 w-5 items-center justify-center text-[rgba(126,227,231,0.9)]">
                                {isCurrent ? <Check className="h-4 w-4" /> : null}
                              </div>
                            </button>
                          );
                        })
                      ) : (
                        <div className="rounded-lg px-3 py-4 text-sm text-white/55">
                          No rooms available yet.
                        </div>
                      )}
                    </div>
                    <div className="mt-2 border-t border-white/8 pt-2">
                      <button
                        type="button"
                        onClick={openRoomSettings}
                        className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm text-white/76 transition hover:bg-white/6 hover:text-white"
                      >
                        <Settings className="h-4 w-4" />
                        Room settings
                      </button>
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
          </div>
        ) : null}

        <main
          className={cn(
            "overflow-hidden",
            isCompactLayout && isVoiceRoute
              ? isDesktopShell
                ? "h-[calc(100vh-48px)] px-0 pb-0 pt-0"
                : "h-[100dvh] px-0 pb-0 pt-0"
              : isDesktopVoiceLayout
              ? "h-[calc(100vh-48px)] px-0 pb-0 pt-0"
              : isWebStageChatLayout
                ? "h-screen px-0 pb-0 pt-0"
                : [
                    "px-4 lg:px-6",
                    isDockVisible ? "pb-24 lg:pb-28" : "pb-0",
                    isDesktopShell ? "pt-8 lg:pt-10" : "pt-20 lg:pt-24"
                  ]
          )}
        >
          <AnimatePresence
            initial={false}
            mode="wait"
            onExitComplete={() => {
              if (!isVoiceRoute) {
                setActivePrimaryView("voice");
              }
            }}
          >
            {!isVoiceRoute ? (
              <motion.div key="route-fallback" layout className="overflow-hidden" {...panelMotionProps}>
                {children}
              </motion.div>
            ) : null}
          </AnimatePresence>

          <VoiceRoom
            roomId={currentRoom?.id ?? null}
            userId={userId}
            nickname={displayName}
            roomName={currentRoom?.name ?? (isRoomsLoading ? "Loading room" : "No room")}
            fillerMode={Boolean(currentRoom?.fillerMode)}
            localAvatarSrc={avatarSrc}
            localAvatarId={profileState.avatarId}
            localAvatarDataUrl={profileState.avatarDataUrl}
            showMainPanel={isVoiceRoute && (activePrimaryView === "voice" || activePrimaryView === "chat")}
            compactMode={isCompactLayout}
            onPrimaryOverlayChange={setVoiceOverlayOpen}
            isChatPanelOpen={isVoiceRoute && activePrimaryView === "chat"}
            onWhisperParticipant={openWhisperTarget}
            chatPanelContent={
              isVoiceRoute ? (
                <ChatView
                  isOpen={activePrimaryView === "chat"}
                  onClose={() => setActivePrimaryView("voice")}
                  currentUserId={userId}
                  nickname={displayName}
                  currentRoom={roomState?.currentRoom ?? null}
                  roomMembers={roomState?.currentRoomMembers ?? []}
                  initialWhisperTarget={pendingWhisperTarget}
                  variant="stage"
                  compact={isCompactLayout}
                />
              ) : null
            }
            fallbackContent={
              isVoiceRoute ? (
                <AnimatePresence initial={false} mode="wait">
                  {activePrimaryView === "settings" ? (
                    <motion.div
                      key="settings-panel"
                      layout
                      className={cn("overflow-hidden", isCompactLayout && "h-full min-h-0")}
                      {...panelMotionProps}
                    >
                      <SettingsPanelBridge
                        isOpen
                        compact={isCompactLayout}
                        onClose={() => setActivePrimaryView("voice")}
                        activeTab={activeSettingsTab}
                        onActiveTabChange={setActiveSettingsTab}
                        currentRoom={roomState?.currentRoom ?? null}
                        ownedRoom={roomState?.ownedRoom ?? null}
                        joinedRooms={roomState?.joinedRooms ?? []}
                        ownedRoomMembers={roomState?.ownedRoomMembers ?? []}
                        ownedRoomBans={roomState?.ownedRoomBans ?? []}
                        isRoomsLoading={isRoomsLoading}
                        isRoomsPending={isRoomsPending}
                        roomsError={roomsError}
                        roomsStatus={roomsStatus}
                        onCreateOwnedRoom={async (name, code) => {
                          setActiveSettingsTab("rooms");
                          await mutateRooms({
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ action: "create", name, code })
                          }, `Created "${name.trim() || "room"}".`);
                        }}
                        onUpdateOwnedRoom={async (name, fillerMode, avatarDataUrl, dailyStreamLimitMinutes) => {
                          await mutateRooms({
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              action: "update-owned",
                              name,
                              fillerMode,
                              avatarDataUrl,
                              dailyStreamLimitMinutes
                            })
                          }, `Updated "${name.trim() || "your room"}".`);
                        }}
                        onResetOwnedRoomCode={async () => {
                          setActiveSettingsTab("rooms");
                          await mutateRooms({
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ action: "reset-owned-code" })
                          }, "Reset room code. New joins must use the updated code.");
                        }}
                        onResetOwnedRoomDailyStreamUsage={async () => {
                          setActiveSettingsTab("advanced");
                          await mutateRooms({
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ action: "reset-owned-stream-usage" })
                          }, "Reset today's stream usage for your room.");
                        }}
                        onJoinRoom={async (code) => {
                          setActiveSettingsTab("rooms");
                          await mutateRooms({
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ action: "join", code })
                          }, `Joined room with code ${code.trim().toUpperCase()}.`);
                        }}
                        onSwitchRoom={async (roomId) => {
                          setActiveSettingsTab("rooms");
                          await switchRoom(roomId);
                        }}
                        onRemoveRoom={async (roomId) => {
                          setActiveSettingsTab("rooms");
                          const targetRoom =
                            roomState?.ownedRoom?.id === roomId
                              ? roomState.ownedRoom
                              : roomState?.joinedRooms.find((room) => room.id === roomId) ?? null;
                          await mutateRooms({
                            method: "DELETE",
                            url: `/api/rooms?roomId=${encodeURIComponent(roomId)}`
                          }, targetRoom ? `Removed "${targetRoom.name}".` : "Removed room.");
                        }}
                        onRemoveOwnedRoomMember={async (userId) => {
                          const member = roomState?.ownedRoomMembers.find(
                            (candidate) => candidate.userId === userId
                          );
                          await mutateRooms({
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ action: "remove-owned-member", userId })
                          }, member ? `Removed ${member.nickname}.` : "Removed member.");
                        }}
                        onBanOwnedRoomMember={async (userId) => {
                          const member = roomState?.ownedRoomMembers.find(
                            (candidate) => candidate.userId === userId
                          );
                          await mutateRooms({
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ action: "ban-owned-member", userId })
                          }, member ? `Banned ${member.nickname}.` : "Banned member.");
                        }}
                        onUnbanOwnedRoomMember={async (userId) => {
                          const bannedUser = roomState?.ownedRoomBans.find(
                            (candidate) => candidate.userId === userId
                          );
                          await mutateRooms({
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ action: "unban-owned-member", userId })
                          }, bannedUser ? `Unbanned ${bannedUser.nickname}.` : "Unbanned member.");
                        }}
                      />
                    </motion.div>
                  ) : null}

                  {activePrimaryView === "version" ? (
                    <motion.div
                      key="version-highlights-panel"
                      layout
                      className={cn("overflow-hidden", isCompactLayout && "h-full min-h-0")}
                      {...panelMotionProps}
                    >
                      <VersionHighlightsPanel onClose={() => setActivePrimaryView("voice")} />
                    </motion.div>
                  ) : null}

                </AnimatePresence>
              ) : null
            }
          />
        </main>

        <AnimatePresence initial={false}>
          {roomsStatus ? (
            <motion.div
              key={roomsStatus}
              className={cn(
                "pointer-events-none fixed inset-x-0 z-40 flex justify-center px-4",
                isDockVisible ? "bottom-24 sm:bottom-28" : "bottom-5 sm:bottom-6"
              )}
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 14, scale: 0.98 }}
              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="max-w-[min(88vw,34rem)] rounded-full border border-[rgba(126,227,231,0.2)] bg-[rgba(28,40,45,0.92)] px-4 py-2.5 text-center text-sm text-[#baf6f7] shadow-[0_18px_60px_rgba(0,0,0,0.28),inset_0_1px_0_rgba(255,255,255,0.05)] backdrop-blur-xl">
                {roomsStatus}
              </div>
            </motion.div>
          ) : null}

          {isDockVisible && !isCompactLayout ? (
            <motion.div
              key="chat-fab"
              className="chat-fab-zone"
              data-chat-state={chatNotificationState}
              initial={{ opacity: 0, y: 24, scale: 0.92 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 24, scale: 0.92 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            >
              <span className="chat-fab-corner-glow" aria-hidden="true" />
              <HoverTooltip label="Room chat" className="chat-fab-tooltip">
                <button
                  type="button"
                  onClick={openChatPanel}
                  className="chat-fab-button"
                  aria-label={chatLauncherLabel}
                >
                  <ChatRoundLineIcon />
                </button>
              </HoverTooltip>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {isDockVisible ? (
            <motion.div
              key={isCompactLayout ? "primary-dock-compact" : "primary-dock-expanded"}
              className={cn(
                "pointer-events-none inset-x-0 z-30 flex justify-center",
                isCompactLayout
                  ? "fixed bottom-0"
                  : "absolute bottom-[-5px] px-4"
              )}
              initial={{ opacity: 0, y: 28, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 28, scale: 0.96 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
              {isCompactLayout ? (
                <div className="compact-primary-dock pointer-events-auto flex w-full items-center gap-2 px-2 py-2">
                  <button
                    type="button"
                    onClick={() => {
                      setActivePrimaryView("voice");
                      setAvatarOpen(true);
                    }}
                    className="compact-profile-trigger flex min-w-0 flex-1 items-center gap-2 rounded-full p-1.5 pr-3 text-left transition hover:bg-white/5"
                    aria-label="Open avatar settings"
                  >
                    <span className="relative h-9 w-9 shrink-0">
                      <img src={avatarSrc} alt="" className="h-full w-full rounded-full object-contain" />
                      <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border-2 border-[#173034] bg-[#4cb36b]" />
                    </span>
                    <span className="min-w-0 truncate text-sm text-white/86">{displayName}</span>
                  </button>

                  <div className="flex shrink-0 items-center gap-0.5">
                    <HoverTooltip label="Room chat">
                      <button
                        type="button"
                        onClick={openChatPanel}
                        className={cn(
                          "compact-dock-button user-dock-action user-dock-action-chat",
                          chatNotificationState !== "default" && "compact-dock-button-notified"
                        )}
                        aria-label={chatLauncherLabel}
                      >
                        <OmarchyGlyph kind="chat" className="omarchy-mode-icon h-5 w-5" />
                      </button>
                    </HoverTooltip>

                    <HoverTooltip label={audioState.inputMuted ? "Unmute microphone" : "Mute microphone"}>
                      <button
                        type="button"
                        onClick={() => controller.setInputMuted(!audioState.inputMuted)}
                        className={cn(
                          "compact-dock-button user-dock-action",
                          audioState.inputMuted && "compact-dock-button-danger user-dock-action-danger"
                        )}
                        aria-label={audioState.inputMuted ? "Unmute microphone" : "Mute microphone"}
                      >
                        <OmarchyGlyph
                          kind={audioState.inputMuted ? "microphone-off" : "microphone"}
                          className="omarchy-mode-icon h-5 w-5"
                        />
                      </button>
                    </HoverTooltip>

                    <HoverTooltip label={audioState.outputMuted ? "Unmute speakers" : "Mute speakers"}>
                      <button
                        type="button"
                        onClick={() => controller.setOutputMuted(!audioState.outputMuted)}
                        className={cn(
                          "compact-dock-button user-dock-action",
                          audioState.outputMuted && "compact-dock-button-danger user-dock-action-danger"
                        )}
                        aria-label={audioState.outputMuted ? "Unmute speakers" : "Mute speakers"}
                      >
                        <OmarchyGlyph
                          kind={audioState.outputMuted ? "headphones-off" : "headphones"}
                          className="omarchy-mode-icon h-5 w-5"
                        />
                      </button>
                    </HoverTooltip>

                    <HoverTooltip label="Settings">
                      <button
                        type="button"
                        onClick={() => {
                          setAvatarOpen(false);
                          setActivePrimaryView("settings");
                        }}
                        className="compact-dock-button user-dock-action"
                        aria-label="Open settings"
                      >
                        <OmarchyGlyph kind="settings" className="omarchy-mode-icon h-5 w-5" />
                      </button>
                    </HoverTooltip>
                  </div>
                </div>
              ) : (
              <div
                ref={primaryDockRef}
                className="primary-user-dock pointer-events-auto flex w-fit max-w-[92vw] translate-y-[2px] items-center gap-8 px-[154px] pb-3.5 pt-2.5 sm:gap-10 sm:px-[186px]"
              >
                <svg
                  className="primary-user-dock-skin"
                  viewBox={`0 0 ${primaryDockShellWidth} ${primaryDockShellHeight}`}
                  preserveAspectRatio="none"
                  aria-hidden="true"
                  focusable="false"
                >
                  <defs>
                    <filter
                      id="primary-user-dock-inner-shadow"
                      x="-20%"
                      y="-80%"
                      width="140%"
                      height="260%"
                      colorInterpolationFilters="sRGB"
                    >
                      <feOffset in="SourceAlpha" dx="0" dy="10" result="offset" />
                      <feGaussianBlur in="offset" stdDeviation="16" result="blur" />
                      <feComposite in="SourceAlpha" in2="blur" operator="out" result="edge-fade" />
                      <feComposite in="edge-fade" in2="SourceAlpha" operator="in" result="inner-shadow" />
                      <feFlood floodColor="#07181B" floodOpacity="0.32" result="shadow-color" />
                      <feComposite in="shadow-color" in2="inner-shadow" operator="in" result="shadow" />
                      <feComposite in="shadow" in2="SourceGraphic" operator="over" />
                    </filter>
                  </defs>
                  <path
                    d={primaryDockShellPath}
                    className="primary-user-dock-fill"
                    fill="#12292D"
                    filter="url(#primary-user-dock-inner-shadow)"
                  />
                </svg>
            <button
              type="button"
              onClick={() => {
                setActivePrimaryView("voice");
                setAvatarOpen(true);
              }}
              className="profile-trigger flex min-w-0 cursor-pointer items-center gap-3 text-left"
              aria-label="Open avatar settings"
            >
              <div className="profile-trigger-emblem" aria-hidden="true">
                <span className="profile-trigger-emblem-face profile-trigger-emblem-face-front">
                  <img src={avatarSrc} alt="" className="h-full w-full rounded-full object-contain" />
                </span>
                <span className="profile-trigger-emblem-face profile-trigger-emblem-face-back">
                  <Pencil className="h-4.5 w-4.5" strokeWidth={2.2} />
                </span>
                <span className="absolute bottom-0 right-0 h-3.5 w-3.5 translate-x-[10%] translate-y-[10%] rounded-full border-2 border-[rgba(42,58,63,0.95)] bg-[#4cb36b]" />
              </div>

              <div className="min-w-0 self-center">
                <p className="truncate text-[0.98rem] font-normal leading-none text-white/86 sm:text-[1.05rem]">
                  {displayName}
                </p>
              </div>
            </button>

            <div className="flex items-center gap-0.5 sm:gap-1">
              <HoverTooltip label={audioState.inputMuted ? "Unmute microphone" : "Mute microphone"}>
                <button
                  type="button"
                  onClick={(event) => {
                    event.currentTarget.blur();
                    const nextValue = !audioState.inputMuted;
                    controller.setInputMuted(nextValue);
                  }}
                  aria-label={audioState.inputMuted ? "Unmute microphone" : "Mute microphone"}
                  className={cn(
                    "user-dock-action inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-full transition",
                    audioState.inputMuted
                      ? "user-dock-action-danger text-[var(--danger)] drop-shadow-[0_0_8px_rgba(255,123,123,0.2)] hover:text-[#ff9a9a]"
                      : "text-[var(--muted)] hover:text-[var(--accent)]"
                  )}
                >
                  <OmarchyGlyph
                    kind={audioState.inputMuted ? "microphone-off" : "microphone"}
                    className="omarchy-mode-icon h-5 w-5"
                  />
                </button>
              </HoverTooltip>

              <HoverTooltip label={audioState.outputMuted ? "Unmute speakers" : "Mute speakers"}>
                <button
                  type="button"
                  onClick={(event) => {
                    event.currentTarget.blur();
                    const nextValue = !audioState.outputMuted;
                    controller.setOutputMuted(nextValue);
                  }}
                  aria-label={audioState.outputMuted ? "Unmute speakers" : "Mute speakers"}
                  className={cn(
                    "user-dock-action inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-full transition",
                    audioState.outputMuted
                      ? "user-dock-action-danger text-[var(--danger)] drop-shadow-[0_0_8px_rgba(255,123,123,0.2)] hover:text-[#ff9a9a]"
                      : "text-[var(--muted)] hover:text-[var(--accent)]"
                  )}
                >
                  <OmarchyGlyph
                    kind={audioState.outputMuted ? "headphones-off" : "headphones"}
                    className="omarchy-mode-icon h-5 w-5"
                  />
                </button>
              </HoverTooltip>

              <HoverTooltip label="Settings">
                <button
                  type="button"
                  onClick={() => {
                    setAvatarOpen(false);
                    setActivePrimaryView("settings");
                  }}
                  className="user-dock-action inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-full border border-transparent text-[var(--muted)] transition hover:bg-white/6 hover:text-[var(--accent)]"
                  aria-label="Open settings"
                >
                  <OmarchyGlyph kind="settings" className="omarchy-mode-icon h-5 w-5" />
                </button>
              </HoverTooltip>
            </div>
              </div>
              )}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      <AvatarDrawer
        isOpen={avatarOpen}
        onClose={() => setAvatarOpen(false)}
        nickname={displayName}
        avatarId={profileState.avatarId}
        avatarDataUrl={profileState.avatarDataUrl}
        onProfileChange={(nextState) => profileSettingsStore.patch(nextState)}
        onLogout={handleLogout}
      />
      <RoomOnboardingModal
        isOpen={Boolean(roomState?.needsRoomSetup)}
        nickname={displayName}
        isPending={isRoomsPending}
        error={roomsError}
        onCreateRoom={async (name, code) => {
          await mutateRooms({
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "create", name, code })
          });
        }}
        onJoinRoom={async (code) => {
          await mutateRooms({
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "join", code })
          });
        }}
      />
    </>
  );
}
