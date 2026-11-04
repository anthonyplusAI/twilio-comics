import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { channelUserId } from "@/lib/channel-identities";
import type { PhotoTokenDetails } from "@/lib/browser-photo-session";
import { db } from "@/lib/db";
import { conversations } from "@/lib/schema";
import { VOICE_PHOTO_HANDOFF_WINDOW_MS } from "@/lib/voice-photo-handoff";

const VOICE_USER_ID = /^twilio_[0-9a-f]{32}$/;
const PHOTO_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$/;
const MAX_CAMERA_PHOTOS = 2;
const CAMERA_CLOCK_SKEW_MS = 30 * 1000;
const SESSION_NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validCameraRef(reference: unknown, userId: string): reference is string {
  if (typeof reference !== "string" || !VOICE_USER_ID.test(userId)) return false;
  const prefix = `blob:uploads/${userId}/camera/`;
  return reference.startsWith(prefix) && PHOTO_NAME.test(reference.slice(prefix.length));
}

function references(value: unknown, userId: string): string[] {
  if (!value || typeof value !== "object" || !("characterImageUrls" in value)) return [];
  const refs = (value as { characterImageUrls?: unknown }).characterImageUrls;
  return Array.isArray(refs) ? refs.filter((ref) => validCameraRef(ref, userId)) : [];
}

function isFresh(updatedAt: Date, now: number): boolean {
  const age = now - updatedAt.getTime();
  return Number.isFinite(age) &&
    age >= -CAMERA_CLOCK_SKEW_MS && age <= VOICE_PHOTO_HANDOFF_WINDOW_MS;
}

export function currentCameraReferences(
  collected: unknown,
  updatedAt: Date,
  userId: string,
  now = Date.now(),
): string[] {
  if (!isFresh(updatedAt, now)) return [];
  const savedAt = collected && typeof collected === "object" &&
    "cameraReferenceSavedAt" in collected
    ? (collected as { cameraReferenceSavedAt?: unknown }).cameraReferenceSavedAt
    : null;
  const savedTimes = savedAt && typeof savedAt === "object" && !Array.isArray(savedAt)
    ? savedAt as Record<string, unknown>
    : {};
  return references(collected, userId)
    .filter((reference) => {
      const savedTime = savedTimes[reference];
      const effectiveSavedAt = typeof savedTime === "number" && Number.isSafeInteger(savedTime)
        ? savedTime
        : updatedAt.getTime();
      return isFresh(new Date(effectiveSavedAt), now);
    })
    .slice(0, MAX_CAMERA_PHOTOS);
}

export function planCameraStage(
  collected: unknown,
  updatedAt: Date,
  userId: string,
  blobKey: string,
  slot: number,
  now = Date.now(),
): { references: string[]; replaced: boolean } | null {
  if (!VOICE_USER_ID.test(userId) || !Number.isInteger(slot) ||
      slot < 0 || slot >= MAX_CAMERA_PHOTOS ||
      !validCameraRef(`blob:${blobKey}`, userId)) return null;
  const current = currentCameraReferences(collected, updatedAt, userId, now);
  if (slot > current.length) return null;
  const next = [...current];
  next[slot] = `blob:${blobKey}`;
  return { references: next, replaced: slot < current.length };
}

export function newCameraBlobKey(userId: string): string {
  if (!VOICE_USER_ID.test(userId)) throw new Error("Invalid Voice photo owner");
  return `uploads/${userId}/camera/${randomUUID()}.jpg`;
}

export async function getStagedCameraPhotoReferences(
  phone: string,
  userId: string,
  beforeTime?: number,
): Promise<string[]> {
  if (!/^\+[1-9]\d{6,14}$/.test(phone) || !VOICE_USER_ID.test(userId) ||
      (beforeTime !== undefined && !Number.isSafeInteger(beforeTime))) return [];
  const [row] = await db.select({ collected: conversations.collected, updatedAt: conversations.updatedAt })
    .from(conversations)
    .where(and(eq(conversations.channel, "camera"), eq(conversations.phoneNumber, phone)))
    .limit(1);
  if (!row) return [];
  const current = currentCameraReferences(row.collected, row.updatedAt, userId);
  if (beforeTime === undefined) return current;
  return current.filter((reference) => {
    const savedAt = row.collected.cameraReferenceSavedAt?.[reference];
    // Legacy rows have no per-photo timestamp. Keep them if a later upload
    // refreshed the row, since deleting a fresh photo is worse than retaining one.
    const effectiveSavedAt = typeof savedAt === "number" && Number.isSafeInteger(savedAt)
      ? savedAt
      : row.updatedAt.getTime();
    return effectiveSavedAt < beforeTime;
  });
}

/** Only the browser session that owns the current stage may add to it. */
export async function getStagedCameraPhotoCount(
  phone: string,
  userId: string,
  sessionNonce: string,
): Promise<number | null> {
  if (!/^\+[1-9]\d{6,14}$/.test(phone) || !VOICE_USER_ID.test(userId) ||
      !SESSION_NONCE.test(sessionNonce)) return null;
  const [row] = await db.select({ collected: conversations.collected, updatedAt: conversations.updatedAt })
    .from(conversations)
    .where(and(eq(conversations.channel, "camera"), eq(conversations.phoneNumber, phone)))
    .limit(1);
  return row?.collected.cameraSessionNonce === sessionNonce
    ? currentCameraReferences(row.collected, row.updatedAt, userId).length
    : null;
}

/**
 * Start a fresh photo set only after the phone's code is approved. The row lock
 * makes an older delayed code check unable to erase a newer verified session.
 */
