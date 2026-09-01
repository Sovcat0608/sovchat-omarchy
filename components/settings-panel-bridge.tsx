"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { SettingsPanel } from "@/components/settings-panel";
import { advancedSettingsStore } from "@/lib/advanced-settings-store";
import { audioSettingsStore } from "@/lib/audio-settings-store";
import { apiFetch } from "@/lib/api-client";
import { flushClientDiagnostics } from "@/lib/client-diagnostics";
import { getDesktopBridge } from "@/lib/desktop";
import type { DesktopUpdateState } from "@/lib/desktop";
import type { SovChatAudioProfile } from "@/lib/audio/audio-types";
import { useAppFocusState } from "@/lib/use-app-focus-state";
import type { LiveKitUsageSummary, RoomBanSummary, RoomMemberSummary, RoomSummary } from "@/types";

type SettingsTab = "audio" | "appearance" | "rooms" | "livekit-usage" | "developer" | "advanced";

type SettingsPanelBridgeProps = {
  isOpen: boolean;
  compact?: boolean;
  onClose: () => void;
  activeTab: SettingsTab;
  onActiveTabChange: (tab: SettingsTab) => void;
  currentRoom: RoomSummary | null;
  ownedRoom: RoomSummary | null;
  joinedRooms: RoomSummary[];
  ownedRoomMembers: RoomMemberSummary[];
  ownedRoomBans: RoomBanSummary[];
  isRoomsLoading: boolean;
  isRoomsPending: boolean;
  roomsError: string | null;
  roomsStatus: string | null;
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
};

