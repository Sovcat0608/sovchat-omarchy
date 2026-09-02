"use client";

import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { CheckCircle2, KeyRound, LoaderCircle, LockKeyhole, Mail, UserRound } from "lucide-react";
import logoMark from "@/images/logo.svg";
import { apiFetch, resolveApiUrl } from "@/lib/api-client";
import { getDesktopBridge } from "@/lib/desktop";
import { setDesktopSessionToken } from "@/lib/desktop-auth";
import { loginSchema, resendVerificationSchema, signupSchema } from "@/lib/validators";
import { APP_BUILD_VARIANT } from "@/lib/generated/build-meta";

type AuthMode = "login" | "signup";

type LoginFormProps = {
  mode: AuthMode;
  successPath?: string;
  onModeChange: (mode: AuthMode) => void;
};

type AuthCopy = {
  submitLabel: string;
  alternateText: string;
  alternateHref: "/login" | "/signup";
  alternateLabel: string;
};

type ApiError = {
  error?: string;
  code?: string;
  message?: string;
};

const REMEMBERED_EMAIL_KEY = "sovchat.remembered-email";
const REMEMBERED_LOGIN_KEY = "sovchat.remembered-login";

function getBrowserSafeOrigin(origin: string) {
  try {
    const url = new URL(origin);

    if (url.hostname === "0.0.0.0" || url.hostname === "[::]" || url.hostname === "::") {
      url.hostname = "127.0.0.1";
    }

    return url.origin;
  } catch {
    return origin;
  }
}

function getReturnToUrl(successPath: string) {
  if (typeof window === "undefined") {
    return successPath;
  }

  if (window.location.protocol === "app:" && window.location.host) {
    return `${window.location.protocol}//${window.location.host}${successPath}`;
  }

  return `${getBrowserSafeOrigin(window.location.origin)}${successPath}`;
}

