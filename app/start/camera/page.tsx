import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getBrowserStudioEnabled } from "@/lib/browser-studio-settings";
import { isStudioStartReady } from "@/lib/studio-start-readiness";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Browser Studio | Twilio Comics",
  robots: { index: false, follow: false },
};

/** Old QR codes now lead to the single browser creation experience. */
export default async function CameraPage() {
  redirect(await getBrowserStudioEnabled() && isStudioStartReady() ? "/studio" : "/start");
}
