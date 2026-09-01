"use client";

import Image from "next/image";
import { FormEvent, useEffect, useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import createIllustration from "@/images/create.svg";
import joinIllustration from "@/images/join.svg";
import logoMark from "@/images/logo.svg";

type RoomOnboardingModalProps = {
  isOpen: boolean;
  nickname: string;
  isPending: boolean;
  error: string | null;
  onCreateRoom: (name: string, code: string) => Promise<void> | void;
  onJoinRoom: (code: string) => Promise<void> | void;
};

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateRoomCode() {
  return Array.from({ length: 8 }, () => {
    const index = Math.floor(Math.random() * ROOM_CODE_ALPHABET.length);
    return ROOM_CODE_ALPHABET[index];
  }).join("");
}

export function RoomOnboardingModal({
  isOpen,
  nickname,
  isPending,
  error,
  onCreateRoom,
  onJoinRoom
}: RoomOnboardingModalProps) {
  const [createName, setCreateName] = useState("");
  const [createCode, setCreateCode] = useState("");
  const [joinCode, setJoinCode] = useState("");

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setCreateName((previous) => previous || `${nickname.split(" ")[0] || "My"}'s room`);
    setCreateCode((previous) => previous || generateRoomCode());
  }, [isOpen, nickname]);

  if (!isOpen) {
    return null;
  }

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onCreateRoom(createName, createCode);
  }

  function handleJoin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onJoinRoom(joinCode);
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[rgba(25,40,44,0.4)] backdrop-blur-md">
      <div className="relative min-h-screen overflow-hidden bg-[#203539] px-6 py-8 sm:px-10 sm:py-10">
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.012),transparent_36%)]" />
        <div className="relative flex items-start justify-between gap-4">
          <Image
            src={logoMark}
            alt="SovChat logo"
            width={154}
            height={40}
            priority
            className="h-auto w-[106px] object-contain opacity-95 sm:w-[132px]"
          />

          <div />
        </div>

        <div className="relative mx-auto flex min-h-[calc(100vh-8rem)] w-full max-w-[104rem] items-center justify-center">
          <div className="flex w-full max-w-[50rem] flex-col items-center gap-10">
            <div className="flex w-full max-w-[34rem] flex-col items-center text-center">
              <p className="text-[11px] font-semibold uppercase tracking-[0.3em] text-[#71dce1]">
                First Room Setup
              </p>
              <h1 className="mt-3 whitespace-nowrap text-4xl font-semibold leading-[1.02] text-white sm:text-[3.45rem]">
                Choose where to start
              </h1>
              <p className="mt-4 max-w-[25rem] text-sm leading-6 text-white/64 sm:text-[15px]">
                Create a room for your group, or join one with a room code.
              </p>

              {error ? (
                <div className="mt-6 w-full rounded-2xl border border-[color:rgba(255,123,123,0.22)] bg-[color:rgba(255,123,123,0.08)] px-4 py-3 text-sm text-[var(--danger)]">
                  {error}
                </div>
              ) : null}
            </div>

            <div className="grid w-full max-w-[39rem] items-stretch gap-6 sm:grid-cols-2">
              <form
                onSubmit={handleCreate}
                className="flex min-h-[32rem] flex-col rounded-[2rem] border border-[#37545a] bg-[#334f54] px-8 py-7 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]"
              >
                <div className="flex h-[5.5rem] items-center justify-center">
                  <Image
                    src={createIllustration}
                    alt=""
                    width={80}
                    height={52}
                    className="h-16 w-auto drop-shadow-[0_12px_28px_rgba(7,13,15,0.48)]"
                  />
                </div>
                <h2 className="mt-8 whitespace-nowrap text-[1.45rem] font-medium leading-tight text-white sm:text-[1.6rem]">
                  Create your room
                </h2>

                <div className="mt-10 flex flex-1 flex-col">
                  <label className="block text-sm text-white/84">
                    <span className="mb-2 block">Room name</span>
                    <input
                      value={createName}
                      onChange={(event) => setCreateName(event.target.value)}
                      maxLength={32}
                      placeholder="The cool squad..."
                      className="w-full rounded-2xl border bg-[#2d474c] px-4 py-3.5 text-white outline-none transition placeholder:text-white/42"
                      style={{ borderColor: "rgba(68, 208, 213, 0.12)" }}
                    />
                  </label>

                  <label className="mt-6 block text-sm text-white/84">
                    <span className="mb-2 block">Room code</span>
                    <span className="relative block">
                      <input
                        value={createCode}
                        onChange={(event) => setCreateCode(event.target.value.toUpperCase())}
                        maxLength={12}
                        placeholder="Create room code"
                        className="w-full rounded-2xl border bg-[#2d474c] px-4 py-3.5 pr-12 uppercase tracking-[0.18em] text-white outline-none transition placeholder:text-white/42"
                        style={{ borderColor: "rgba(68, 208, 213, 0.12)" }}
                      />
                      <button
                        type="button"
                        onClick={() => setCreateCode(generateRoomCode())}
                        className="absolute right-3 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-[#4ee1e6] transition hover:bg-white/6 hover:text-white"
                        aria-label="Generate room code"
                      >
                        <RefreshCw className="h-4 w-4" />
                      </button>
                    </span>
                  </label>

                  <button
                    type="submit"
                    disabled={isPending}
                    className="mt-auto inline-flex w-full items-center justify-center gap-3 rounded-2xl bg-[#52d9de] px-5 py-4 font-semibold tracking-[0.08em] text-slate-950 shadow-[0_0_22px_rgba(82,217,222,0.32)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    {isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
                    CREATE
                  </button>
                </div>
              </form>

              <form
                onSubmit={handleJoin}
                className="flex min-h-[32rem] flex-col rounded-[2rem] border border-[#37545a] bg-[#334f54] px-8 py-7 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]"
              >
                <div className="flex h-[5.5rem] items-center justify-center">
                  <Image
                    src={joinIllustration}
                    alt=""
                    width={80}
                    height={52}
                    className="h-16 w-auto drop-shadow-[0_12px_28px_rgba(7,13,15,0.48)]"
                  />
                </div>
                <h2 className="mt-8 whitespace-nowrap text-[1.45rem] font-medium leading-tight text-white sm:text-[1.6rem]">
                  Join a room
                </h2>

                <div className="flex flex-1 flex-col">
                  <label className="mt-10 block text-sm text-white/84">
                    <span className="mb-2 block">Room code</span>
                    <input
                      value={joinCode}
                      onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                      maxLength={12}
                      placeholder="Enter room code"
                      className="w-full rounded-2xl border bg-[#2d474c] px-4 py-3.5 uppercase tracking-[0.18em] text-white outline-none transition placeholder:text-white/42"
                      style={{ borderColor: "rgba(68, 208, 213, 0.12)" }}
                    />
                  </label>

                  <button
                    type="submit"
                    disabled={isPending}
                    className="mt-auto inline-flex w-full items-center justify-center gap-3 rounded-2xl bg-[#ffca2a] px-5 py-4 font-semibold tracking-[0.08em] text-slate-950 shadow-[0_0_22px_rgba(255,202,42,0.28)] transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    {isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
                    JOIN
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
