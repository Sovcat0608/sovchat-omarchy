"use client";

import dynamic from "next/dynamic";

const DesktopClientApp = dynamic(
  () => import("@/components/desktop-client-app").then((module) => module.DesktopClientApp),
  { ssr: false }
);

export default function DesktopPage() {
  return <DesktopClientApp />;
}
