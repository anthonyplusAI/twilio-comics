import { describe, expect, it, vi } from "vitest";
import {
  beginVerifiedCameraPhotoSession,
  clearStagedCameraPhotoReferences,
  currentCameraReferences,
  newCameraBlobKey,
  planCameraStage,
  stageCameraPhoto,
} from "@/lib/browser-photo-staging";
import { channelUserId } from "@/lib/channel-identities";
import { VOICE_PHOTO_HANDOFF_WINDOW_MS } from "@/lib/voice-photo-handoff";

const h = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { transaction: h.transaction } }));

const PHONE = "+14155552671";
const OWNER = channelUserId(PHONE);
const OTHER = `twilio_${"b".repeat(32)}`;
const FIRST = `uploads/${OWNER}/camera/00000000-0000-4000-8000-000000000001.jpg`;
const SECOND = `uploads/${OWNER}/camera/00000000-0000-4000-8000-000000000002.jpg`;
const REPLACEMENT = `uploads/${OWNER}/camera/00000000-0000-4000-8000-000000000003.jpg`;
const NOW = Date.parse("2026-10-22T12:00:00Z");
const FRESH = new Date(NOW - 1000);
const FIRST_SESSION = "00000000-0000-4000-8000-000000000011";
const SECOND_SESSION = "00000000-0000-4000-8000-000000000012";

function cameraStageDb(
  initialReferences: string[],
  session?: { nonce: string; issued: number },
) {
  const row = {
    id: "camera-conversation",
    collected: {
      characterImageUrls: [...initialReferences],
      ...(session ? {
        cameraSessionNonce: session.nonce,
        cameraSessionIssuedAt: session.issued,
      } : {}),
    } as {
      characterImageUrls?: string[];
      cameraSessionNonce?: string;
      cameraSessionIssuedAt?: number;
      cameraReferenceSavedAt?: Record<string, number>;
    },
    updatedAt: new Date(session?.issued ?? NOW - 1000),
  };
  const tx = {
    insert: vi.fn(() => ({
      values: () => ({ onConflictDoNothing: async () => undefined }),
    })),
    select: vi.fn(() => ({
      from: () => ({ where: () => ({ for: () => ({
        limit: async () => [{ ...row, collected: structuredClone(row.collected) }],
      }) }) }),
    })),
    update: vi.fn(() => ({
      set: (values: Partial<typeof row>) => ({
        where: async () => { Object.assign(row, values); },
      }),
    })),
  };
  h.transaction.mockImplementation(async (work: (value: typeof tx) => Promise<unknown>) => work(tx));
  return { row, tx };
}

