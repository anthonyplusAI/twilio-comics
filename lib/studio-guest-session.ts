import { createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { auth } from "@/auth";
import { getBlobPublicUrl } from "@/lib/blob-storage";
import { getBrowserStudioEnabled } from "@/lib/browser-studio-settings";
import { db } from "@/lib/db";

export const STUDIO_GUEST_COOKIE = "twilio_comics_studio_guest";
export const STUDIO_BUDGET_COOKIE = "twilio_comics_studio_budget";
export const STUDIO_GUEST_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CLOCK_SKEW_MS = 30_000;

function signature(payload: string): Buffer {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret) throw new Error("AUTH_SECRET is required for Browser Studio guests");
  return createHmac("sha256", secret)
    .update(`twilio-comics:studio-guest:v1:${payload}`)
    .digest();
}

function budgetSignature(payload: string): Buffer {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret) throw new Error("AUTH_SECRET is required for Browser Studio budgets");
  return createHmac("sha256", secret)
    .update(`twilio-comics:studio-budget:v1:${payload}`)
    .digest();
}

export function createStudioBudgetToken(budgetId: string, now = Date.now()): string {
  if (!UUID_V4.test(budgetId) || !Number.isSafeInteger(now)) {
    throw new Error("Invalid Browser Studio budget identity");
  }
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    budgetId,
    issued: now,
    expires: now + STUDIO_GUEST_MAX_AGE_SECONDS * 1000,
  })).toString("base64url");
  return `${payload}.${budgetSignature(payload).toString("base64url")}`;
}

export function readStudioBudgetToken(value: string | undefined, now = Date.now()): string | null {
  if (!value || value.length > 512 || !Number.isSafeInteger(now)) return null;
  const parts = value.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) ||
      !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return null;
  let supplied: Buffer;
  let expected: Buffer;
  try {
    supplied = Buffer.from(parts[1], "base64url");
    expected = budgetSignature(parts[0]);
  } catch {
    return null;
  }
  if (supplied.length !== expected.length ||
      supplied.toString("base64url") !== parts[1] ||
      !timingSafeEqual(supplied, expected)) return null;

  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object") return null;
    const token = payload as Record<string, unknown>;
    if (token.version !== 1 || typeof token.budgetId !== "string" ||
        !UUID_V4.test(token.budgetId) || !Number.isSafeInteger(token.issued) ||
        !Number.isSafeInteger(token.expires)) return null;
    const issued = token.issued as number;
    const expires = token.expires as number;
    if (issued - now > MAX_CLOCK_SKEW_MS || expires <= now ||
        expires - issued !== STUDIO_GUEST_MAX_AGE_SECONDS * 1000) return null;
    return token.budgetId;
  } catch {
    return null;
  }
}

export function createStudioGuestToken(userId: string, now = Date.now()): string {
  if (!UUID_V4.test(userId) || !Number.isSafeInteger(now)) {
    throw new Error("Invalid Browser Studio guest identity");
  }
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    userId,
    issued: now,
    expires: now + STUDIO_GUEST_MAX_AGE_SECONDS * 1000,
  })).toString("base64url");
  return `${payload}.${signature(payload).toString("base64url")}`;
}

export function readStudioGuestToken(value: string | undefined, now = Date.now()): string | null {
  if (!value || value.length > 512 || !Number.isSafeInteger(now)) return null;
  const parts = value.split(".");
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
    const payload: unknown = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object") return null;
    const token = payload as Record<string, unknown>;
    if (token.version !== 1 || typeof token.userId !== "string" ||
        !UUID_V4.test(token.userId) || !Number.isSafeInteger(token.issued) ||
        !Number.isSafeInteger(token.expires)) return null;
    const issued = token.issued as number;
    const expires = token.expires as number;
    if (issued - now > MAX_CLOCK_SKEW_MS || expires <= now ||
        expires - issued !== STUDIO_GUEST_MAX_AGE_SECONDS * 1000) return null;
    return token.userId;
  } catch {
    return null;
  }
}

/** Guests may only submit photos uploaded under their own random identity. */
export function guestOwnsReferenceImages(userId: string, urls: readonly string[]): boolean {
  if (!UUID_V4.test(userId) || urls.length > 2) return false;
  return urls.every((value) => {
    if (typeof value !== "string" || value.length > 2048) return false;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    const key = url.searchParams.get("key");
    return Boolean(
      key &&
      new RegExp(`^uploads/${userId}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.jpg$`, "i").test(key) &&
      value === getBlobPublicUrl(key),
    );
  });
}

export type StudioActor = { userId: string; kind: "guest" | "google" };

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  const matches = header.split(";").map((segment) => segment.trim()).filter((segment) =>
    segment.startsWith(`${name}=`),
  );
  return matches.length === 1 ? matches[0].slice(name.length + 1) : null;
}

function derivedBudgetId(userId: string): string {
  if (!userId.trim() || userId.length > 200) throw new Error("Invalid Studio actor identity");
  if (UUID_V4.test(userId)) return userId;
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret) throw new Error("AUTH_SECRET is required for Browser Studio budgets");
  const bytes = createHmac("sha256", secret)
    .update(`twilio-comics:studio-budget:actor:${userId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A browser keeps the same rolling budget when it moves between Google and guest play. */
export function getStudioBudgetId(request: Request, actor: StudioActor): string {
  const saved = readStudioBudgetToken(cookieValue(request, STUDIO_BUDGET_COOKIE) ?? undefined);
  if (saved) return saved;
  if (actor.kind === "google") {
    const priorGuest = readStudioGuestToken(cookieValue(request, STUDIO_GUEST_COOKIE) ?? undefined);
    if (priorGuest) return priorGuest;
  }
  return derivedBudgetId(actor.userId);
}

/** This read does not check the public switch; the session route checks it first. */
export async function getStudioGuestActor(request: Request): Promise<StudioActor | null> {
  const userId = readStudioGuestToken(cookieValue(request, STUDIO_GUEST_COOKIE) ?? undefined);
  if (!userId) return null;
  const result = await db.execute(sql`
    SELECT id FROM users
    WHERE id = ${userId} AND kind = 'browser_guest'
    LIMIT 1
  `);
  const rows = result.rows;
  return rows?.[0]?.id === userId ? { userId, kind: "guest" } : null;
}

export async function getAuthorizedGoogleStudioActor(): Promise<StudioActor | null> {
  const session = await auth();
  const userId = session?.user?.id?.trim();
  return userId && session?.user?.studioAuthorized === true
    ? { userId, kind: "google" }
    : null;
}

/** Existing comics remain findable after the admin closes new Studio play. */
export async function getStudioReadActor(request: Request): Promise<StudioActor | null> {
  const google = await getAuthorizedGoogleStudioActor();
  if (google) return google;
  return getStudioGuestActor(request);
}

/** New uploads, generations, and edits require the public Studio switch. */
export async function getStudioActor(request: Request): Promise<StudioActor | null> {
  if (!await getBrowserStudioEnabled()) return null;
  return getStudioReadActor(request);
}

export function studioGuestCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: process.env.PUBLIC_BASE_URL?.startsWith("https://") ?? false,
    path: "/",
    maxAge: STUDIO_GUEST_MAX_AGE_SECONDS,
  };
}

export const studioBudgetCookieOptions = studioGuestCookieOptions;
