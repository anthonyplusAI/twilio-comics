import type { Metadata } from "next";
import type { ReactNode } from "react";
import { SessionProvider } from "@/components/auth/session-provider";

export const metadata: Metadata = {
  title: "Comic Studio | Twilio Comics",
  description: "Browser studio for testing comic creation.",
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
