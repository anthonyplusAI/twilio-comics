import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const CAMERA_CHALLENGE_COOKIE = "twilio_comics_camera_challenge";
export const CAMERA_SESSION_COOKIE = "twilio_comics_camera_session";

const CHALLENGE_SECONDS = 10 * 60;
const SESSION_SECONDS = 15 * 60;
const MAX_CLOCK_SKEW_MS = 30_000;
const E164 = /^\+[1-9]\d{6,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PhotoTokenPurpose = "challenge" | "session";
export type PhotoTokenDetails = { phone: string; issued: number; nonce: string };

function lifetimeSeconds(purpose: PhotoTokenPurpose): number {
  return purpose === "challenge" ? CHALLENGE_SECONDS : SESSION_SECONDS;
}

function signingSecret(): string {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret) throw new Error("AUTH_SECRET is required for browser photo verification");
  return secret;
}

function signature(payload: string, purpose: PhotoTokenPurpose): Buffer {
  return createHmac("sha256", signingSecret())
    .update(`twilio-comics:camera:${purpose}:${payload}`)
    .digest();
}

export function normalizePhotoPhone(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 32) return null;
  const value = input.trim();
  if (!/^[+()\d\s.-]+$/.test(value)) return null;
  const digits = value.replace(/\D/g, "");
  const phone = value.startsWith("+")
    ? `+${digits}`
    : digits.length === 10
      ? `+1${digits}`
      : digits.length === 11 && digits.startsWith("1")
        ? `+${digits}`
        : "";
  return E164.test(phone) ? phone : null;
}

export function createPhotoToken(
  phone: string,
  purpose: PhotoTokenPurpose,
  now = Date.now(),
  nonce: string = randomUUID(),
): string {
  if (!E164.test(phone)) throw new Error("Invalid verified phone number");
  if (!UUID.test(nonce)) throw new Error("Invalid photo session nonce");
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    phone,
    issued: now,
    expires: now + lifetimeSeconds(purpose) * 1000,
    nonce,
  })).toString("base64url");
  return `${payload}.${signature(payload, purpose).toString("base64url")}`;
}

export function readPhotoTokenDetails(
  value: string | undefined,
  purpose: PhotoTokenPurpose,
  now = Date.now(),
): PhotoTokenDetails | null {
  if (!value || value.length > 700) return null;
  const parts = value.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) ||
      !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return null;

  let supplied: Buffer;
  let expected: Buffer;
  try {
    supplied = Buffer.from(parts[1], "base64url");
    expected = signature(parts[0], purpose);
  } catch {
    return null;
  }
  if (supplied.length !== expected.length ||
      supplied.toString("base64url") !== parts[1] ||
      !timingSafeEqual(supplied, expected)) return null;

  try {
    const data: unknown = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (!data || typeof data !== "object") return null;
    const token = data as Record<string, unknown>;
    if (token.version !== 1 || typeof token.phone !== "string" ||
        !E164.test(token.phone) || !Number.isSafeInteger(token.issued) ||
        !Number.isSafeInteger(token.expires) || typeof token.nonce !== "string" ||
        !UUID.test(token.nonce)) {
      return null;
    }
    const issued = token.issued as number;
    const expires = token.expires as number;
    if (issued - now > MAX_CLOCK_SKEW_MS || expires <= now ||
        expires - issued !== lifetimeSeconds(purpose) * 1000) return null;
    return { phone: token.phone, issued, nonce: token.nonce };
  } catch {
    return null;
  }
}

export function readPhotoToken(
  value: string | undefined,
  purpose: PhotoTokenPurpose,
  now = Date.now(),
): string | null {
  return readPhotoTokenDetails(value, purpose, now)?.phone ?? null;
}

export function photoCookieOptions(purpose: PhotoTokenPurpose) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: process.env.PUBLIC_BASE_URL?.startsWith("https://") ?? false,
    path: "/",
    maxAge: lifetimeSeconds(purpose),
  };
}

export function photoRequestHasAllowedOrigin(request: Request): boolean {
  const configured = process.env.PUBLIC_BASE_URL?.trim();
  const origin = request.headers.get("origin");
  if (!configured || !origin) return false;
  try {
    const publicUrl = new URL(configured);
    const isLocalHttp = publicUrl.protocol === "http:" &&
      (publicUrl.hostname === "localhost" || publicUrl.hostname === "127.0.0.1");
    return (publicUrl.protocol === "https:" || isLocalHttp) && origin === publicUrl.origin;
  } catch {
    return false;
  }
}
