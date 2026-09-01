"use client";

import type { CSSProperties, ChangeEvent } from "react";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowRightLeft,
  Ban,
  BarChart3,
  Check,
  ChevronDown,
  Clipboard,
  Copy,
  Download,
  Gauge,
  House,
  Image,
  LogIn,
  Mic,
  Monitor,
  MonitorUp,
  Plus,
  Palette,
  RefreshCcw,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
  UserMinus,
  Users,
  Volume2,
  Wrench,
} from "lucide-react";
import { PrimaryPanelShell } from "@/components/primary-panel-shell";
import { resolveHostedAppUrl } from "@/lib/api-client";
import type { DesktopUpdateState } from "@/lib/desktop";
import type { SovChatAudioProfile } from "@/lib/audio/audio-types";
import { cn } from "@/lib/utils";
import { APP_THEMES, themeStore } from "@/lib/theme-store";
import type { LiveKitUsageSummary, RoomBanSummary, RoomMemberSummary, RoomSummary } from "@/types";

type DeviceOption = {
  deviceId: string;
  label: string;
};

type SettingsTab = "audio" | "appearance" | "rooms" | "livekit-usage" | "developer" | "advanced";
type RoomSubTab = "my-room" | "members" | "joined";
type RoomMemberView = "active" | "banned";

type SettingsPanelProps = {
  isOpen: boolean;
  compact?: boolean;
  onClose: () => void;
  activeTab: SettingsTab;
  onActiveTabChange: (tab: SettingsTab) => void;
  inputDevices: DeviceOption[];
  outputDevices: DeviceOption[];
  selectedInputId: string;
  selectedOutputId: string;
  inputMuted: boolean;
  noiseFilterEnabled: boolean;
  audioProfile: SovChatAudioProfile;
  noiseFloorWarning: string | null;
  inputGain: number;
  outputVolume: number;
  outputSwitchSupported: boolean;
  performanceModeForced: boolean;
  performanceModeAutoActive: boolean;
  startWithWindows: boolean;
  closeToTray: boolean;
  afkLeaveMinutes: number;
  isDesktop: boolean;
  desktopUpdateState: DesktopUpdateState | null;
  isCheckingForUpdates: boolean;
  isExportingClientDiagnostics: boolean;
  clientDiagnosticsStatus: string | null;
  deviceLabelsUnlocked: boolean;
  isUnlockingDeviceLabels: boolean;
  currentRoom: RoomSummary | null;
  ownedRoom: RoomSummary | null;
  joinedRooms: RoomSummary[];
  ownedRoomMembers: RoomMemberSummary[];
  ownedRoomBans: RoomBanSummary[];
  isRoomsLoading: boolean;
  isRoomsPending: boolean;
  roomsError: string | null;
  roomsStatus: string | null;
  liveKitUsage: LiveKitUsageSummary | null;
  liveKitUsageMonth: string;
  isLiveKitUsageLoading: boolean;
  liveKitUsageError: string | null;
  onInputChange: (value: string) => void;
  onOutputChange: (value: string) => void;
  onInputMutedChange: (value: boolean) => void;
  onNoiseFilterEnabledChange: (value: boolean) => void;
  onAudioProfileChange: (value: SovChatAudioProfile) => void;
  onInputGainChange: (value: number) => void;
  onOutputVolumeChange: (value: number) => void;
  onPerformanceModeChange: (value: boolean) => void;
  onStartWithWindowsChange: (value: boolean) => void;
  onCloseToTrayChange: (value: boolean) => void;
  onAfkLeaveMinutesChange: (value: number) => void;
  onCheckForUpdates: () => Promise<void> | void;
  onExportClientDiagnostics?: (() => Promise<void> | void) | undefined;
  onLiveKitUsageMonthChange: (month: string) => void;
  onUnlockDeviceLabels: () => void;
  onCreateOwnedRoom: (name: string, code: string) => Promise<void> | void;
  onUpdateOwnedRoom: (
    name: string,
    fillerMode: boolean,
    avatarDataUrl?: string | null,
    dailyStreamLimitMinutes?: number
  ) => Promise<void> | void;
  onResetOwnedRoomCode: () => Promise<void> | void;
  onResetOwnedRoomDailyStreamUsage: () => Promise<void> | void;
  onJoinRoom: (code: string) => Promise<void> | void;
  onSwitchRoom: (roomId: string) => Promise<void> | void;
  onRemoveRoom: (roomId: string) => Promise<void> | void;
  onRemoveOwnedRoomMember: (userId: string) => Promise<void> | void;
  onBanOwnedRoomMember: (userId: string) => Promise<void> | void;
  onUnbanOwnedRoomMember: (userId: string) => Promise<void> | void;
  isClearingDesktopCache?: boolean;
  onClearDesktopCache?: (() => Promise<void> | void) | undefined;
};

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_CTA_CLASS =
  "ui-button inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm text-white/84 transition duration-150 hover:border-white/16 hover:bg-white/7 hover:text-white disabled:cursor-not-allowed disabled:opacity-55";
const ROOM_SWITCH_CTA_CLASS =
  "ui-button inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm text-white/84 transition duration-150 hover:border-[rgba(113,220,225,0.34)] hover:bg-[rgba(113,220,225,0.1)] hover:text-white hover:shadow-[0_10px_24px_rgba(113,220,225,0.08)] disabled:cursor-not-allowed disabled:opacity-55";
const ROOM_DANGER_CTA_CLASS =
  "ui-button inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm text-white/84 transition duration-150 hover:border-[rgba(255,123,123,0.36)] hover:bg-[rgba(255,123,123,0.1)] hover:text-[#ffb8b8] hover:shadow-[0_10px_24px_rgba(255,123,123,0.08)] disabled:cursor-not-allowed disabled:opacity-55";
const ICON_BUTTON_CLASS =
  "inline-flex h-8 w-8 items-center justify-center rounded-full text-white/48 transition hover:bg-white/6 hover:text-white";

async function fileToDataUrl(file: File) {
  const imageBitmap = await createImageBitmap(file);
  const size = 320;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext("2d");
  if (!context) {
    imageBitmap.close();
    throw new Error("Canvas is not available in this browser.");
  }

  const scale = Math.min(size / imageBitmap.width, size / imageBitmap.height);
  const drawWidth = Math.max(1, Math.round(imageBitmap.width * scale));
  const drawHeight = Math.max(1, Math.round(imageBitmap.height * scale));
  const dx = (size - drawWidth) / 2;
  const dy = (size - drawHeight) / 2;

  context.clearRect(0, 0, size, size);
  context.drawImage(imageBitmap, dx, dy, drawWidth, drawHeight);
  imageBitmap.close();

  return canvas.toDataURL("image/webp", 0.92);
}

function generateRoomCode() {
  return Array.from({ length: 8 }, () => {
    const index = Math.floor(Math.random() * ROOM_CODE_ALPHABET.length);
    return ROOM_CODE_ALPHABET[index];
  }).join("");
}