export async function beginVerifiedCameraPhotoSession(
  phone: string,
  challenge: PhotoTokenDetails,
): Promise<boolean> {
  if (!/^\+[1-9]\d{6,14}$/.test(phone) || challenge.phone !== phone ||
      !Number.isSafeInteger(challenge.issued) || !SESSION_NONCE.test(challenge.nonce)) return false;

  return db.transaction(async (tx) => {
    await tx.insert(conversations)
      .values({ channel: "camera", phoneNumber: phone, state: "collecting", collected: {} })
      .onConflictDoNothing({ target: [conversations.channel, conversations.phoneNumber] });

    const [row] = await tx.select({
      id: conversations.id,
      collected: conversations.collected,
      updatedAt: conversations.updatedAt,
    }).from(conversations)
      .where(and(eq(conversations.channel, "camera"), eq(conversations.phoneNumber, phone)))
      .for("update")
      .limit(1);
    if (!row) throw new Error("Camera stage was not created");

    const priorIssued = row.collected.cameraSessionIssuedAt;
    const priorNonce = row.collected.cameraSessionNonce;
    if (typeof priorIssued === "number" && Number.isSafeInteger(priorIssued)) {
      if (priorIssued > challenge.issued ||
          (priorIssued === challenge.issued && priorNonce !== challenge.nonce)) return false;
      if (priorIssued === challenge.issued && priorNonce === challenge.nonce) {
        return !row.collected.characterImageUrls?.length;
      }
    } else if (row.updatedAt.getTime() > challenge.issued &&
        row.collected.characterImageUrls?.length) {
      // A legacy camera upload may have finished after this code was requested.
      return false;
    }

    await tx.update(conversations)
      .set({
        state: "collecting",
        collected: {
          cameraSessionNonce: challenge.nonce,
          cameraSessionIssuedAt: challenge.issued,
        },
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, row.id));
    return true;
  });
}

/**
 * Keep exactly one or two owner-scoped Blob keys in the phone's camera staging
 * row. A row lock prevents two concurrent uploads from losing one another.
 */
export async function stageCameraPhoto(
  phone: string,
  userId: string,
  blobKey: string,
  slot: number,
  sessionNonce: string,
): Promise<{ count: number; replaced: boolean } | null> {
  if (!/^\+[1-9]\d{6,14}$/.test(phone) || !VOICE_USER_ID.test(userId) ||
      !SESSION_NONCE.test(sessionNonce)) return null;

  return db.transaction(async (tx) => {
    const [row] = await tx.select({
      id: conversations.id,
      collected: conversations.collected,
      updatedAt: conversations.updatedAt,
    }).from(conversations)
      .where(and(eq(conversations.channel, "camera"), eq(conversations.phoneNumber, phone)))
      .for("update")
      .limit(1);
    if (!row || row.collected.cameraSessionNonce !== sessionNonce) return null;
    const plan = planCameraStage(row.collected, row.updatedAt, userId, blobKey, slot);
    if (!plan) return null;
    const now = Date.now();
    const newReference = `blob:${blobKey}`;
    const savedAt = Object.fromEntries(plan.references.map((reference) => {
      const priorSavedAt = row.collected.cameraReferenceSavedAt?.[reference];
      return [reference, reference === newReference
        ? now
        : typeof priorSavedAt === "number" && Number.isSafeInteger(priorSavedAt)
          ? priorSavedAt
          : row.updatedAt.getTime()];
    }));
    await tx.update(conversations)
      .set({
        collected: {
          ...row.collected,
          characterImageUrls: plan.references,
          cameraReferenceSavedAt: savedAt,
        },
        updatedAt: new Date(now),
      })
      .where(eq(conversations.id, row.id));
    return { count: plan.references.length, replaced: plan.replaced };
  });
}

/**
 * Remove kiosk photos after a submitted comic or an explicit fresh start.
 * A conditional clear removes only the refs seen by the comic or reset turn,
 * so a later upload survives a delayed Voice submission or SMS retry.
 */
export async function clearStagedCameraPhotoReferences(
  phone: string,
  expectedReferences?: readonly string[],
): Promise<boolean> {
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) return false;
  const userId = channelUserId(phone);
  if (expectedReferences !== undefined &&
      (!Array.isArray(expectedReferences) || expectedReferences.length < 1 ||
        expectedReferences.length > MAX_CAMERA_PHOTOS ||
        !expectedReferences.every((ref) => validCameraRef(ref, userId)))) {
    return false;
  }

  return db.transaction(async (tx) => {
    const [row] = await tx.select({
      id: conversations.id,
      collected: conversations.collected,
      updatedAt: conversations.updatedAt,
    }).from(conversations)
      .where(and(eq(conversations.channel, "camera"), eq(conversations.phoneNumber, phone)))
      .for("update")
      .limit(1);
    if (!row) return false;
    const stored = row.collected.characterImageUrls;
    if (!Array.isArray(stored) || stored.length === 0) return false;
    const remaining = expectedReferences === undefined
      ? []
      : stored.filter((ref) => !expectedReferences.includes(ref));
    if (remaining.length === stored.length) return false;
    const nextCollected = { ...row.collected };
    delete nextCollected.characterImageUrls;
    delete nextCollected.cameraReferenceSavedAt;
    if (remaining.length) {
      nextCollected.characterImageUrls = remaining;
      nextCollected.cameraReferenceSavedAt = Object.fromEntries(remaining.map((reference) => {
        const priorSavedAt = row.collected.cameraReferenceSavedAt?.[reference];
        return [reference, typeof priorSavedAt === "number" && Number.isSafeInteger(priorSavedAt)
          ? priorSavedAt
          : row.updatedAt.getTime()];
      }));
    }
    await tx.update(conversations)
      .set({
        collected: nextCollected,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, row.id));
    return true;
  });
}
