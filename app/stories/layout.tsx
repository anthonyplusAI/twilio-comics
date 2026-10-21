import type { ReactNode } from "react";
import { SessionProvider } from "@/components/auth/session-provider";

export default function StoriesLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return <SessionProvider>{children}</SessionProvider>;
}
