"use client";

import { ChangeEvent, useEffect, useId, useRef, useState, useTransition } from "react";
import { Camera, LoaderCircle, LogOut, RefreshCcw, UserRound, X } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import type { ProfileResponse } from "@/types";
import { nicknameSchema } from "@/lib/validators";

type AvatarDrawerProps = {
  isOpen: boolean;
  onClose: () => void;
  nickname: string;
  avatarId: string;
  avatarDataUrl: string | null;
  onProfileChange: (value: {
    nickname?: string | null;
    avatarId?: string;
    avatarDataUrl?: string | null;
  }) => void;
  onLogout: () => void | Promise<void>;
};

const REMEMBERED_NICKNAME_KEY = "sovchat.rememberedNickname";

async function fileToDataUrl(file: File) {
  const imageBitmap = await createImageBitmap(file);
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext("2d");
  if (!context) {
    imageBitmap.close();
    throw new Error("Canvas is not available in this browser.");
  }

  const scale = Math.max(size / imageBitmap.width, size / imageBitmap.height);
  const drawWidth = imageBitmap.width * scale;
  const drawHeight = imageBitmap.height * scale;
  const dx = (size - drawWidth) / 2;
  const dy = (size - drawHeight) / 2;

  context.clearRect(0, 0, size, size);
  context.drawImage(imageBitmap, dx, dy, drawWidth, drawHeight);
  imageBitmap.close();

  return canvas.toDataURL("image/webp", 0.9);
}
export function AvatarDrawer({
  isOpen,
  onClose,
  nickname,
  avatarId,
  avatarDataUrl,
  onProfileChange,
  onLogout
}: AvatarDrawerProps) {
  const [draftName, setDraftName] = useState(nickname);
  const [nameError, setNameError] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [isSavingName, startSavingName] = useTransition();
  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const avatarPreviewSrc = avatarDataUrl || `/avatars/${avatarId}.png`;

  useEffect(() => {
    if (isOpen) {
      setDraftName(nickname);
      setNameError(null);
      setAvatarError(null);
    }
  }, [isOpen, nickname]);

  async function handleNameSubmit() {
    const parsed = nicknameSchema.safeParse(draftName);
    if (!parsed.success) {
      setNameError(parsed.error.issues[0]?.message ?? "Enter a valid nickname.");
      return;
    }

    setNameError(null);

    startSavingName(async () => {
      const response = await apiFetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nickname: parsed.data })
      });

      const payload = (await response.json().catch(() => null)) as
        | ({ error?: string; ok?: boolean } & ProfileResponse)
        | null;

      if (!response.ok || !payload?.nickname) {
        setNameError(payload?.error ?? "Unable to update nickname.");
        return;
      }

      onProfileChange({
        nickname: payload.nickname,
        avatarId: payload.avatarId,
        avatarDataUrl: payload.avatarDataUrl
      });
      if (typeof window !== "undefined") {
        window.localStorage.setItem(REMEMBERED_NICKNAME_KEY, payload.nickname);
      }
    });
  }

  async function handleAvatarUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) {
      return;
    }

    if (!file.type.startsWith("image/")) {
      setAvatarError("Choose an image file for your avatar.");
      return;
    }

    try {
      const nextAvatarDataUrl = await fileToDataUrl(file);
      const response = await apiFetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatarDataUrl: nextAvatarDataUrl })
      });
      const payload = (await response.json().catch(() => null)) as
        | ({ error?: string; ok?: boolean } & ProfileResponse)
        | null;

      if (!response.ok || !payload) {
        setAvatarError(payload?.error ?? "Unable to update your avatar.");
        return;
      }

      onProfileChange({
        nickname: payload.nickname,
        avatarId: payload.avatarId,
        avatarDataUrl: payload.avatarDataUrl
      });
      setAvatarError(null);
    } catch {
      setAvatarError("Unable to process that image. Try another file.");
    }
  }

  return (
    <div
      className={`fixed inset-0 z-40 transition ${isOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
      aria-hidden={!isOpen}
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default bg-transparent"
        aria-label="Close avatar settings"
        onClick={onClose}
      />
      <div
        className={`absolute bottom-14 left-1/2 w-[min(92vw,28rem)] -translate-x-1/2 transition duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] sm:bottom-16 ${
          isOpen ? "translate-y-0 scale-100 opacity-100" : "translate-y-4 scale-[0.98] opacity-0"
        }`}
        onClick={(event) => event.stopPropagation()}
      >
        <section className="surface-panel rounded-[1.8rem] p-5 shadow-[0_18px_50px_rgba(0,0,0,0.24)] backdrop-blur-xl">
          <div className="flex items-center justify-between gap-4">
            <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-[var(--accent)]">
              Avatar Settings
            </p>
            <button
              type="button"
              onClick={onClose}
              className="ui-button inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-2xl p-2 text-[var(--muted)] transition hover:border-white/16 hover:bg-white/[0.05] hover:text-white"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="mt-4">
            <div className="mb-4 flex items-center gap-3">
              <UserRound className="h-5 w-5 text-[var(--accent)]" />
              <div>
                <p className="font-medium">Profile</p>
              </div>
            </div>

            <div className="flex items-center gap-4 rounded-[1.6rem] border border-white/8 bg-white/[0.03] p-4">
              <div className="relative h-24 w-24 flex-shrink-0 overflow-hidden rounded-full">
                <img src={avatarPreviewSrc} alt="" className="h-full w-full object-contain" />
              </div>

              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-white">Avatar image</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <label
                    htmlFor={fileInputId}
                    className="ui-button inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl px-4 py-2 text-white transition hover:border-[var(--accent)]"
                  >
                    <Camera className="h-4 w-4" />
                    Upload avatar
                  </label>
                  {avatarDataUrl ? (
                    <button
                      type="button"
                      onClick={async () => {
                        const response = await apiFetch("/api/profile", {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ avatarDataUrl: null })
                        });
                        const payload = (await response.json().catch(() => null)) as
                          | ({ error?: string; ok?: boolean } & ProfileResponse)
                          | null;

                        if (!response.ok || !payload) {
                          setAvatarError(payload?.error ?? "Unable to restore the default avatar.");
                          return;
                        }

                        onProfileChange({
                          nickname: payload.nickname,
                          avatarId: payload.avatarId,
                          avatarDataUrl: payload.avatarDataUrl
                        });
                        setAvatarError(null);
                        fileInputRef.current?.focus();
                      }}
                      className="ui-button inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-white/84 transition hover:border-white/16 hover:bg-white/[0.05] hover:text-white"
                    >
                      <RefreshCcw className="h-4 w-4" />
                      Use default
                    </button>
                  ) : null}
                </div>
                <input
                  ref={fileInputRef}
                  id={fileInputId}
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  onChange={handleAvatarUpload}
                />
                {avatarError ? (
                  <p className="mt-3 text-sm text-[var(--danger)]">{avatarError}</p>
                ) : null}
              </div>
            </div>

            <div className="mt-5 border-t border-white/6 pt-5">
              <label className="mb-3 block text-sm font-medium text-white" htmlFor="profile-name">
                Display name
              </label>
              <div className="flex gap-3">
                <input
                  id="profile-name"
                  type="text"
                  value={draftName}
                  onChange={(event) => setDraftName(event.target.value)}
                  maxLength={20}
                  className="ui-input h-12 flex-1 rounded-xl px-4 transition"
                  placeholder="Your display name"
                />
                <button
                  type="button"
                  onClick={() => void handleNameSubmit()}
                  disabled={isSavingName}
                  className="ui-button inline-flex h-12 min-w-28 items-center justify-center gap-2 rounded-xl px-4 font-medium text-white transition hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {isSavingName ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
                  Save
                </button>
              </div>
              <p className="mt-2 text-sm text-white/60">
                2-20 characters. Letters, numbers, spaces, and underscores only.
              </p>
              {nameError ? (
                <p className="mt-2 text-sm text-[var(--danger)]">{nameError}</p>
              ) : null}
            </div>

            <div className="mt-5 border-t border-white/6 pt-5">
              <button
                type="button"
                onClick={() => {
                  onClose();
                  void onLogout();
                }}
                className="ui-button inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium text-white/84 transition hover:border-[rgba(255,123,123,0.36)] hover:bg-[rgba(255,123,123,0.1)] hover:text-[#ffb8b8]"
                aria-label="Log out"
              >
                <LogOut className="h-4 w-4" strokeWidth={2.2} />
                Log out
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
