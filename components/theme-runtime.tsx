"use client";

import { useEffect, useSyncExternalStore } from "react";
import { themeStore } from "@/lib/theme-store";

export function ThemeRuntime() {
  const themeId = useSyncExternalStore(
    themeStore.subscribe,
    themeStore.getState,
    themeStore.getServerState
  );
  useEffect(() => {
    document.body.dataset.theme = themeId;
  }, [themeId]);

  useEffect(() => {
    document.body.dataset.uiMode = "omarchy";
  }, []);

  return null;
}
