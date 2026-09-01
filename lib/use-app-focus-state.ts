"use client";

import { useEffect, useState } from "react";

type AppFocusState = {
  isAppFocused: boolean;
  isDocumentVisible: boolean;
  isWindowFocused: boolean;
};

function buildFocusState(isDocumentVisible: boolean, isWindowFocused: boolean): AppFocusState {
  return {
    isAppFocused: isDocumentVisible && isWindowFocused,
    isDocumentVisible,
    isWindowFocused
  };
}

function readInitialFocusState(): AppFocusState {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return buildFocusState(true, true);
  }

  const isDocumentVisible = document.visibilityState !== "hidden";
  const hasFocus = typeof document.hasFocus === "function" ? document.hasFocus() : true;
  const isWindowFocused = isDocumentVisible ? true : hasFocus;
  return buildFocusState(isDocumentVisible, isWindowFocused);
}

export function useAppFocusState() {
  const [focusState, setFocusState] = useState<AppFocusState>(() => readInitialFocusState());

  useEffect(() => {
    let windowFocused =
      typeof document.hasFocus === "function"
        ? document.hasFocus() || document.visibilityState !== "hidden"
        : true;

    const syncFocusState = () => {
      const isDocumentVisible = document.visibilityState !== "hidden";
      if (!isDocumentVisible) {
        windowFocused = false;
      }
      setFocusState(buildFocusState(isDocumentVisible, windowFocused));
    };

    const handleFocus = () => {
      windowFocused = true;
      syncFocusState();
    };

    const handleBlur = () => {
      windowFocused = false;
      syncFocusState();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "hidden") {
        windowFocused = true;
      }
      syncFocusState();
    };

    syncFocusState();

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  return focusState;
}