export function LoginForm({
  mode,
  successPath = "/app/voice",
  onModeChange
}: LoginFormProps) {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState("");
  const [betaAccessCode, setBetaAccessCode] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [verificationEmail, setVerificationEmail] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [isResending, setIsResending] = useState(false);

  const copy = useMemo<AuthCopy>(() => {
    if (mode === "signup") {
      return {
        submitLabel: "Create account",
        alternateText: "Already have an account?",
        alternateHref: "/login",
        alternateLabel: "Sign in"
      };
    }

    return {
      submitLabel: "Sign in",
      alternateText: "Need an account?",
      alternateHref: "/signup",
      alternateLabel: "Create one"
    };
  }, [mode]);

  useEffect(() => {
    if (typeof window === "undefined" || mode !== "login") {
      return;
    }

    const rememberedEmail = window.localStorage.getItem(REMEMBERED_EMAIL_KEY) ?? "";
    const rememberedLogin = window.localStorage.getItem(REMEMBERED_LOGIN_KEY) === "true";

    if (rememberedEmail) {
      setEmail(rememberedEmail);
    }

    setRememberMe(rememberedLogin);
  }, [mode]);

  useEffect(() => {
    const desktopSessionToken = searchParams.get("desktopSessionToken");
    const authError = searchParams.get("authError");
    const rememberedFromGoogle = searchParams.get("rememberMe") === "true";

    if (authError) {
      setError(decodeURIComponent(authError));
    }

    if (!desktopSessionToken) {
      return;
    }

    setDesktopSessionToken(desktopSessionToken, rememberedFromGoogle);
    if (rememberedFromGoogle) {
      window.localStorage.setItem(REMEMBERED_LOGIN_KEY, "true");
    }
    window.location.assign(successPath);
  }, [searchParams, successPath]);

  async function handleResendVerification() {
    const parsed = resendVerificationSchema.safeParse({ email: verificationEmail ?? email });

    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Enter a valid email address.");
      return;
    }

    setError(null);
    setSuccess(null);
    setIsResending(true);

    try {
      const response = await apiFetch("/api/auth/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data)
      });

      const payload = (await response.json().catch(() => null)) as ApiError | null;

      if (!response.ok) {
        setError(payload?.error ?? payload?.message ?? "Unable to resend verification email.");
        return;
      }

      setSuccess(payload?.message ?? "Verification email sent.");
    } finally {
      setIsResending(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    setVerificationEmail(null);

    const parsed =
      mode === "signup"
        ? signupSchema.safeParse({
            email,
            password,
            nickname,
            betaAccessCode
          })
        : loginSchema.safeParse({
            email,
            password,
            rememberMe
          });

    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check your form and try again.");
      return;
    }

    setIsPending(true);

    try {
      let disconnectOtherSessions = false;

      while (true) {
        const requestBody =
          mode === "login" ? { ...parsed.data, disconnectOtherSessions } : parsed.data;
        const response = await apiFetch(mode === "signup" ? "/api/auth/signup" : "/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody)
        });

        const payload = (await response.json().catch(() => null)) as
          | (ApiError & { sessionToken?: string })
          | { email?: string; message?: string; sessionToken?: string }
          | null;

        if (!response.ok) {
          const apiError = payload as ApiError | null;

          if (mode === "login" && apiError?.code === "SESSION_CONFLICT" && !disconnectOtherSessions) {
            const shouldDisconnect = window.confirm("Disconnect session on other device?");

            if (shouldDisconnect) {
              disconnectOtherSessions = true;
              continue;
            }

            setError("Sign-in cancelled. Your other session is still connected.");
            return;
          }

          if (apiError?.code === "EMAIL_NOT_VERIFIED") {
            setVerificationEmail(parsed.data.email);
          }

          setError(
            apiError?.error ?? apiError?.message ?? `Request failed (${response.status}).`
          );
          return;
        }

        if (payload?.sessionToken) {
          setDesktopSessionToken(payload.sessionToken, mode === "login" ? rememberMe : true);
        }

        if (mode === "signup") {
          setVerificationEmail(parsed.data.email);
          setSuccess(payload?.message ?? "Check your inbox to verify your email.");
          setPassword("");
          return;
        }

        if (rememberMe) {
          window.localStorage.setItem(REMEMBERED_EMAIL_KEY, parsed.data.email);
          window.localStorage.setItem(REMEMBERED_LOGIN_KEY, "true");
        } else {
          window.localStorage.removeItem(REMEMBERED_EMAIL_KEY);
          window.localStorage.removeItem(REMEMBERED_LOGIN_KEY);
        }

        window.location.assign(successPath);
        return;
      }
    } catch {
      setError("Unable to reach the server right now. Please try again.");
    } finally {
      setIsPending(false);
    }
  }

  function handleGoogleSignIn() {
    const returnTo = getReturnToUrl(successPath);
    const startUrl = new URL(
      resolveApiUrl("/api/auth/google/start"),
      typeof window !== "undefined" ? window.location.origin : undefined
    );
    const desktopBridge = getDesktopBridge();
    startUrl.searchParams.set("returnTo", returnTo);
    startUrl.searchParams.set("rememberMe", rememberMe ? "true" : "false");
    if (mode === "signup" && betaAccessCode.trim()) {
      startUrl.searchParams.set("betaAccessCode", betaAccessCode.trim());
    }
    if (desktopBridge?.isDesktop) {
      startUrl.searchParams.set("clientKind", "desktop");
      startUrl.searchParams.set("appVariant", APP_BUILD_VARIANT);
    }
    window.location.assign(startUrl.toString());
  }

  return (
    <div className="mx-auto w-full max-w-[26rem] px-7 py-6 text-white sm:px-10 sm:py-8">
      <div className="mx-auto flex max-w-[19rem] flex-col items-center text-center">
        <div className="mb-8 flex h-32 w-32 items-center justify-center">
          <Image src={logoMark} alt="SovChat logo" width={368} height={368} priority />
        </div>
      </div>

      <form onSubmit={handleSubmit} className="mx-auto mt-5 max-w-[19rem] space-y-3.5">
        {mode === "signup" ? (
          <>
            <label className="block">
              <span className="relative block">
                <UserRound className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-white/34" />
                <input
                  value={nickname}
                  onChange={(event) => setNickname(event.target.value)}
                  maxLength={20}
                  className="auth-input w-full rounded-2xl px-12 py-4 outline-none transition"
                  placeholder="display name"
                />
              </span>
            </label>
            <label className="block">
              <span className="relative block">
                <KeyRound className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-white/34" />
                <input
                  value={betaAccessCode}
                  onChange={(event) => setBetaAccessCode(event.target.value)}
                  maxLength={80}
                  className="auth-input w-full rounded-2xl px-12 py-4 outline-none transition"
                  placeholder="beta access code"
                  autoComplete="one-time-code"
                />
              </span>
            </label>
          </>
        ) : null}

        <label className="block">
          <span className="relative block">
            <Mail className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-white/34" />
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="auth-input w-full rounded-2xl px-12 py-4 outline-none transition"
              placeholder="email"
              autoComplete="email"
            />
          </span>
        </label>

        <label className="block">
          <span className="relative block">
            <LockKeyhole className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-white/34" />
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="auth-input w-full rounded-2xl px-12 py-4 outline-none transition"
              placeholder="password"
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
            />
          </span>
        </label>

        {mode === "login" ? (
          <label className="flex items-center gap-3 pt-1 text-sm text-white/56">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(event) => setRememberMe(event.target.checked)}
              className="h-4 w-4 rounded border border-white/18 bg-transparent accent-[var(--accent)]"
            />
            <span>Remember me</span>
          </label>
        ) : null}

        {error ? (
          <p className="rounded-2xl border border-[color:rgba(255,123,123,0.14)] bg-[color:rgba(255,123,123,0.06)] px-4 py-3 text-sm text-[var(--danger)]">
            {error}
          </p>
        ) : null}

        {success ? (
          <p className="rounded-2xl border border-[color:rgba(126,227,231,0.2)] bg-[color:rgba(126,227,231,0.08)] px-4 py-3 text-sm text-[#aaf2f4]">
            {success}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={isPending}
          className="mt-2 flex w-full items-center justify-center gap-3 rounded-2xl border border-[rgba(255,166,0,0.3)] bg-[linear-gradient(180deg,#ff9a10_0%,#ffb31a_100%)] px-5 py-4 text-[1rem] font-semibold text-[#17161f] shadow-[0_14px_34px_rgba(255,166,0,0.18)] transition hover:-translate-y-0.5 hover:shadow-[0_20px_46px_rgba(255,166,0,0.22)] disabled:cursor-not-allowed disabled:opacity-70"
        >
          {isPending ? <LoaderCircle className="h-[18px] w-[18px] animate-spin" strokeWidth={2.1} /> : null}
          {copy.submitLabel}
        </button>

        <button
          type="button"
          onClick={handleGoogleSignIn}
          className="flex w-full items-center justify-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-5 py-4 text-[0.96rem] font-medium text-white transition hover:border-white/16 hover:bg-white/[0.05]"
        >
          <span aria-hidden="true" className="auth-google-g">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none">
              <path d="M21.6 12.23c0-.68-.06-1.33-.18-1.95H12v3.69h5.39a4.6 4.6 0 0 1-2 3.02v2.5h3.24c1.9-1.76 2.97-4.35 2.97-7.26Z" fill="#4285F4" />
              <path d="M12 22c2.7 0 4.96-.9 6.61-2.43l-3.24-2.5c-.9.6-2.05.96-3.37.96-2.59 0-4.78-1.75-5.56-4.11H3.09v2.57A10 10 0 0 0 12 22Z" fill="#34A853" />
              <path d="M6.44 13.92A6.02 6.02 0 0 1 6.13 12c0-.67.12-1.31.31-1.92V7.51H3.09a10 10 0 0 0 0 8.98l3.35-2.57Z" fill="#FBBC05" />
              <path d="M12 5.97c1.47 0 2.78.5 3.82 1.47l2.86-2.86C16.95 2.96 14.7 2 12 2A10 10 0 0 0 3.09 7.51l3.35 2.57C7.22 7.72 9.41 5.97 12 5.97Z" fill="#EA4335" />
            </svg>
          </span>
          Continue with Google
        </button>
      </form>

      {verificationEmail ? (
        <div className="mx-auto mt-6 max-w-[19rem] rounded-2xl border border-white/8 bg-white/[0.03] p-4">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 text-[#7ee3e7]" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-white">Need a fresh verification email?</p>
              <p className="mt-1 text-sm leading-6 text-white/65">
                We&apos;ll resend it to <span className="text-white">{verificationEmail}</span>.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleResendVerification}
            disabled={isResending}
            className="ui-button mt-4 inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm text-white transition hover:bg-white/8 disabled:opacity-60"
          >
            {isResending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
            Resend verification
          </button>
        </div>
      ) : null}

      <div className="mx-auto mt-8 flex max-w-[19rem] flex-col items-center gap-3 pt-4 text-center text-sm">
        <p className="text-white/42">
          {copy.alternateText}{" "}
          <button
            type="button"
            onClick={() => onModeChange(copy.alternateHref === "/signup" ? "signup" : "login")}
            className="font-medium text-white transition hover:text-[var(--accent)]"
          >
            {copy.alternateLabel}
          </button>
        </p>

      </div>
    </div>
  );
}
