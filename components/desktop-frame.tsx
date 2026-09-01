"use client";

import Image from "next/image";
import { Copy, Expand, Minus, RefreshCw, Shrink, Square } from "lucide-react";
import { type PropsWithChildren, useEffect, useState } from "react";
import { AppLayoutProvider, useAppLayout } from "@/components/app-layout-context";
import { HoverTooltip } from "@/components/hover-tooltip";
import {
  DESKTOP_UPDATE_INSTALL_STAGE_EVENT,
  type DesktopUpdateInstallStageDetail,
  type DesktopUpdateState,
  getDesktopBridge
} from "@/lib/desktop";
import { APP_BUILD_VERSION } from "@/lib/generated/build-meta";
import { VERSION_HIGHLIGHTS_STAGE_EVENT } from "@/lib/version-highlights-event";
import { cn } from "@/lib/utils";
import logoIcon from "@/images/ico.svg";
import logoMark from "@/images/logo.svg";

type DesktopFrameProps = PropsWithChildren;

function dispatchUpdateInstallStage(
  active: boolean,
  source: DesktopUpdateInstallStageDetail["source"]
) {
  window.dispatchEvent(
    new CustomEvent<DesktopUpdateInstallStageDetail>(DESKTOP_UPDATE_INSTALL_STAGE_EVENT, {
      detail: { active, source }
    })
  );
}

function dispatchVersionHighlightsStage() {
  window.dispatchEvent(new CustomEvent(VERSION_HIGHLIGHTS_STAGE_EVENT));
}

