import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getBrowserStudioEnabled } from "@/lib/browser-studio-settings";
import { getMarketingContact } from "@/lib/marketing-contact";
import { getPublicEnabledChannels } from "@/lib/public-channel-readiness";
import { getPublicOrigin } from "@/lib/public-origin";
import { isVoiceVerificationConfigured } from "@/lib/voice-verification";

export const STUDIO_TEXT_CHALLENGE_COOKIE = "twilio_comics_studio_text_challenge";

const CHALLENGE_SECONDS = 10 * 60;
const MAX_CLOCK_SKEW_MS = 30_000;
const E164 = /^\+[1-9]\d{6,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type StudioTextChallenge = {
  userId: string;
  storyId: string;
  phone: string;
  nonce: string;
  issued: number;
};

export async function getStudioComicTextOrigin(): Promise<string | null> {
  const origin = getPublicOrigin();
  if (!origin || !process.env.AUTH_SECRET?.trim() || !isVoiceVerificationConfigured()) {
    return null;
  }

  const contact = getMarketingContact(
    process.env.TWILIO_PHONE_NUMBER,
    process.env.TWILIO_WHATSAPP_NUMBER,
  );
  if (!getPublicEnabledChannels(contact, process.env.TWILIO_ENABLED_CHANNELS).includes("sms")) {
    return null;
  }

  return await getBrowserStudioEnabled() ? origin : null;
}

function signature(payload: string): Buffer {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret) throw new Error("AUTH_SECRET is required for Studio comic text verification");
  return createHmac("sha256", secret)
    .update(`twilio-comics:studio-text:v1:${payload}`)
    .digest();
}

export function createStudioTextChallenge(
  details: Pick<StudioTextChallenge, "userId" | "storyId" | "phone">,
  now = Date.now(),
  nonce = randomUUID(),
): string {
  if (!details.userId || details.userId.length > 200 || !UUID.test(details.storyId) ||
      !E164.test(details.phone) || !UUID.test(nonce)) {
    throw new Error("Invalid Studio comic text challenge");
  }
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    ...details,
    nonce,
    issued: now,
    expires: now + CHALLENGE_SECONDS * 1000,
  })).toString("base64url");
  return `${payload}.${signature(payload).toString("base64url")}`;
}

export function readStudioTextChallenge(
  token: string | undefined,
  now = Date.now(),
): StudioTextChallenge | null {
  if (!token || token.length > 1000) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) ||
      !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return null;

  let supplied: Buffer;
  let expected: Buffer;
  try {
    supplied = Buffer.from(parts[1], "base64url");
    expected = signature(parts[0]);
  } catch {
    return null;
  }
  if (supplied.length !== expected.length ||
      supplied.toString("base64url") !== parts[1] ||
      !timingSafeEqual(supplied, expected)) return null;

  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const data = parsed as Record<string, unknown>;
    if (data.version !== 1 || typeof data.userId !== "string" || !data.userId ||
        data.userId.length > 200 || typeof data.storyId !== "string" ||
        !UUID.test(data.storyId) || typeof data.phone !== "string" ||
        !E164.test(data.phone) || typeof data.nonce !== "string" ||
        !UUID.test(data.nonce) || !Number.isSafeInteger(data.issued) ||
        !Number.isSafeInteger(data.expires)) return null;
    const issued = data.issued as number;
    const expires = data.expires as number;
    if (issued - now > MAX_CLOCK_SKEW_MS || expires <= now ||
        expires - issued !== CHALLENGE_SECONDS * 1000) return null;
    return {
      userId: data.userId,
      storyId: data.storyId,
      phone: data.phone,
      nonce: data.nonce,
      issued,
    };
  } catch {
    return null;
  }
}

export function studioTextCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: getPublicOrigin()?.startsWith("https://") ?? false,
    path: "/api/studio/text-comic",
    maxAge: CHALLENGE_SECONDS,
  };
}

export function studioTextJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}

export async function readSmallStudioTextJson(request: Request): Promise<Record<string, unknown> | null> {
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