describe("verified browser photo staging", () => {
  it("keeps at most two owner-scoped photos and permits deliberate replacement", () => {
    const first = planCameraStage({}, FRESH, OWNER, FIRST, 0, NOW);
    expect(first).toEqual({ references: [`blob:${FIRST}`], replaced: false });
    const second = planCameraStage({ characterImageUrls: first?.references }, FRESH,
      OWNER, SECOND, 1, NOW);
    expect(second).toEqual({ references: [`blob:${FIRST}`, `blob:${SECOND}`], replaced: false });
    expect(planCameraStage({ characterImageUrls: second?.references }, FRESH,
      OWNER, REPLACEMENT, 0, NOW)).toEqual({
      references: [`blob:${REPLACEMENT}`, `blob:${SECOND}`], replaced: true,
    });
    expect(planCameraStage({ characterImageUrls: second?.references }, FRESH,
      OWNER, REPLACEMENT, 2, NOW)).toBeNull();
  });

  it("rejects cross-owner and malformed Blob keys before writing a conversation", () => {
    expect(planCameraStage({}, FRESH, OWNER, FIRST.replace(OWNER, OTHER), 0, NOW)).toBeNull();
    expect(planCameraStage({}, FRESH, OWNER,
      `uploads/${OWNER}/camera/../private.jpg`, 0, NOW)).toBeNull();
    expect(planCameraStage({}, FRESH, OWNER, "https://evil.example/photo.jpg", 0, NOW)).toBeNull();
    expect(() => newCameraBlobKey("foreign-user")).toThrow(/owner/);
    expect(newCameraBlobKey(OWNER)).toMatch(new RegExp(`^uploads/${OWNER}/camera/[0-9a-f-]+\\.jpg$`));
  });

  it("hides photos after the same 24-hour window used by Voice handoff", () => {
    const collected = { characterImageUrls: [`blob:${FIRST}`, `blob:${SECOND}`] };
    expect(currentCameraReferences(collected,
      new Date(NOW - VOICE_PHOTO_HANDOFF_WINDOW_MS), OWNER, NOW)).toHaveLength(2);
    expect(currentCameraReferences(collected,
      new Date(NOW - VOICE_PHOTO_HANDOFF_WINDOW_MS - 1), OWNER, NOW)).toEqual([]);
    expect(planCameraStage(collected,
      new Date(NOW - VOICE_PHOTO_HANDOFF_WINDOW_MS - 1), OWNER, REPLACEMENT, 0, NOW))
      .toEqual({ references: [`blob:${REPLACEMENT}`], replaced: false });
  });

  it("expires each photo by its original upload time when a later change refreshes the row", () => {
    const oldPhoto = `blob:${FIRST}`;
    const recentPhoto = `blob:${SECOND}`;
    const collected = {
      characterImageUrls: [oldPhoto, recentPhoto],
      cameraReferenceSavedAt: {
        [oldPhoto]: NOW - VOICE_PHOTO_HANDOFF_WINDOW_MS - 1,
        [recentPhoto]: NOW - 1_000,
      },
    };
    expect(currentCameraReferences(collected, FRESH, OWNER, NOW)).toEqual([recentPhoto]);
  });

  it("tolerates bounded clock skew across Container App replicas", () => {
    const collected = { characterImageUrls: [`blob:${FIRST}`] };
    expect(currentCameraReferences(collected, new Date(NOW + 29_999), OWNER, NOW))
      .toEqual([`blob:${FIRST}`]);
    expect(currentCameraReferences(collected, new Date(NOW + 30_001), OWNER, NOW))
      .toEqual([]);
  });

  it("clears the exact handed-off camera set under a row lock", async () => {
    const { row, tx } = cameraStageDb([`blob:${FIRST}`, `blob:${SECOND}`]);

    expect(await clearStagedCameraPhotoReferences(PHONE, [`blob:${FIRST}`, `blob:${SECOND}`]))
      .toBe(true);
    expect(row.collected).toEqual({});
    expect(tx.select).toHaveBeenCalledOnce();
    expect(tx.update).toHaveBeenCalledOnce();
  });

  it("preserves a newly restaged photo when an old submitted turn retries cleanup", async () => {
    const { row, tx } = cameraStageDb([`blob:${REPLACEMENT}`]);

    expect(await clearStagedCameraPhotoReferences(PHONE, [`blob:${FIRST}`])).toBe(false);
    expect(row.collected).toEqual({ characterImageUrls: [`blob:${REPLACEMENT}`] });
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("removes consumed photos while retaining a newly added second photo", async () => {
    const { row } = cameraStageDb([`blob:${FIRST}`, `blob:${REPLACEMENT}`]);

    expect(await clearStagedCameraPhotoReferences(PHONE, [`blob:${FIRST}`])).toBe(true);
    expect(row.collected).toMatchObject({ characterImageUrls: [`blob:${REPLACEMENT}`] });
    expect(row.collected.cameraReferenceSavedAt?.[`blob:${REPLACEMENT}`]).toBe(NOW - 1000);
  });

  it("clears any staged set for an explicit reset and rejects malformed input", async () => {
    const { row, tx } = cameraStageDb([`blob:${FIRST}`]);

    expect(await clearStagedCameraPhotoReferences(PHONE, [])).toBe(false);
    expect(await clearStagedCameraPhotoReferences(PHONE, [`blob:${FIRST.replace(OWNER, OTHER)}`]))
      .toBe(false);
    expect(await clearStagedCameraPhotoReferences("invalid phone")).toBe(false);
    expect(tx.update).not.toHaveBeenCalled();
    expect(await clearStagedCameraPhotoReferences(PHONE)).toBe(true);
    expect(row.collected).toEqual({});
  });

  it("starts an empty stage after a newly verified phone and keeps old photos until then", async () => {
    const { row } = cameraStageDb([`blob:${FIRST}`, `blob:${SECOND}`]);

    expect(row.collected.characterImageUrls).toEqual([`blob:${FIRST}`, `blob:${SECOND}`]);
    expect(await beginVerifiedCameraPhotoSession(PHONE, { phone: PHONE, nonce: FIRST_SESSION, issued: NOW }))
      .toBe(true);
    expect(row.collected).toEqual({
      cameraSessionNonce: FIRST_SESSION,
      cameraSessionIssuedAt: NOW,
    });

    expect(await stageCameraPhoto(PHONE, OWNER, REPLACEMENT, 0, FIRST_SESSION))
      .toEqual({ count: 1, replaced: false });
    expect(row.collected.characterImageUrls).toEqual([`blob:${REPLACEMENT}`]);
    expect(row.collected.cameraReferenceSavedAt?.[`blob:${REPLACEMENT}`]).toBeTypeOf("number");
  });

  it("does not let an older verification or upload erase a newer session's photos", async () => {
    const { row, tx } = cameraStageDb([`blob:${SECOND}`], {
      nonce: SECOND_SESSION,
      issued: NOW + 1000,
    });

    expect(await beginVerifiedCameraPhotoSession(PHONE, { phone: PHONE, nonce: FIRST_SESSION, issued: NOW }))
      .toBe(false);
    expect(await stageCameraPhoto(PHONE, OWNER, REPLACEMENT, 0, FIRST_SESSION))
      .toBeNull();
    expect(row.collected.characterImageUrls).toEqual([`blob:${SECOND}`]);
    expect(row.collected.cameraSessionNonce).toBe(SECOND_SESSION);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("keeps the active session marker when SMS consumes its staged photos", async () => {
    const { row } = cameraStageDb([`blob:${FIRST}`], {
      nonce: FIRST_SESSION,
      issued: NOW,
    });

    expect(await clearStagedCameraPhotoReferences(PHONE, [`blob:${FIRST}`])).toBe(true);
    expect(row.collected).toEqual({
      cameraSessionNonce: FIRST_SESSION,
      cameraSessionIssuedAt: NOW,
    });
    expect(await stageCameraPhoto(PHONE, OWNER, REPLACEMENT, 0, FIRST_SESSION))
      .toEqual({ count: 1, replaced: false });
  });
});
