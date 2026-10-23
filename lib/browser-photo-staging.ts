import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations } from "@/lib/schema";
import { VOICE_PHOTO_HANDOFF_WINDOW_MS } from "@/lib/voice-photo-handoff";

const VOICE_USER_ID = /^twilio_[0-9a-f]{32}$/;
const PHOTO_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$/;
const MAX_CAMERA_PHOTOS = 2;
const CAMERA_CLOCK_SKEW_MS = 30 * 1000;

function validCameraRef(reference: unknown, userId: string): reference is string {
  if (typeof reference !== "string" || !VOICE_USER_ID.test(userId)) return false;
  const prefix = `blob:uploads/${userId}/camera/`;
  return reference.startsWith(prefix) && PHOTO_NAME.test(reference.slice(prefix.length));
}

function references(value: unknown, userId: string): string[] {
  if (!value || typeof value !== "object" || !("characterImageUrls" in value)) return [];
  const refs = (value as { characterImageUrls?: unknown }).characterImageUrls;
  return Array.isArray(refs) ? refs.filter((ref) => validCameraRef(ref, userId)).slice(0, 2) : [];
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
  return isFresh(updatedAt, now) ? references(collected, userId) : [];
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

export async function getStagedCameraPhotoReferences(phone: string, userId: string): Promise<string[]> {
  if (!/^\+[1-9]\d{6,14}$/.test(phone) || !VOICE_USER_ID.test(userId)) return [];
  const [row] = await db.select({ collected: conversations.collected, updatedAt: conversations.updatedAt })
    .from(conversations)
    .where(and(eq(conversations.channel, "camera"), eq(conversations.phoneNumber, phone)))
    .limit(1);
  return row ? currentCameraReferences(row.collected, row.updatedAt, userId) : [];
}

export async function getStagedCameraPhotoCount(phone: string, userId: string): Promise<number> {
  return (await getStagedCameraPhotoReferences(phone, userId)).length;
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
): Promise<{ count: number; replaced: boolean } | null> {
  if (!/^\+[1-9]\d{6,14}$/.test(phone) || !VOICE_USER_ID.test(userId)) return null;

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
    const plan = planCameraStage(row.collected, row.updatedAt, userId, blobKey, slot);
    if (!plan) return null;
    await tx.update(conversations)
      .set({ collected: { characterImageUrls: plan.references }, updatedAt: new Date() })
      .where(eq(conversations.id, row.id));
    return { count: plan.references.length, replaced: plan.replaced };
  });
}