export function SettingsPanelBridge({
  isOpen,
  compact = false,
  onClose,
  activeTab,
  onActiveTabChange,
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
  onResetOwnedRoomDailyStreamUsage,
  onJoinRoom,
  onSwitchRoom,
  onRemoveRoom,
  onRemoveOwnedRoomMember,
  onBanOwnedRoomMember,
  onUnbanOwnedRoomMember
}: SettingsPanelBridgeProps) {
  const getCurrentMonthKey = () => new Date().toISOString().slice(0, 7);
  const state = useSyncExternalStore(
    audioSettingsStore.subscribe,
    audioSettingsStore.getState,
    audioSettingsStore.getState
  );
  const advancedState = useSyncExternalStore(
    advancedSettingsStore.subscribe,
    advancedSettingsStore.getState,
    advancedSettingsStore.getState
  );
  const [isUnlockingDeviceLabels, setIsUnlockingDeviceLabels] = useState(false);
  const [isClearingDesktopCache, setIsClearingDesktopCache] = useState(false);
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const [isCheckingForUpdates, setIsCheckingForUpdates] = useState(false);
  const [isExportingClientDiagnostics, setIsExportingClientDiagnostics] = useState(false);
  const [clientDiagnosticsStatus, setClientDiagnosticsStatus] = useState<string | null>(null);
  const [liveKitUsageMonth, setLiveKitUsageMonth] = useState(getCurrentMonthKey);
  const [liveKitUsage, setLiveKitUsage] = useState<LiveKitUsageSummary | null>(null);
  const [isLiveKitUsageLoading, setIsLiveKitUsageLoading] = useState(false);
  const [liveKitUsageError, setLiveKitUsageError] = useState<string | null>(null);
  const { isAppFocused } = useAppFocusState();
  const desktopBridge = getDesktopBridge();
  const clearUserData = desktopBridge?.clearUserData;

  async function loadDevices() {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
      return;
    }

    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    const inputDevices = devices
      .filter((device) => device.kind === "audioinput")
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Microphone ${index + 1}`
      }));
    const outputDevices = devices
      .filter((device) => device.kind === "audiooutput")
      .map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Speaker ${index + 1}`
      }));

    audioSettingsStore.patch({
      inputDevices,
      outputDevices,
      selectedInputId: state.selectedInputId || inputDevices[0]?.deviceId || "",
      selectedOutputId: state.selectedOutputId || outputDevices[0]?.deviceId || "",
      outputSwitchSupported:
        typeof HTMLMediaElement !== "undefined" &&
        "setSinkId" in HTMLMediaElement.prototype
    });
  }

  async function unlockDeviceLabels() {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      return;
    }

    setIsUnlockingDeviceLabels(true);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
          channelCount: 1
        }
      });
      stream.getTracks().forEach((track) => track.stop());
      await loadDevices();
    } finally {
      setIsUnlockingDeviceLabels(false);
    }
  }

  useEffect(() => {
    void loadDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", loadDevices);

    return () => {
      navigator.mediaDevices?.removeEventListener?.("devicechange", loadDevices);
    };
  }, [state.selectedInputId, state.selectedOutputId]);

  useEffect(() => {
    let active = true;

    void desktopBridge?.getDesktopPreferences?.()
      .then((preferences) => {
        if (!active || !preferences) {
          return;
        }

        advancedSettingsStore.patch(preferences);
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, [desktopBridge]);

  useEffect(() => {
    if (!isOpen || activeTab !== "livekit-usage" || !ownedRoom) {
      return;
    }

    let active = true;
    setIsLiveKitUsageLoading(true);
    setLiveKitUsageError(null);

    void apiFetch(`/api/livekit-usage?month=${encodeURIComponent(liveKitUsageMonth)}`, {
      cache: "no-store"
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as
          | (LiveKitUsageSummary & { error?: string })
          | null;

        if (!response.ok || !payload) {
          throw new Error(payload?.error ?? "Unable to load LiveKit usage.");
        }

        if (active) {
          setLiveKitUsage(payload);
        }
      })
      .catch((error) => {
        if (active) {
          setLiveKitUsageError(
            error instanceof Error ? error.message : "Unable to load LiveKit usage."
          );
        }
      })
      .finally(() => {
        if (active) {
          setIsLiveKitUsageLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [activeTab, isOpen, liveKitUsageMonth, ownedRoom?.id]);

  useEffect(() => {
    if (!desktopBridge?.isDesktop) {
      setDesktopUpdateState(null);
      return;
    }

    let active = true;

    void desktopBridge.getUpdateState?.()
      .then((updateState) => {
        if (active && updateState) {
          setDesktopUpdateState(updateState);
        }
      })
      .catch(() => undefined);

    const unsubscribe = desktopBridge.subscribeUpdateState?.((updateState) => {
      setDesktopUpdateState(updateState);
    });

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [desktopBridge]);

  async function checkForDesktopUpdates() {
    if (!desktopBridge?.checkForUpdates) {
      return;
    }

    setIsCheckingForUpdates(true);

    try {
      const updateState = await desktopBridge.checkForUpdates();
      setDesktopUpdateState(updateState);
    } finally {
      setIsCheckingForUpdates(false);
    }
  }

  async function exportClientDiagnostics() {
    if (!desktopBridge?.exportClientDiagnostics) {
      return;
    }

    setIsExportingClientDiagnostics(true);
    setClientDiagnosticsStatus(null);

    try {
      await flushClientDiagnostics();
      const result = await desktopBridge.exportClientDiagnostics();
      setClientDiagnosticsStatus(
        result.status === "saved"
          ? `Exported ${result.eventCount} recent diagnostic event${result.eventCount === 1 ? "" : "s"}.`
          : "Export cancelled."
      );
    } catch (error) {
      setClientDiagnosticsStatus(
        error instanceof Error ? `Export failed: ${error.message}` : "Diagnostics export failed."
      );
    } finally {
      setIsExportingClientDiagnostics(false);
    }
  }

  const controller = audioSettingsStore.getController();
  const deviceLabelsUnlocked =
    state.inputDevices.some((device) => !/^Microphone \d+$/.test(device.label)) ||
    state.outputDevices.some((device) => !/^Speaker \d+$/.test(device.label));

  return (
    <SettingsPanel
      isOpen={isOpen}
      compact={compact}
      onClose={onClose}
      inputDevices={state.inputDevices}
      outputDevices={state.outputDevices}
      selectedInputId={state.selectedInputId}
      selectedOutputId={state.selectedOutputId}
      inputMuted={state.inputMuted}
      noiseFilterEnabled={state.noiseFilterEnabled}
      audioProfile={state.audioProfile}
      noiseFloorWarning={state.noiseFloorWarning}
      inputGain={1}
      outputVolume={state.outputVolume}
      outputSwitchSupported={state.outputSwitchSupported}
      performanceModeForced={state.performanceMode}
      performanceModeAutoActive={!isAppFocused}
      startWithWindows={advancedState.startWithWindows}
      closeToTray={advancedState.closeToTray}
      afkLeaveMinutes={advancedState.afkLeaveMinutes}
      isDesktop={Boolean(desktopBridge?.isDesktop)}
      desktopUpdateState={desktopUpdateState}
      isCheckingForUpdates={isCheckingForUpdates}
      isExportingClientDiagnostics={isExportingClientDiagnostics}
      clientDiagnosticsStatus={clientDiagnosticsStatus}
      deviceLabelsUnlocked={deviceLabelsUnlocked}
      isUnlockingDeviceLabels={isUnlockingDeviceLabels}
      currentRoom={currentRoom}
      ownedRoom={ownedRoom}
      joinedRooms={joinedRooms}
      ownedRoomMembers={ownedRoomMembers}
      ownedRoomBans={ownedRoomBans}
      isRoomsLoading={isRoomsLoading}
      isRoomsPending={isRoomsPending}
      roomsError={roomsError}
      roomsStatus={roomsStatus}
      liveKitUsage={liveKitUsage}
      liveKitUsageMonth={liveKitUsageMonth}
      isLiveKitUsageLoading={isLiveKitUsageLoading}
      liveKitUsageError={liveKitUsageError}
      activeTab={activeTab}
      onActiveTabChange={onActiveTabChange}
      onInputChange={(value) => {
        audioSettingsStore.patch({ selectedInputId: value });
        controller.setInputDevice(value);
      }}
      onOutputChange={(value) => {
        audioSettingsStore.patch({ selectedOutputId: value });
        controller.setOutputDevice(value);
      }}
      onInputMutedChange={(value) => {
        audioSettingsStore.patch({ inputMuted: value });
        controller.setInputMuted(value);
      }}
      onNoiseFilterEnabledChange={(value) => {
        audioSettingsStore.patch({ noiseFilterEnabled: value });
        controller.setNoiseFilterEnabled(value);
      }}
      onAudioProfileChange={(value: SovChatAudioProfile) => {
        audioSettingsStore.patch({ audioProfile: value });
        controller.setAudioProfile(value);
      }}
      onInputGainChange={(value) => {
        audioSettingsStore.patch({ inputGain: 1 });
        controller.setInputGain(1);
      }}
      onOutputVolumeChange={(value) => {
        audioSettingsStore.patch({ outputVolume: value });
        controller.setOutputVolume(value);
      }}
      onPerformanceModeChange={(value) => {
        audioSettingsStore.patch({ performanceMode: value });
      }}
      onStartWithWindowsChange={(value) => {
        advancedSettingsStore.patch({ startWithWindows: value });
        void desktopBridge?.setDesktopPreferences?.({ startWithWindows: value })
          .then((preferences) => {
            if (preferences) {
              advancedSettingsStore.patch(preferences);
            }
          })
          .catch(() => undefined);
      }}
      onCloseToTrayChange={(value) => {
        advancedSettingsStore.patch({
          closeToTray: value
        });
        void desktopBridge?.setDesktopPreferences?.({
          closeToTray: value,
          closeAction: value ? "tray" : "ask"
        })
          .then((preferences) => {
            if (preferences) {
              advancedSettingsStore.patch(preferences);
            }
          })
          .catch(() => undefined);
      }}
      onAfkLeaveMinutesChange={(value) => {
        advancedSettingsStore.patch({ afkLeaveMinutes: value });
      }}
      onCheckForUpdates={() => {
        void checkForDesktopUpdates();
      }}
      onExportClientDiagnostics={
        desktopBridge?.exportClientDiagnostics
          ? async () => {
              await exportClientDiagnostics();
            }
          : undefined
      }
      onLiveKitUsageMonthChange={setLiveKitUsageMonth}
      onUnlockDeviceLabels={() => {
        void unlockDeviceLabels();
      }}
      onCreateOwnedRoom={onCreateOwnedRoom}
      onUpdateOwnedRoom={onUpdateOwnedRoom}
      onResetOwnedRoomCode={onResetOwnedRoomCode}
      onResetOwnedRoomDailyStreamUsage={onResetOwnedRoomDailyStreamUsage}
      onJoinRoom={onJoinRoom}
      onSwitchRoom={onSwitchRoom}
      onRemoveRoom={onRemoveRoom}
      onRemoveOwnedRoomMember={onRemoveOwnedRoomMember}
      onBanOwnedRoomMember={onBanOwnedRoomMember}
      onUnbanOwnedRoomMember={onUnbanOwnedRoomMember}
      isClearingDesktopCache={isClearingDesktopCache}
      onClearDesktopCache={
        clearUserData
          ? async () => {
              setIsClearingDesktopCache(true);
              try {
                await clearUserData();
              } finally {
                setIsClearingDesktopCache(false);
              }
            }
          : undefined
      }
    />
  );
}
