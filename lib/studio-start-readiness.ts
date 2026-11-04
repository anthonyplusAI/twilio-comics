import { getPublicOrigin } from "@/lib/public-origin";

/** A Studio link should appear only when its Google sign-in can admit users. */
export function isStudioStartReady(): boolean {
  if (!process.env.AUTH_SECRET?.trim() ||
      !process.env.AUTH_GOOGLE_ID?.trim() ||
      !process.env.AUTH_GOOGLE_SECRET?.trim()) {
    return false;
  }

  if (!getPublicOrigin()) return false;
  if (process.env.NODE_ENV !== "production") return true;

  return process.env.STUDIO_TESTER_EMAILS?.split(",").some((entry) =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.trim()),
  ) ?? false;
}
