import { NextResponse } from "next/server";
import { getMarketingContact } from "@/lib/marketing-contact";
import { getExperienceSettings, type ExperienceSettings } from "@/lib/photo-experience-settings";
import { getPublicEnabledChannels } from "@/lib/public-channel-readiness";
import { isVoiceVerificationConfigured } from "@/lib/voice-verification";

const ACCOUNT_SID = /^AC[0-9a-f]{32}$/i;

export type CameraDestination = {
  phoneNumber: string;
  smsHref: string | null;
  callHref: string | null;
};

function hasPublicOrigin(): boolean {
  const configured = process.env.PUBLIC_BASE_URL?.trim();
  if (!configured) return false;
  try {
    const url = new URL(configured);
    const localHttp = url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    return (url.protocol === "https:" || localHttp) &&
      !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/** Camera entry requires an admin opt-in, Verify, and a ready text/call path. */
export async function getCameraDestination(
  settings?: ExperienceSettings,
): Promise<CameraDestination | null> {
  const contact = getMarketingContact(
    process.env.TWILIO_PHONE_NUMBER,
    process.env.TWILIO_WHATSAPP_NUMBER,
  );
  const channels = getPublicEnabledChannels(contact, process.env.TWILIO_ENABLED_CHANNELS);
  if (!contact.phoneNumber ||
      !hasPublicOrigin() ||
      !isVoiceVerificationConfigured() ||
      !ACCOUNT_SID.test(process.env.TWILIO_ACCOUNT_SID || "") ||
      !process.env.TWILIO_AUTH_TOKEN || !process.env.AUTH_SECRET) return null;
  const activeSettings = settings ?? await getExperienceSettings();
  const smsHref = channels.includes("sms") ? contact.smsHref : null;
  const callHref = channels.includes("voice") && activeSettings.voicePhotoMode !== "none"
    ? contact.callHref
    : null;
  return activeSettings.cameraEnabled && (smsHref || callHref)
    ? { phoneNumber: contact.phoneNumber, smsHref, callHref }
    : null;
}

export function photoJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}

/** Parse small JSON requests without buffering an unbounded request body. */
export async function readSmallPhotoJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return null;
  const length = Number(request.headers.get("content-length") || 0);
  if (!Number.isSafeInteger(length) || length > 2048 || !request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 2048) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}
