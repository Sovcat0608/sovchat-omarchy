"use client";

import dynamic from "next/dynamic";

const DesktopStreamPopout = dynamic(
  () => import("@/components/desktop-stream-popout").then((module) => module.DesktopStreamPopout),
  { ssr: false }
);

export default function DesktopPopoutPage() {
  return <DesktopStreamPopout />;
}