function DeviceSelect({
  value,
  options,
  onChange,
  placeholder
}: {
  value: string;
  options: DeviceOption[];
  onChange: (value: string) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedLabel = options.find((device) => device.deviceId === value)?.label ?? placeholder;

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        className={`ui-input flex w-full items-center justify-between gap-3 rounded-xl px-4 py-3 text-left transition hover:border-white/16 hover:bg-white/[0.05] ${
          open ? "border-white/18 bg-white/[0.06]" : ""
        }`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="truncate text-white/92">{selectedLabel}</span>
        <ChevronDown
          className={`h-4 w-4 flex-shrink-0 text-white/72 transition ${open ? "rotate-180" : ""}`}
        />
      </button>

      <div
        className={`absolute left-0 right-0 top-[calc(100%+10px)] z-20 origin-top rounded-[1rem] border border-white/12 bg-[rgba(31,44,49,0.98)] p-2 shadow-[0_20px_50px_rgba(0,0,0,0.32)] backdrop-blur-xl transition duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          open
            ? "pointer-events-auto translate-y-0 scale-100 opacity-100"
            : "pointer-events-none -translate-y-1 scale-[0.98] opacity-0"
        }`}
        role="listbox"
        aria-hidden={!open}
      >
        <div className="max-h-56 overflow-y-auto">
          {options.map((device) => {
            const selected = device.deviceId === value;

            return (
              <button
                key={device.deviceId}
                type="button"
                onClick={() => {
                  onChange(device.deviceId);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition hover:bg-white/[0.08] ${
                  selected ? "bg-[rgba(113,220,225,0.16)] text-white" : "text-white/84"
                }`}
                role="option"
                aria-selected={selected}
              >
                <span className="min-w-0 flex-1 truncate">{device.label}</span>
                {selected ? <Check className="h-4 w-4 flex-shrink-0 text-[#71dce1]" /> : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function VolumeSlider({
  value,
  onChange,
  minPercent = 0,
  maxPercent = 200,
  snapAtPercent,
  showMidpoint = false,
  disabled = false
}: {
  value: number;
  onChange: (value: number) => void;
  minPercent?: number;
  maxPercent?: number;
  snapAtPercent?: number;
  showMidpoint?: boolean;
  disabled?: boolean;
}) {
  const percent = Math.max(minPercent, Math.min(maxPercent, Math.round(value * 100)));
  const fillPercent = Math.max(0, Math.min(100, (percent / maxPercent) * 100));
  const midpointPercent = maxPercent > 100 ? (100 / maxPercent) * 100 : 50;
  const midpointLeft = `calc(${midpointPercent}% + ${(0.5 - midpointPercent / 100) * 18}px)`;

  function handleChange(nextPercent: number) {
    const snappedPercent =
      typeof snapAtPercent === "number" && Math.abs(nextPercent - snapAtPercent) <= 4
        ? snapAtPercent
        : nextPercent;

    onChange(snappedPercent / 100);
  }

  return (
    <div className="relative px-1 pt-8">
      <div
        className="ui-slider__value"
        style={
          {
            left: `clamp(24px, calc(${fillPercent}% + ${(0.5 - fillPercent / 100) * 18}px), calc(100% - 24px))`
          } satisfies CSSProperties
        }
      >
        {percent}%
      </div>
      <div className="relative">
        <input
          type="range"
          min={minPercent}
          max={maxPercent}
          value={percent}
          disabled={disabled}
          onChange={(event) => handleChange(Number(event.target.value))}
          className="ui-slider"
          style={{ "--slider-fill": `${fillPercent}%` } as CSSProperties}
        />
        {showMidpoint ? (
          <div
            className="ui-slider__midpoint"
            style={{ left: midpointLeft } as CSSProperties}
            aria-hidden="true"
          />
        ) : null}
      </div>
    </div>
  );
}

function PageLabel({ children }: { children: string }) {
  return (
    <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--accent)]">
      {children}
    </p>
  );
}

function SectionCard({
  icon: Icon,
  title,
  actions,
  separated = false,
  dense = false,
  className,
  children
}: {
  icon: typeof Mic;
  title: string;
  actions?: React.ReactNode;
  separated?: boolean;
  dense?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("settings-section-card", separated && "border-t border-white/8 pt-8", className)}>
      <div className={cn("settings-section-card-header flex items-center justify-between gap-3", dense ? "mb-2" : "mb-5")}>
        <div className="flex items-center gap-3">
          <span className={cn("flex items-center justify-center rounded-lg bg-white/[0.04] text-[var(--accent)]", dense ? "h-8 w-8" : "h-10 w-10")}>
            <Icon className={dense ? "h-4 w-4" : "h-5 w-5"} />
          </span>
          <p className="text-sm font-medium text-white">{title}</p>
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

function ToggleControl({
  checked,
  onChange,
  label,
  badge,
  description,
  disabled = false
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  badge?: string | null;
  description?: string | null;
  disabled?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-4 rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3 ${
        disabled ? "opacity-62" : ""
      }`}
    >
      <div className="min-w-0">
        <div className="text-sm text-white">{label}</div>
        {description ? (
          <div className="mt-1 text-xs leading-5 text-white/48">{description}</div>
        ) : null}
        {badge ? (
          <div className="mt-1 text-[11px] uppercase tracking-[0.16em] text-[var(--accent)]">
            {badge}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="relative inline-flex h-7 w-12 shrink-0 items-center rounded-full bg-white/10 transition hover:bg-white/14 disabled:cursor-not-allowed disabled:hover:bg-white/10 data-[checked=true]:bg-[rgba(255,202,42,0.32)]"
        data-checked={checked}
      >
        <span
          className={`absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow-[0_4px_12px_rgba(0,0,0,0.22)] transition ${
            checked ? "translate-x-5 bg-[var(--accent)]" : ""
          }`}
        />
      </button>
    </div>
  );
}

function formatJoinedDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric"
  }).format(new Date(value));
}

function getAvatarSrc(profile: {
  avatarId: string;
  avatarDataUrl: string | null;
}) {
  return profile.avatarDataUrl || `/avatars/${profile.avatarId}.png`;
}

function sortRooms(
  rooms: RoomSummary[],
  currentRoom: RoomSummary | null,
  ownedRoom: RoomSummary | null
) {
  const unique = new Map<string, RoomSummary>();

  for (const room of rooms) {
    unique.set(room.id, room);
  }

  const rest = Array.from(unique.values()).filter(
    (room) => room.id !== currentRoom?.id && room.id !== ownedRoom?.id
  );
  rest.sort((left, right) => right.lastVisitedAt.localeCompare(left.lastVisitedAt));

  const ordered: RoomSummary[] = [];

  if (currentRoom) {
    ordered.push(currentRoom);
  }

  if (ownedRoom && ownedRoom.id !== currentRoom?.id) {
    ordered.push(ownedRoom);
  }

  ordered.push(...rest);
  return ordered;
}

function RoomsTab({
  currentRoom,
  ownedRoom,
  joinedRooms,
  ownedRoomMembers,
  ownedRoomBans,
  isRoomsLoading,
  isRoomsPending,
  roomsError,
  roomsStatus,
  onCreateOwnedRoom,
  onUpdateOwnedRoom,
  onResetOwnedRoomCode,
  onJoinRoom,
  onSwitchRoom,
  onRemoveRoom,
  onRemoveOwnedRoomMember,
  onBanOwnedRoomMember,
  onUnbanOwnedRoomMember
}: Pick<
  SettingsPanelProps,
  | "currentRoom"
  | "ownedRoom"
  | "joinedRooms"
  | "ownedRoomMembers"
  | "ownedRoomBans"
  | "isRoomsLoading"
  | "isRoomsPending"
  | "roomsError"
  | "roomsStatus"
  | "onCreateOwnedRoom"
  | "onUpdateOwnedRoom"
  | "onResetOwnedRoomCode"
  | "onJoinRoom"
  | "onSwitchRoom"
  | "onRemoveRoom"
  | "onRemoveOwnedRoomMember"
  | "onBanOwnedRoomMember"
  | "onUnbanOwnedRoomMember"
>) {
  const [activeRoomSubTab, setActiveRoomSubTab] = useState<RoomSubTab>("my-room");
  const [activeRoomMemberView, setActiveRoomMemberView] = useState<RoomMemberView>("active");
  const [joinCode, setJoinCode] = useState("");
  const [createName, setCreateName] = useState("");
  const [createCode, setCreateCode] = useState("");
  const [ownedRoomName, setOwnedRoomName] = useState(ownedRoom?.name ?? "");
  const [isOwnedRoomNameDirty, setIsOwnedRoomNameDirty] = useState(false);
  const [ownedRoomAvatarError, setOwnedRoomAvatarError] = useState<string | null>(null);
  const [isOwnedRoomAvatarPending, setIsOwnedRoomAvatarPending] = useState(false);
  const ownedRoomFileInputId = useId();
  const ownedRoomFileInputRef = useRef<HTMLInputElement>(null);
  const lastOwnedRoomSnapshotRef = useRef<{ id: string | null; name: string }>({
    id: ownedRoom?.id ?? null,
    name: ownedRoom?.name ?? ""
  });
  const pendingOwnedRoomSaveNameRef = useRef<string | null>(null);

  useEffect(() => {
    if (!ownedRoom) {
      setCreateCode((previous) => previous || generateRoomCode());
    }
  }, [ownedRoom]);

  useEffect(() => {
    const nextId = ownedRoom?.id ?? null;
    const nextName = ownedRoom?.name ?? "";
    const previous = lastOwnedRoomSnapshotRef.current;
    const roomChanged = previous.id !== nextId;
    const serverNameChanged = previous.name !== nextName;
    const savedNameApplied =
      pendingOwnedRoomSaveNameRef.current !== null &&
      pendingOwnedRoomSaveNameRef.current === nextName;

    if (!ownedRoom) {
      setOwnedRoomName("");
      setIsOwnedRoomNameDirty(false);
      setOwnedRoomAvatarError(null);
      pendingOwnedRoomSaveNameRef.current = null;
    } else if (roomChanged || savedNameApplied || (!isOwnedRoomNameDirty && serverNameChanged)) {
      setOwnedRoomName(nextName);
      setIsOwnedRoomNameDirty(false);

      if (savedNameApplied) {
        pendingOwnedRoomSaveNameRef.current = null;
      }
    }

    lastOwnedRoomSnapshotRef.current = {
      id: nextId,
      name: nextName
    };
  }, [ownedRoom?.id, ownedRoom?.name, isOwnedRoomNameDirty]);

  const orderedRooms = useMemo(
    () => sortRooms([...(ownedRoom ? [ownedRoom] : []), ...joinedRooms], currentRoom, ownedRoom),
    [currentRoom, joinedRooms, ownedRoom]
  );
  const sortedOwnedRoomMembers = useMemo(
    () =>
      [...ownedRoomMembers].sort((left, right) =>
        left.nickname.localeCompare(right.nickname, undefined, { sensitivity: "base" })
      ),
    [ownedRoomMembers]
  );
  const sortedOwnedRoomBans = useMemo(
    () =>
      [...ownedRoomBans].sort((left, right) =>
        left.nickname.localeCompare(right.nickname, undefined, { sensitivity: "base" })
      ),
    [ownedRoomBans]
  );

  function handleOwnedRoomNameSave() {
    if (!ownedRoomName.trim() || !ownedRoom || isRoomsPending || isOwnedRoomAvatarPending) {
      return;
    }

    pendingOwnedRoomSaveNameRef.current = ownedRoomName.trim();
    void onUpdateOwnedRoom(
      ownedRoomName,
      ownedRoom.fillerMode,
      ownedRoom.avatarDataUrl,
      ownedRoom.dailyStreamLimitMinutes
    );
  }

  async function handlePasteJoinCode() {
    if (!navigator.clipboard?.readText) {
      return;
    }

    const pasted = await navigator.clipboard.readText().catch(() => "");
    if (pasted) {
      setJoinCode(pasted.trim().toUpperCase());
    }
  }

  async function handleOwnedRoomAvatarUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file || !ownedRoom) {
      return;
    }

    if (!file.type.startsWith("image/")) {
      setOwnedRoomAvatarError("Choose an image file for the room image.");
      return;
    }

    setOwnedRoomAvatarError(null);
    setIsOwnedRoomAvatarPending(true);

    try {
      const avatarDataUrl = await fileToDataUrl(file);
      pendingOwnedRoomSaveNameRef.current = ownedRoomName.trim();
      await onUpdateOwnedRoom(
        ownedRoomName,
        ownedRoom.fillerMode,
        avatarDataUrl,
        ownedRoom.dailyStreamLimitMinutes
      );
      setIsOwnedRoomNameDirty(false);
      setOwnedRoomAvatarError(null);
    } catch (error) {
      setOwnedRoomAvatarError(
        error instanceof Error ? error.message : "Unable to update the room image."
      );
    } finally {
      setIsOwnedRoomAvatarPending(false);
    }
  }

  async function handleOwnedRoomAvatarReset() {
    if (!ownedRoom) {
      return;
    }

    setOwnedRoomAvatarError(null);
    setIsOwnedRoomAvatarPending(true);

    try {
      pendingOwnedRoomSaveNameRef.current = ownedRoomName.trim();
      await onUpdateOwnedRoom(
        ownedRoomName,
        ownedRoom.fillerMode,
        null,
        ownedRoom.dailyStreamLimitMinutes
      );
      setIsOwnedRoomNameDirty(false);
      setOwnedRoomAvatarError(null);
      ownedRoomFileInputRef.current?.focus();
    } catch (error) {
      setOwnedRoomAvatarError(
        error instanceof Error ? error.message : "Unable to remove the room image."
      );
    } finally {
      setIsOwnedRoomAvatarPending(false);
    }
  }

  return (
    <div className="space-y-8">
      <PageLabel>Rooms</PageLabel>

      {roomsError ? (
        <div className="rounded-xl border border-[color:rgba(255,123,123,0.22)] bg-[color:rgba(255,123,123,0.08)] px-4 py-3 text-sm text-[var(--danger)]">
          {roomsError}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2 border-b border-white/8 pb-3">
        {[
          { id: "my-room", label: "My room" },
          { id: "members", label: "Members" },
          { id: "joined", label: "Joined rooms" }
        ].map((tab) => {
          const isActive = activeRoomSubTab === tab.id;

          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveRoomSubTab(tab.id as RoomSubTab)}
              className={`rounded-lg border px-4 py-2 text-sm font-medium transition ${
                isActive
                  ? "border-[rgba(113,220,225,0.24)] bg-[rgba(113,220,225,0.1)] text-white"
                  : "border-white/8 bg-white/[0.02] text-white/62 hover:border-white/14 hover:bg-white/[0.05] hover:text-white"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeRoomSubTab === "my-room" ? (
        <div className="settings-room-columns grid gap-10">
          {!ownedRoom ? (
            <SectionCard icon={Plus} title="Create room">
              <div className="settings-create-room-grid grid gap-5">
                <label className="block">
                  <span className="mb-2 block text-xs uppercase tracking-[0.18em] text-white/48">Name</span>
                  <input
                    value={createName}
                    onChange={(event) => setCreateName(event.target.value)}
                    maxLength={32}
                    className="ui-input w-full rounded-xl px-4 py-3 text-white outline-none transition"
                  />
                </label>
                <label className="block">
                  <span className="mb-2 block text-xs uppercase tracking-[0.18em] text-white/48">Code</span>
                  <span className="relative block">
                    <input
                      value={createCode}
                      onChange={(event) => setCreateCode(event.target.value.toUpperCase())}
                      maxLength={12}
                      className="ui-input w-full rounded-xl px-4 py-3 pr-12 uppercase tracking-[0.18em] text-white outline-none transition"
                    />
                    <button
                      type="button"
                      onClick={() => setCreateCode(generateRoomCode())}
                      className={`${ICON_BUTTON_CLASS} absolute right-2 top-1/2 -translate-y-1/2`}
                      aria-label="Generate room code"
                    >
                      <RefreshCw className="h-4 w-4" />
                    </button>
                  </span>
                </label>
              </div>
              <button
                type="button"
                disabled={isRoomsPending}
                onClick={() => void onCreateOwnedRoom(createName, createCode)}
                className={`mt-4 ${ROOM_CTA_CLASS}`}
              >
                <House className="h-4 w-4" />
                Create room
              </button>
            </SectionCard>
          ) : (
            <>
              <SectionCard icon={House} title="Room identity" className="settings-room-identity-card">
              <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
                <div className="flex flex-shrink-0 flex-col items-start">
                  {ownedRoom.avatarDataUrl ? (
                    <div className="relative pb-3">
                      <div className="relative flex h-20 w-20 items-center justify-center overflow-hidden rounded-[1.1rem]">
                        <img
                          src={ownedRoom.avatarDataUrl}
                          alt=""
                          className="h-full w-full object-contain"
                        />
                      </div>

                      <div className="absolute inset-x-0 bottom-0 flex justify-center">
                        <div className="flex items-center gap-1 rounded-full border border-white/10 bg-[rgba(29,41,46,0.94)] px-1.5 py-1 shadow-[0_10px_28px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-xl">
                        <label
                          htmlFor={ownedRoomFileInputId}
                            className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-full bg-white/8 text-white/82 transition hover:bg-[var(--accent)] hover:text-[#122226]"
                          aria-label="Replace room image"
                        >
                            <Plus className="h-3.5 w-3.5" />
                        </label>
                        <button
                          type="button"
                          disabled={isRoomsPending || isOwnedRoomAvatarPending}
                          onClick={() => void handleOwnedRoomAvatarReset()}
                            className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[rgba(255,91,111,0.9)] text-white transition hover:bg-[rgba(255,79,101,1)] disabled:cursor-not-allowed disabled:opacity-55"
                          aria-label="Remove room image"
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      </div>
                    </div>
                  ) : (
                    <div className="relative pb-3">
                      <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-[1.1rem] border border-dashed border-white/14 bg-[linear-gradient(135deg,rgba(22,37,43,0.74)_0%,rgba(32,55,63,0.78)_52%,rgba(19,31,36,0.86)_100%)] text-white/38 shadow-[0_10px_30px_rgba(0,0,0,0.14),inset_0_1px_0_rgba(255,255,255,0.05)]">
                        <Image className="h-6 w-6" />
                      </div>
                      <div className="absolute inset-x-0 bottom-0 flex justify-center">
                        <label
                          htmlFor={ownedRoomFileInputId}
                          className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border border-white/10 bg-[rgba(29,41,46,0.94)] text-white/88 shadow-[0_10px_28px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-xl transition hover:border-[var(--accent)] hover:bg-[var(--accent)] hover:text-[#122226]"
                          aria-label="Add room image"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </label>
                      </div>
                    </div>
                  )}
                </div>

                <div className="min-w-0 flex-1 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs uppercase tracking-[0.18em] text-white/48">Room name</p>
                      <p className="mt-1 text-sm text-white/46">
                        Update how your room appears across the app.
                      </p>
                    </div>
                    {currentRoom?.id !== ownedRoom.id ? (
                      <button
                        type="button"
                        disabled={isRoomsPending}
                        onClick={() => void onSwitchRoom(ownedRoom.id)}
                        className={`${ICON_BUTTON_CLASS} ui-button h-10 w-10 rounded-xl border border-white/10 text-white/78 hover:border-white/16 hover:text-white disabled:cursor-not-allowed disabled:opacity-55`}
                        aria-label="Switch to your room"
                      >
                        <ArrowRightLeft className="h-4 w-4" />
                      </button>
                    ) : null}
                  </div>

                  <label className="block">
                    <span className="relative block">
                      <input
                        value={ownedRoomName}
                        onChange={(event) => {
                          setOwnedRoomName(event.target.value);
                          setIsOwnedRoomNameDirty(true);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && isOwnedRoomNameDirty) {
                            event.preventDefault();
                            handleOwnedRoomNameSave();
                          }
                        }}
                        maxLength={32}
                        className="ui-input w-full rounded-xl px-4 py-3 pr-12 text-white outline-none transition"
                      />
                      {isOwnedRoomNameDirty ? (
                        <button
                          type="button"
                          disabled={isRoomsPending || isOwnedRoomAvatarPending || !ownedRoomName.trim()}
                          onClick={handleOwnedRoomNameSave}
                          className={`${ICON_BUTTON_CLASS} absolute right-2 top-1/2 -translate-y-1/2 text-[var(--accent)] hover:bg-white/6 hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-45`}
                          aria-label="Save room name"
                        >
                          <Check className="h-4 w-4" />
                        </button>
                      ) : null}
                    </span>
                  </label>

                  <input
                    ref={ownedRoomFileInputRef}
                    id={ownedRoomFileInputId}
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={handleOwnedRoomAvatarUpload}
                  />
                  {ownedRoomAvatarError ? (
                    <p className="text-sm text-[var(--danger)]">{ownedRoomAvatarError}</p>
                  ) : null}

                  <div className="flex items-center justify-between gap-3 rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-[11px] uppercase tracking-[0.18em] text-white/48">Room code</p>
                      <p className="selectable-text mt-1 font-mono text-sm tracking-[0.22em] text-white">
                        {ownedRoom.code}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void navigator.clipboard?.writeText(ownedRoom.code)}
                        className={`${ICON_BUTTON_CLASS} ui-button h-10 w-10 rounded-xl border border-white/10 text-white/78 hover:border-white/16 hover:text-white`}
                        aria-label="Copy room code"
                      >
                        <Copy className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        disabled={isRoomsPending || isOwnedRoomAvatarPending}
                        onClick={() => void onResetOwnedRoomCode()}
                        className={`${ICON_BUTTON_CLASS} ui-button h-10 w-10 rounded-xl border border-white/10 text-white/78 hover:border-white/16 hover:text-white disabled:cursor-not-allowed disabled:opacity-55`}
                        aria-label="Reset room code"
                      >
                        <RefreshCcw className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </SectionCard>
          </>
        )}
      </div>
      ) : null}

      {activeRoomSubTab === "members" ? (
        <SectionCard
          icon={activeRoomMemberView === "active" ? Users : Ban}
          title="Members"
          actions={
            <div className="flex rounded-lg border border-white/8 bg-white/[0.02] p-1">
              {[
                { id: "active", label: "Active", count: sortedOwnedRoomMembers.length },
                { id: "banned", label: "Banned", count: sortedOwnedRoomBans.length }
              ].map((item) => {
                const isActive = activeRoomMemberView === item.id;

                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActiveRoomMemberView(item.id as RoomMemberView)}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                      isActive
                        ? "bg-[rgba(113,220,225,0.12)] text-white"
                        : "text-white/54 hover:bg-white/[0.05] hover:text-white"
                    }`}
                  >
                    {item.label}
                    <span className="ml-2 text-white/42">{item.count}</span>
                  </button>
                );
              })}
            </div>
          }
        >
          {activeRoomMemberView === "active" ? (
            !ownedRoom ? (
              <div className="rounded-xl border border-dashed border-white/10 px-4 py-5 text-sm text-white/54">
                Create your own room to manage members.
              </div>
            ) : sortedOwnedRoomMembers.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/10 px-4 py-5 text-sm text-white/54">
                No members yet.
              </div>
            ) : (
              <div className="space-y-3">
                {sortedOwnedRoomMembers.map((member) => (
                  <div
                    key={member.userId}
                    className="flex flex-col gap-4 rounded-[1rem] border border-white/8 bg-white/[0.03] px-4 py-4 lg:flex-row lg:items-center lg:justify-between"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <img
                        src={getAvatarSrc(member)}
                        alt=""
                        className="h-10 w-10 flex-shrink-0 rounded-full object-cover"
                      />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="selectable-text truncate text-sm font-semibold text-white">
                            {member.nickname}
                          </p>
                          {member.isOwner ? (
                            <span className="rounded-full bg-[rgba(113,220,225,0.12)] px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-[#71dce1]">
                              Owner
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 text-xs text-white/48">
                          Joined {formatJoinedDate(member.joinedAt)}
                        </p>
                      </div>
                    </div>

                    {!member.isOwner ? (
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={isRoomsPending}
                          onClick={() => void onRemoveOwnedRoomMember(member.userId)}
                          className={ROOM_DANGER_CTA_CLASS}
                        >
                          <UserMinus className="h-4 w-4" />
                          Remove
                        </button>
                        <button
                          type="button"
                          disabled={isRoomsPending}
                          onClick={() => void onBanOwnedRoomMember(member.userId)}
                          className={ROOM_DANGER_CTA_CLASS}
                        >
                          <Ban className="h-4 w-4" />
                          Ban
                        </button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )
          ) : !ownedRoom ? (
            <div className="rounded-xl border border-dashed border-white/10 px-4 py-5 text-sm text-white/54">
              Create your own room to use the ban list.
            </div>
          ) : sortedOwnedRoomBans.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/10 px-4 py-5 text-sm text-white/54">
              No banned users.
            </div>
          ) : (
            <div className="space-y-3">
              {sortedOwnedRoomBans.map((ban) => (
                <div
                  key={ban.userId}
                  className="flex flex-col gap-4 rounded-[1rem] border border-white/8 bg-white/[0.03] px-4 py-4 lg:flex-row lg:items-center lg:justify-between"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <img
                      src={getAvatarSrc(ban)}
                      alt=""
                      className="h-10 w-10 flex-shrink-0 rounded-full object-cover"
                    />
                    <div className="min-w-0">
                      <p className="selectable-text truncate text-sm font-semibold text-white">
                        {ban.nickname}
                      </p>
                      <p className="mt-1 text-xs text-white/48">
                        Banned {formatJoinedDate(ban.bannedAt)}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={isRoomsPending}
                    onClick={() => void onUnbanOwnedRoomMember(ban.userId)}
                    className={ROOM_CTA_CLASS}
                  >
                    Unban
                  </button>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      ) : null}

      {activeRoomSubTab === "joined" ? (
      <SectionCard
        icon={Users}
        title="Joined rooms"
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {isRoomsLoading ? (
              <div className="text-xs uppercase tracking-[0.18em] text-white/42">Syncing</div>
            ) : null}
            <div className="flex items-center gap-2">
              <span className="relative block">
                <input
                  value={joinCode}
                  onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                  maxLength={12}
                  placeholder="Enter room code"
                  className="ui-input h-11 w-[26ch] rounded-xl px-4 py-0 pr-10 text-white outline-none transition placeholder:text-[11px] placeholder:font-medium placeholder:uppercase placeholder:tracking-[0.14em] placeholder:text-white/38"
                />
                <button
                  type="button"
                  onClick={() => void handlePasteJoinCode()}
                  className={`${ICON_BUTTON_CLASS} absolute right-1.5 top-1/2 h-8 w-8 -translate-y-1/2`}
                  aria-label="Paste room code"
                >
                  <Clipboard className="h-4 w-4" />
                </button>
              </span>
              <button
                type="button"
                disabled={isRoomsPending || !joinCode.trim()}
                onClick={() => void onJoinRoom(joinCode)}
                className={`${ROOM_CTA_CLASS} h-11 px-4 py-0`}
              >
                <LogIn className="h-4 w-4" />
                Join room
              </button>
            </div>
          </div>
        }
      >
        <div className="space-y-4">
          {orderedRooms.length === 0 ? (
            <div className="rounded-xl border border-dashed border-white/10 px-4 py-5 text-sm text-white/54">
              No rooms saved yet.
            </div>
          ) : (
            orderedRooms.map((room) => {
              const isCurrent = currentRoom?.id === room.id;
              const isOwned = ownedRoom?.id === room.id;

              return (
                <div
                  key={room.id}
                  className="flex flex-col gap-4 rounded-[1rem] border border-white/8 bg-white/[0.03] px-4 py-4 lg:flex-row lg:items-center lg:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="selectable-text truncate text-base font-medium text-white">
                        {room.name}
                      </p>
                      {isCurrent ? (
                        <span className="rounded-full bg-[rgba(255,202,42,0.14)] px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-[var(--accent)]">
                          Active
                        </span>
                      ) : null}
                      {isOwned ? (
                        <span className="rounded-full bg-[rgba(113,220,225,0.12)] px-2.5 py-1 text-[10px] uppercase tracking-[0.18em] text-[#71dce1]">
                          Your room
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-white/56">
                      <span>
                        Code{" "}
                        <span className="selectable-text font-semibold tracking-[0.18em] text-white">
                          {room.code}
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => void navigator.clipboard?.writeText(room.code)}
                        className={ICON_BUTTON_CLASS}
                        aria-label={`Copy code for ${room.name}`}
                      >
                        <Copy className="h-4 w-4" />
                      </button>
                      <span>Joined {formatJoinedDate(room.joinedAt)}</span>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {!isCurrent ? (
                      <button
                        type="button"
                        disabled={isRoomsPending}
                        onClick={() => void onSwitchRoom(room.id)}
                        className={ROOM_SWITCH_CTA_CLASS}
                      >
                        <ArrowRightLeft className="h-4 w-4" />
                        Switch
                      </button>
                    ) : null}
                    {!isOwned ? (
                      <button
                        type="button"
                        disabled={isRoomsPending}
                        onClick={() => void onRemoveRoom(room.id)}
                        className={ROOM_DANGER_CTA_CLASS}
                      >
                        <Trash2 className="h-4 w-4" />
                        Leave
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </SectionCard>
      ) : null}
    </div>
  );
}

function AudioTab(props: Pick<
  SettingsPanelProps,
  | "compact"
  | "inputDevices"
  | "outputDevices"
  | "selectedInputId"
  | "selectedOutputId"
  | "noiseFilterEnabled"
  | "outputVolume"
  | "outputSwitchSupported"
  | "deviceLabelsUnlocked"
  | "isUnlockingDeviceLabels"
  | "onInputChange"
  | "onOutputChange"
  | "onNoiseFilterEnabledChange"
  | "onOutputVolumeChange"
  | "onUnlockDeviceLabels"
>) {
  return (
    <div className={cn("settings-audio-tab", props.compact ? "space-y-3" : "space-y-8")}>
      {!props.compact ? <PageLabel>Audio</PageLabel> : null}
      <div className={cn("settings-dual-column grid", props.compact ? "gap-1" : "gap-10")}>
        <SectionCard icon={Mic} title="Microphone" dense={props.compact}>
          <DeviceSelect
            value={props.selectedInputId}
            options={props.inputDevices}
            onChange={props.onInputChange}
            placeholder="Default microphone"
          />
          {!props.deviceLabelsUnlocked ? (
            <div className={cn("rounded-xl border border-dashed border-white/10 px-4 text-sm text-[var(--muted)]", props.compact ? "mt-1 py-2" : "mt-4 py-4")}>
              <button
                type="button"
                onClick={props.onUnlockDeviceLabels}
                disabled={props.isUnlockingDeviceLabels}
                className={cn(ROOM_CTA_CLASS, props.compact && "h-8 px-3 py-0 text-xs")}
              >
                {props.isUnlockingDeviceLabels ? "Unlocking..." : "Enable labels"}
              </button>
            </div>
          ) : null}
          <div className={props.compact ? "mt-1" : "mt-4"}>
            <ToggleControl
              checked={props.noiseFilterEnabled}
              onChange={props.onNoiseFilterEnabledChange}
              label="Enhanced noise suppression"
              badge="Krisp"
            />
          </div>
        </SectionCard>

        <SectionCard icon={Volume2} title="Speaker output" dense={props.compact}>
          {props.outputSwitchSupported ? (
            <DeviceSelect
              value={props.selectedOutputId}
              options={props.outputDevices}
              onChange={props.onOutputChange}
              placeholder="Default speakers"
            />
          ) : (
            <div className="rounded-xl border border-dashed border-white/10 px-4 py-3 text-sm text-[var(--muted)]">
              Browser output device in use.
            </div>
          )}
          <div className={props.compact ? "mt-1" : "mt-4"}>
            <VolumeSlider
              value={props.outputVolume}
              onChange={props.onOutputVolumeChange}
              maxPercent={100}
              snapAtPercent={100}
            />
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

const usageNumberFormat = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1
});
const usageBandwidthFormat = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 3
});

function formatUsageDate(dateKey: string) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short"
  }).format(new Date(`${dateKey}T00:00:00Z`));
}

function UsageMetricCard({
  label,
  value,
  suffix
}: {
  label: string;
  value: number;
  suffix: string;
}) {
  const formatter = suffix === "GB" ? usageBandwidthFormat : usageNumberFormat;

  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.025] px-4 py-4">
      <div className="text-[11px] uppercase tracking-[0.18em] text-white/42">{label}</div>
      <div className="mt-3 flex items-end gap-2">
        <span className="text-2xl font-semibold text-white">{formatter.format(value)}</span>
        <span className="pb-1 text-xs uppercase tracking-[0.14em] text-[var(--accent)]">{suffix}</span>
      </div>
    </div>
  );
}

function LiveKitUsageTab(props: Pick<
  SettingsPanelProps,
  | "liveKitUsage"
  | "liveKitUsageMonth"
  | "isLiveKitUsageLoading"
  | "liveKitUsageError"
  | "onLiveKitUsageMonthChange"
>) {
  const usage = props.liveKitUsage;

  return (
    <div className="space-y-8">
      <PageLabel>LiveKit usage</PageLabel>

      <SectionCard
        icon={BarChart3}
        title="Owner room usage"
        actions={
          <input
            type="month"
            value={props.liveKitUsageMonth}
            onChange={(event) => props.onLiveKitUsageMonthChange(event.target.value)}
            className="ui-input h-10 rounded-xl px-3 text-sm text-white outline-none"
          />
        }
      >
        {props.liveKitUsageError ? (
          <div className="rounded-xl border border-[color:rgba(255,123,123,0.22)] bg-[color:rgba(255,123,123,0.08)] px-4 py-3 text-sm text-[var(--danger)]">
            {props.liveKitUsageError}
          </div>
        ) : null}

        {!usage || props.isLiveKitUsageLoading ? (
          <div className="rounded-xl border border-dashed border-white/10 px-4 py-5 text-sm text-white/54">
            Loading usage...
          </div>
        ) : !usage.hasOwnedRoom ? (
          <div className="rounded-xl border border-dashed border-white/10 px-4 py-5 text-sm text-white/54">
            Create your own room to view LiveKit usage.
          </div>
        ) : (
          <div className="space-y-6">
            <div className="text-sm text-white/58">
              {usage.roomName} usage for {usage.month}
            </div>

            <div className="settings-dual-column grid gap-3">
              <UsageMetricCard
                label="Avg WebRTC per day"
                value={usage.averageWebRtcMinutesPerDay}
                suffix="min"
              />
              <UsageMetricCard
                label="Avg stream bandwidth per day"
                value={usage.averageStreamGbPerDay}
                suffix="GB"
              />
              <UsageMetricCard
                label="Total WebRTC"
                value={usage.totalWebRtcMinutes}
                suffix="min"
              />
              <UsageMetricCard
                label="Total stream bandwidth"
                value={usage.totalStreamGb}
                suffix="GB"
              />
            </div>

            <div className="space-y-2">
              {usage.days.map((day) => (
                <div
                  key={day.dateKey}
                  className="settings-usage-row grid gap-3 rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3 text-sm text-white/72"
                >
                  <div className="font-medium text-white">{formatUsageDate(day.dateKey)}</div>
                  <div>{usageNumberFormat.format(day.webRtcMinutes)} min WebRTC</div>
                  <div>{usageNumberFormat.format(day.streamMinutes)} min stream</div>
                  <div>{usageBandwidthFormat.format(day.streamGb)} GB stream</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function DeveloperTab(props: Pick<
  SettingsPanelProps,
  | "currentRoom"
  | "ownedRoom"
  | "isRoomsPending"
  | "onUpdateOwnedRoom"
  | "onResetOwnedRoomCode"
  | "isClearingDesktopCache"
  | "onClearDesktopCache"
>) {
  const canManageSeeds = Boolean(props.currentRoom?.isOwned && props.ownedRoom);

  return (
    <div className="space-y-8">
      <PageLabel>Developer</PageLabel>
      <SectionCard icon={Wrench} title="Filler mode">
        {canManageSeeds && props.ownedRoom ? (
          <ToggleControl
            checked={props.ownedRoom.fillerMode}
            onChange={(value) =>
              void props.onUpdateOwnedRoom(
                props.ownedRoom!.name,
                value,
                props.ownedRoom!.avatarDataUrl,
                props.ownedRoom!.dailyStreamLimitMinutes
              )
            }
            label="Seed demo members"
          />
        ) : props.ownedRoom ? (
          <div className="rounded-xl border border-dashed border-white/10 px-4 py-5 text-sm text-white/54">
            Switch to your own room to use developer room controls.
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-white/10 px-4 py-5 text-sm text-white/54">
            Create your own room to use developer room controls.
          </div>
        )}
      </SectionCard>

      {props.onClearDesktopCache ? (
        <SectionCard icon={Trash2} title="Desktop app reset" separated>
          <div className="rounded-xl border border-dashed border-[rgba(255,123,123,0.18)] px-4 py-5 text-sm text-white/64">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <span>
                Resets all desktop app data stored under Roaming/SovChat, including cached state and saved desktop preferences, then relaunches the app.
              </span>
              <button
                type="button"
                disabled={props.isClearingDesktopCache}
                onClick={() => void props.onClearDesktopCache?.()}
                className={ROOM_CTA_CLASS}
              >
                <Trash2 className="h-4 w-4" />
                {props.isClearingDesktopCache ? "Resetting..." : "Reset desktop app data"}
              </button>
            </div>
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}

function getDesktopUpdateErrorText(error?: string | null) {
  if (!error) {
    return "Update check failed.";
  }

  const firstLine = error.split(/\r?\n/u)[0]?.trim() ?? "";
  const match = firstLine.match(/Cannot find ["']latest\.yml["'] update info:.*?status code\s+(\d+)/iu);

  if (match?.[1] === "404") {
    return "No desktop update manifest was found on the server.";
  }

  if (/Cannot find ["']latest\.yml["'] update info/iu.test(firstLine)) {
    return "The desktop update manifest could not be loaded from the server.";
  }

  if (/net::|ENOTFOUND|ECONN|ETIMEDOUT|network/iu.test(firstLine)) {
    return "Could not reach the desktop update server.";
  }

  return firstLine || "Update check failed.";
}

function AdvancedTab(props: Pick<
  SettingsPanelProps,
  | "performanceModeForced"
  | "performanceModeAutoActive"
  | "startWithWindows"
  | "closeToTray"
  | "afkLeaveMinutes"
  | "isDesktop"
  | "desktopUpdateState"
  | "isCheckingForUpdates"
  | "isExportingClientDiagnostics"
  | "clientDiagnosticsStatus"
  | "ownedRoom"
  | "isRoomsPending"
  | "onUpdateOwnedRoom"
  | "onResetOwnedRoomDailyStreamUsage"
  | "onPerformanceModeChange"
  | "onStartWithWindowsChange"
  | "onCloseToTrayChange"
  | "onAfkLeaveMinutesChange"
  | "onCheckForUpdates"
  | "onExportClientDiagnostics"
>) {
  const [streamLimitDraft, setStreamLimitDraft] = useState(
    props.ownedRoom?.dailyStreamLimitMinutes ?? 15
  );
  const normalizedStreamLimit = Math.max(0, Math.min(1440, Math.round(streamLimitDraft || 0)));
  const streamLimitChanged =
    Boolean(props.ownedRoom) && normalizedStreamLimit !== props.ownedRoom?.dailyStreamLimitMinutes;
  const updateStatus = props.desktopUpdateState?.status ?? "idle";
  const updateCheckedAt = props.desktopUpdateState?.checkedAt
    ? new Date(props.desktopUpdateState.checkedAt).toLocaleString()
    : null;
  const updateErrorText = getDesktopUpdateErrorText(props.desktopUpdateState?.error);
  const updateStatusText =
    updateStatus === "checking" || props.isCheckingForUpdates
      ? "Checking for updates..."
      : updateStatus === "available"
        ? `Preparing update${props.desktopUpdateState?.availableVersion ? ` ${props.desktopUpdateState.availableVersion}` : ""}.`
      : updateStatus === "downloaded"
        ? props.desktopUpdateState?.installMode === "assisted"
          ? "Update ready. Open the installer to finish."
          : props.desktopUpdateState?.installMode === "elevated"
            ? "Update ready. Restart SovChat and approve the system permission to finish."
            : "Update ready. Restart SovChat to finish."
      : updateStatus === "downloading"
        ? `Downloading update ${Math.round(props.desktopUpdateState?.percent ?? 0)}%.`
      : updateStatus === "installing"
        ? props.desktopUpdateState?.installMode === "assisted"
          ? "Opening the installer to finish the update..."
          : "Restarting to finish the update..."
      : updateStatus === "not-available"
        ? "SovChat is up to date."
      : updateStatus === "error"
        ? updateErrorText
      : "Check whether a newer desktop build is available.";

  useEffect(() => {
    setStreamLimitDraft(props.ownedRoom?.dailyStreamLimitMinutes ?? 15);
  }, [props.ownedRoom?.id, props.ownedRoom?.dailyStreamLimitMinutes]);

  return (
    <div className="space-y-8">
      <PageLabel>Advanced</PageLabel>

      <SectionCard icon={Gauge} title="Performance">
        <ToggleControl
          checked={props.performanceModeForced}
          onChange={props.onPerformanceModeChange}
          label="Force performance mode"
          badge={
            props.performanceModeAutoActive && !props.performanceModeForced ? "Auto active" : null
          }
        />
      </SectionCard>

      {props.isDesktop ? (
        <SectionCard icon={SlidersHorizontal} title="Desktop" separated>
          <div className="space-y-3">
            <div className="rounded-xl border border-white/8 bg-white/[0.02] px-4 py-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-white">Desktop updates</div>
                  <div className="mt-1 break-words text-xs text-white/48">{updateStatusText}</div>
                  {updateCheckedAt ? (
                    <div className="mt-1 text-[11px] text-white/34">Last checked {updateCheckedAt}</div>
                  ) : null}
                </div>
                <button
                  type="button"
                  disabled={props.isCheckingForUpdates || updateStatus === "checking"}
                  onClick={() => void props.onCheckForUpdates()}
                  className={`${ROOM_CTA_CLASS} h-11 px-4 py-0`}
                >
                  <RefreshCw className={`h-4 w-4 ${props.isCheckingForUpdates || updateStatus === "checking" ? "animate-spin" : ""}`} />
                  {props.isCheckingForUpdates || updateStatus === "checking"
                    ? "Checking..."
                    : "Check for updates"}
                </button>
              </div>
            </div>
            <div className="rounded-xl border border-white/8 bg-white/[0.02] px-4 py-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-white">Support diagnostics</div>
                  <div className="mt-1 break-words text-xs text-white/48">
                    Export recent audio and voice timing events for troubleshooting. Tokens, device
                    names, and raw identifiers are removed.
                  </div>
                  {props.clientDiagnosticsStatus ? (
                    <div className="mt-1 text-[11px] text-white/42" aria-live="polite">
                      {props.clientDiagnosticsStatus}
                    </div>
                  ) : null}
                </div>
                <button
                  type="button"
                  disabled={
                    props.isExportingClientDiagnostics || !props.onExportClientDiagnostics
                  }
                  onClick={() => void props.onExportClientDiagnostics?.()}
                  className={`${ROOM_CTA_CLASS} h-11 px-4 py-0`}
                >
                  <Download className="h-4 w-4" />
                  {props.isExportingClientDiagnostics ? "Exporting..." : "Export diagnostics"}
                </button>
              </div>
            </div>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard icon={MonitorUp} title="Room streaming" separated>
        {props.ownedRoom ? (
          <div className="rounded-xl border border-white/8 bg-white/[0.02] px-4 py-4">
            <div className="text-sm text-white">Daily stream limit per user</div>
            <div className="mt-1 text-xs text-white/48">
              Applies to your room. Set minutes per UTC day, or use 0 to disable.
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <input
                type="number"
                min={0}
                max={1440}
                step={1}
                value={streamLimitDraft}
                disabled={props.isRoomsPending}
                onChange={(event) => setStreamLimitDraft(Number(event.target.value))}
                className="ui-input h-11 w-32 rounded-xl px-4 text-white outline-none"
              />
              <button
                type="button"
                disabled={props.isRoomsPending || !streamLimitChanged}
                onClick={() =>
                  void props.onUpdateOwnedRoom(
                    props.ownedRoom!.name,
                    props.ownedRoom!.fillerMode,
                    props.ownedRoom!.avatarDataUrl,
                    normalizedStreamLimit
                  )
                }
                className={`${ROOM_CTA_CLASS} h-11 px-4 py-0`}
              >
                Save limit
              </button>
              <button
                type="button"
                disabled={props.isRoomsPending}
                onClick={() => void props.onResetOwnedRoomDailyStreamUsage()}
                className={`${ROOM_DANGER_CTA_CLASS} h-11 px-4 py-0`}
              >
                Reset daily usage
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-white/10 px-4 py-5 text-sm text-white/54">
            Create your own room to set stream limits.
          </div>
        )}
      </SectionCard>

      <SectionCard icon={Users} title="AFK" separated>
        <label className="block rounded-xl border border-white/8 bg-white/[0.02] px-4 py-4">
          <span className="block text-sm text-white">Auto leave voice when AFK</span>
          <span className="mt-1 block text-xs text-white/48">
            Set minutes of no keyboard or mouse input. Use 0 to disable.
          </span>
          <input
            type="number"
            min={0}
            max={1440}
            step={1}
            value={props.afkLeaveMinutes}
            onChange={(event) => props.onAfkLeaveMinutesChange(Number(event.target.value))}
            className="ui-input mt-4 h-11 w-32 rounded-xl px-4 text-white outline-none"
          />
        </label>
      </SectionCard>
    </div>
  );
}

function AppearanceTab() {
  const activeThemeId = useSyncExternalStore(
    themeStore.subscribe,
    themeStore.getState,
    themeStore.getServerState
  );
  return (
    <div className="space-y-8">
      <PageLabel>Appearance</PageLabel>
      <SectionCard icon={Palette} title="Theme colours">
        <div className="theme-picker-grid">
          {APP_THEMES.map((theme) => {
            const isActive = activeThemeId === theme.id;

            return (
              <button
                key={theme.id}
                type="button"
                onClick={() => themeStore.setTheme(theme.id)}
                className={cn("theme-picker-option", isActive && "theme-picker-option-active")}
                aria-pressed={isActive}
              >
                <span className="theme-picker-swatches" aria-hidden="true">
                  <span style={{ backgroundColor: theme.primary }} />
                  <span style={{ backgroundColor: theme.secondary }} />
                </span>
                <span className="min-w-0 flex-1 truncate text-left text-sm text-white/84">
                  {theme.name}
                </span>
                {isActive ? <Check className="h-4 w-4 shrink-0 text-[var(--accent)]" /> : null}
              </button>
            );
          })}
        </div>
      </SectionCard>
    </div>
  );
}

export function SettingsPanel(props: SettingsPanelProps) {
  const hasOwnedRoom = Boolean(props.ownedRoom);
  const tabs: Array<{
    id: SettingsTab;
    label: string;
    icon: typeof Mic;
  }> = [
    { id: "audio", label: "Audio", icon: Mic },
    { id: "appearance", label: "Appearance", icon: Palette },
    { id: "rooms", label: "Rooms", icon: Users },
    ...(hasOwnedRoom
      ? ([{ id: "livekit-usage", label: "LiveKit usage", icon: BarChart3 }] as const)
      : []),
    { id: "advanced", label: "Advanced", icon: SlidersHorizontal },
    ...(hasOwnedRoom
      ? ([{ id: "developer", label: "Developer", icon: Wrench }] as const)
      : [])
  ];
  const activeTabVisible = tabs.some((tab) => tab.id === props.activeTab);

  useEffect(() => {
    if (props.isOpen && !activeTabVisible) {
      props.onActiveTabChange(hasOwnedRoom ? "advanced" : "rooms");
    }
  }, [activeTabVisible, hasOwnedRoom, props.isOpen, props.onActiveTabChange]);

  if (!props.isOpen) {
    return null;
  }

  return (
    <PrimaryPanelShell
      onClose={props.onClose}
      eyebrow="Settings"
      title={null}
      closeLabel="Close settings"
      compact={props.compact}
      className={
        props.compact
          ? "h-full min-h-0 max-h-none"
          : "h-[calc(100vh-10.5rem)] max-h-[calc(100vh-10.5rem)] min-h-[36rem]"
      }
      bodyClassName="min-h-0 overflow-hidden"
      widthClassName={props.compact ? "h-full w-full min-h-0" : "settings-panel-width"}
    >
      <div className={cn("settings-panel-layout", props.compact && "settings-panel-layout-compact")}>
              <aside
                className={cn(
                  "settings-panel-nav flex min-h-0",
                  props.compact
                    ? "shrink-0 overflow-hidden px-3 pb-1"
                    : "flex-col gap-6 overflow-y-auto pr-2 [scrollbar-gutter:stable]"
                )}
              >
                <div
                  className={props.compact ? "grid w-full gap-1" : "space-y-2"}
                  style={props.compact
                    ? { gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }
                    : undefined}
                >
                  {tabs.map((tab) => {
                    const Icon = tab.icon;
                    const isActive = props.activeTab === tab.id;

                    return (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => props.onActiveTabChange(tab.id)}
                        className={`flex items-center gap-3 rounded-lg border text-left transition ${
                          props.compact
                            ? "h-9 min-w-0 justify-center gap-0 px-0"
                            : "h-12 w-full px-4"
                        } ${
                          isActive
                            ? "settings-tab-active text-white"
                            : "border-white/6 bg-white/[0.02] text-white/72 hover:border-white/12 hover:bg-white/[0.05]"
                        }`}
                        aria-label={tab.label}
                        title={props.compact ? tab.label : undefined}
                      >
                        <span className={`inline-flex w-5 items-center justify-center ${isActive ? "text-[var(--secondary)]" : "text-white/54"}`}>
                          <Icon className="h-4.5 w-4.5" />
                        </span>
                        <span className={props.compact ? "sr-only" : "min-w-0"}>
                          <span className="block text-sm font-medium">{tab.label}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div className={cn("border-t border-white/6 pt-4 lg:mt-auto", props.compact && "hidden")}>
                  <div className="text-[11px] text-white/42">© 2026 Tyronne Garth Jones</div>
                  <div className="mt-2 flex flex-col gap-2 text-[11px]">
                    <a
                      href={resolveHostedAppUrl("/terms")}
                      target="_blank"
                      rel="noreferrer"
                      className="text-white/48 transition hover:text-white/72"
                    >
                      Terms of Use
                    </a>
                    <a
                      href={resolveHostedAppUrl("/privacy")}
                      target="_blank"
                      rel="noreferrer"
                      className="text-white/48 transition hover:text-white/72"
                    >
                      Privacy Policy
                    </a>
                    <a
                      href={resolveHostedAppUrl("/copyright")}
                      target="_blank"
                      rel="noreferrer"
                      className="text-white/48 transition hover:text-white/72"
                    >
                      Copyright
                    </a>
                  </div>
                </div>
              </aside>

              <div
                className={cn(
                  "settings-content-column min-h-0 min-w-0 overflow-y-auto",
                  props.compact
                    ? "overflow-x-hidden px-3 pb-0 [scrollbar-gutter:auto]"
                    : "pr-2 [scrollbar-gutter:stable]"
                )}
              >
                <div className={props.activeTab === "audio" ? "block" : "hidden"} aria-hidden={props.activeTab !== "audio"}>
                  <AudioTab {...props} />
                </div>
                <div className={props.activeTab === "appearance" ? "block" : "hidden"} aria-hidden={props.activeTab !== "appearance"}>
                  <AppearanceTab />
                </div>
                <div className={props.activeTab === "rooms" ? "block" : "hidden"} aria-hidden={props.activeTab !== "rooms"}>
                  <RoomsTab {...props} />
                </div>
                {hasOwnedRoom ? (
                  <div
                    className={props.activeTab === "livekit-usage" ? "block" : "hidden"}
                    aria-hidden={props.activeTab !== "livekit-usage"}
                  >
                    <LiveKitUsageTab {...props} />
                  </div>
                ) : null}
                <div className={props.activeTab === "advanced" ? "block" : "hidden"} aria-hidden={props.activeTab !== "advanced"}>
                  <AdvancedTab {...props} />
                </div>
                {hasOwnedRoom ? (
                  <div className={props.activeTab === "developer" ? "block" : "hidden"} aria-hidden={props.activeTab !== "developer"}>
                    <DeveloperTab {...props} />
                  </div>
                ) : null}
              </div>
            </div>
    </PrimaryPanelShell>
  );
}
