import type { Metadata } from "next";
import "./globals.css";
import { DesktopFrame } from "@/components/desktop-frame";
import { ThemeRuntime } from "@/components/theme-runtime";
import { APP_NAME } from "@/lib/constants";

export const metadata: Metadata = {
  title: APP_NAME,
  description: "Private group chat with voice and screen sharing."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <ThemeRuntime />
        <DesktopFrame>{children}</DesktopFrame>
      </body>
    </html>
  );
}
