import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SessionProvider } from "@/components/auth/session-provider";

export const metadata: Metadata = {
  title: "Comic Studio | Twilio Comics",
  description: "Take or upload reference photos, add your idea, and create a personalized comic in Twilio Comics Browser Studio.",
  robots: {
    index: false,
    follow: false,
  },
};

export default function StudioLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return <SessionProvider>{children}</SessionProvider>;
}
