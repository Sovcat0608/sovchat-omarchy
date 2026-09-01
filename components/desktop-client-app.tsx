"use client";

import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { LoginForm } from "@/components/login-form";
import { apiFetch } from "@/lib/api-client";
import {
  clearDesktopSessionToken,
  getDesktopSessionPersistence,
  getDesktopSessionToken,
  setDesktopSessionToken
} from "@/lib/desktop-auth";
import type { AppSession, SessionResponse } from "@/types";
import { APP_BUILD_VARIANT } from "@/lib/generated/build-meta";

export function DesktopClientApp() {
  const [session, setSession] = useState<AppSession | null>(null);
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [isCheckingSession, setIsCheckingSession] = useState(true);

  useEffect(() => {
    let active = true;
    const devMode = process.env.NEXT_PUBLIC_DESKTOP_DEV_MODE === "true";

    const devSession: AppSession = {
      sessionId: "desktop-dev-session",
      userId: "desktop-dev-user",
      email: "local@sovchat.test",
      nickname: process.env.NEXT_PUBLIC_DESKTOP_DEV_NICKNAME ?? "Local Tester",
      appVariant: APP_BUILD_VARIANT,
      avatarId: "avatar-1",
      avatarDataUrl: null,
      emailVerifiedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString()
    };

    async function loadSession() {
      const token = getDesktopSessionToken();

      if (!token) {
        if (active) {
          setSession(devMode ? devSession : null);
          setIsCheckingSession(false);
        }
        return;
      }

      const response = await apiFetch("/api/auth/session", {
        cache: "no-store"
      }).catch(() => null);

      if (!active) {
        return;
      }

      if (!response?.ok) {
        clearDesktopSessionToken();
        setSession(devMode ? devSession : null);
        setIsCheckingSession(false);
        return;
      }

      const payload = (await response.json().catch(() => null)) as SessionResponse | null;

      if (!payload?.session) {
        clearDesktopSessionToken();
        setSession(devMode ? devSession : null);
        setIsCheckingSession(false);
        return;
      }

      if (payload.sessionToken) {
        setDesktopSessionToken(payload.sessionToken, getDesktopSessionPersistence() === "local");
      }

      setSession(payload.session);
      setIsCheckingSession(false);
    }

    void loadSession();

    return () => {
      active = false;
    };
  }, []);

  if (isCheckingSession) {
    return (
      <main className="desktop-login-page flex min-h-screen items-center justify-center px-6 py-10 sm:py-14">
        <div className="desktop-login-center flex w-full justify-center">
          <div className="glass-panel flex w-full max-w-[24rem] items-center justify-center gap-3 rounded-[2rem] px-6 py-8 text-white">
            <LoaderCircle className="h-5 w-5 animate-spin text-[var(--accent)]" />
            <span>Connecting to SovChat...</span>
          </div>
        </div>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="desktop-login-page flex min-h-screen items-center justify-center px-6 py-10 sm:py-14">
        <div className="desktop-login-center flex w-full max-w-[31rem] flex-col gap-4">
          <LoginForm mode={mode} successPath="/desktop" onModeChange={setMode} />
        </div>
      </main>
    );
  }

  return (
    <AppShell
      userId={session.userId}
      nickname={session.nickname}
      forceVoiceRoute
      logoutRedirectPath="/desktop"
      onLogout={() => {
        setSession(null);
        setMode("login");
      }}
    >
      {null}
    </AppShell>
  );
}