function DesktopFrameContent({ children }: DesktopFrameProps) {
  const [desktopBridge, setDesktopBridge] = useState<ReturnType<typeof getDesktopBridge>>(null);
  const [isMaximized, setIsMaximized] = useState(false);
  const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(null);
  const [installRequested, setInstallRequested] = useState(false);
  const isDesktop = Boolean(desktopBridge?.isDesktop);
  const { canToggle, isCompact, toggleCompact } = useAppLayout();
  const isStreamPopout = desktopBridge?.windowRole === "stream-popout";
  const showDesktopChrome = isDesktop && !isStreamPopout;
  const showUpdatePill = updateState?.status === "downloaded" && !installRequested;

  useEffect(() => {
    setDesktopBridge(getDesktopBridge());
  }, []);

  useEffect(() => {
    if (!isDesktop) {
      delete document.body.dataset.desktopShell;
      delete document.body.dataset.windowMaximized;
      return;
    }

    document.body.dataset.desktopShell = "true";
    document.body.dataset.windowMaximized = String(isMaximized);

    return () => {
      delete document.body.dataset.desktopShell;
      delete document.body.dataset.windowMaximized;
    };
  }, [isDesktop, isMaximized]);

  useEffect(() => {
    if (!desktopBridge?.subscribeWindowState) {
      return;
    }

    return desktopBridge.subscribeWindowState((state) => {
      setIsMaximized(state.maximized);
    });
  }, [desktopBridge]);

  useEffect(() => {
    if (!desktopBridge?.subscribeUpdateState) {
      return;
    }

    return desktopBridge.subscribeUpdateState((state) => {
      setUpdateState(state);
    });
  }, [desktopBridge]);

  useEffect(() => {
    if (updateState?.status === "installing") {
      dispatchUpdateInstallStage(true, "install");
      return;
    }

    if (updateState?.status !== "downloaded" && installRequested) {
      setInstallRequested(false);
      dispatchUpdateInstallStage(false, "install");
    }
  }, [installRequested, updateState?.status]);

  const handleUpdateClick = async () => {
    if (!desktopBridge || !updateState) {
      return;
    }

    if (updateState.status === "downloaded") {
      setInstallRequested(true);
      dispatchUpdateInstallStage(true, "install");

      try {
        const didStartInstall = await (
          desktopBridge.restartToUpdate ?? desktopBridge.installUpdate
        )?.();

        if (!didStartInstall) {
          setInstallRequested(false);
          dispatchUpdateInstallStage(false, "install");
        }
      } catch (error) {
        console.error("Unable to start desktop update install", error);
        setInstallRequested(false);
        dispatchUpdateInstallStage(false, "install");
      }
    }
  };

  return (
    <>
      {showDesktopChrome ? (
        <>
          <div className="desktop-titlebar">
            <div className="desktop-titlebar__drag-zone" />
            <div className="desktop-titlebar__brand">
              <div className="flex flex-col">
                <div className="flex items-center gap-3">
                  <Image
                    src={isCompact ? logoIcon : logoMark}
                    alt="SovChat logo"
                    width={isCompact ? 32 : 154}
                    height={isCompact ? 32 : 40}
                    priority
                    className={cn(
                      "desktop-titlebar__logo h-auto object-contain opacity-95",
                      isCompact ? "w-8" : "w-[92px]"
                    )}
                  />
                  {!isCompact ? (
                    <button
                      type="button"
                      onClick={dispatchVersionHighlightsStage}
                      className="version-indicator-button desktop-titlebar__version translate-y-[6px] text-left text-[11px] tracking-[0.14em] text-white/34 transition hover:text-[#8cf4f7] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgba(126,227,231,0.55)]"
                      aria-label="Open version highlights"
                      title="Open version highlights"
                    >
                      {APP_BUILD_VERSION}
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
            <div className="desktop-titlebar__controls">
              {canToggle ? (
                <HoverTooltip
                  label={isCompact ? "Expand layout" : "Compact layout"}
                  className="desktop-titlebar__layout-tooltip"
                  bubbleClassName="layout-mode-toggle-tooltip-bubble"
                >
                  <button
                    type="button"
                    className="desktop-titlebar__button desktop-titlebar__layout-button"
                    aria-label={isCompact ? "Expand SovChat layout" : "Compact SovChat layout"}
                    onClick={() => {
                      void toggleCompact();
                    }}
                  >
                    {isCompact ? (
                      <Expand className="h-4 w-4" strokeWidth={2.2} />
                    ) : (
                      <Shrink className="h-4 w-4" strokeWidth={2.2} />
                    )}
                  </button>
                </HoverTooltip>
              ) : null}
              <button
                type="button"
                className="desktop-titlebar__button"
                aria-label="Minimize window"
                title="Minimize"
                onClick={() => {
                  void desktopBridge?.minimizeWindow?.();
                }}
              >
                <Minus className="h-4 w-4" strokeWidth={2.2} />
              </button>
              {!isCompact ? (
                <button
                  type="button"
                  className="desktop-titlebar__button"
                  aria-label={isMaximized ? "Restore window" : "Maximize window"}
                  title={isMaximized ? "Restore" : "Maximize"}
                  onClick={() => {
                    void desktopBridge?.toggleMaximizeWindow?.();
                  }}
                >
                  {isMaximized ? (
                    <Copy className="h-3.5 w-3.5" strokeWidth={2.2} />
                  ) : (
                    <Square className="h-3.5 w-3.5" strokeWidth={2.2} />
                  )}
                </button>
              ) : null}
              <button
                type="button"
                className={cn("desktop-titlebar__button", "desktop-titlebar__button-close")}
                aria-label="Close window"
                title="Close"
                onClick={() => {
                  void desktopBridge?.closeWindow?.();
                }}
              >
                <span className="desktop-titlebar__close-glyph" aria-hidden="true">
                  X
                </span>
              </button>
            </div>
          </div>

          {showUpdatePill ? (
            <button
              type="button"
              className="desktop-update-pill"
              aria-label="Install downloaded SovChat update"
              onClick={() => {
                void handleUpdateClick();
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" strokeWidth={2.2} />
              <span>Update now</span>
            </button>
          ) : null}
        </>
      ) : null}

      <div
        className={cn(
          "desktop-app-surface",
          !isDesktop && "min-h-screen",
          showDesktopChrome && "pt-[48px]"
        )}
      >
        {children}
      </div>
    </>
  );
}

export function DesktopFrame({ children }: DesktopFrameProps) {
  return (
    <AppLayoutProvider>
      <DesktopFrameContent>{children}</DesktopFrameContent>
    </AppLayoutProvider>
  );
}
