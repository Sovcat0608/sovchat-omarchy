"use client";

import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from "react";
import { getDesktopBridge } from "@/lib/desktop";
import {
  canToggleCompactLayout,
  MOBILE_COMPACT_MEDIA_QUERY,
  resolveCompactLayout
} from "@/lib/app-layout-policy";

type AppLayoutContextValue = {
  isCompact: boolean;
  canToggle: boolean;
  setCompact: (compact: boolean) => Promise<void>;
  toggleCompact: () => Promise<void>;
};

const AppLayoutContext = createContext<AppLayoutContextValue>({
  isCompact: false,
  canToggle: false,
  setCompact: async () => undefined,
  toggleCompact: async () => undefined
});

export function AppLayoutProvider({ children }: PropsWithChildren) {
  const [isCompact, setIsCompactState] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    const desktopBridge = getDesktopBridge();
    const desktop = Boolean(desktopBridge?.isDesktop);
    setIsDesktop(desktop);

    if (desktop) {
      return desktopBridge?.subscribeWindowState?.((state) => {
        setIsCompactState(
          resolveCompactLayout({
            isDesktop: true,
            desktopCompact: Boolean(state.compact),
            mobileViewport: false
          })
        );
      });
    }

    const mediaQuery = window.matchMedia(MOBILE_COMPACT_MEDIA_QUERY);
    const syncMobileLayout = () =>
      setIsCompactState(
        resolveCompactLayout({
          isDesktop: false,
          desktopCompact: false,
          mobileViewport: mediaQuery.matches
        })
      );
    syncMobileLayout();
    mediaQuery.addEventListener("change", syncMobileLayout);

    return () => mediaQuery.removeEventListener("change", syncMobileLayout);
  }, []);

  useEffect(() => {
    document.body.dataset.appLayout = isCompact ? "compact" : "expanded";

    return () => {
      delete document.body.dataset.appLayout;
    };
  }, [isCompact]);

  const setCompact = useCallback(async (compact: boolean) => {
    const desktopBridge = getDesktopBridge();
    if (!desktopBridge?.isDesktop || !desktopBridge.setCompactWindow) {
      return;
    }

    setIsCompactState(compact);
    try {
      const state = await desktopBridge.setCompactWindow(compact);
      setIsCompactState(Boolean(state.compact));
    } catch (error) {
      setIsCompactState(!compact);
      throw error;
    }
  }, []);

  const toggleCompact = useCallback(
    () => setCompact(!isCompact),
    [isCompact, setCompact]
  );

  const value = useMemo(
    () => ({
      isCompact,
      canToggle: canToggleCompactLayout(isDesktop),
      setCompact,
      toggleCompact
    }),
    [isCompact, isDesktop, setCompact, toggleCompact]
  );

  return <AppLayoutContext.Provider value={value}>{children}</AppLayoutContext.Provider>;
}

export function useAppLayout() {
  return useContext(AppLayoutContext);
}
