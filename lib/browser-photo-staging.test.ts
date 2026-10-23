import { describe, expect, it } from "vitest";
import { currentCameraReferences, newCameraBlobKey, planCameraStage } from "@/lib/browser-photo-staging";
import { VOICE_PHOTO_HANDOFF_WINDOW_MS } from "@/lib/voice-photo-handoff";

const OWNER = `twilio_${"a".repeat(32)}`;
const OTHER = `twilio_${"b".repeat(32)}`;
const FIRST = `uploads/${OWNER}/camera/00000000-0000-4000-8000-000000000001.jpg`;
const SECOND = `uploads/${OWNER}/camera/00000000-0000-4000-8000-000000000002.jpg`;
const REPLACEMENT = `uploads/${OWNER}/camera/00000000-0000-4000-8000-000000000003.jpg`;
const NOW = Date.parse("2026-10-22T12:00:00Z");
const FRESH = new Date(NOW - 1000);

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

  it("tolerates bounded clock skew across Container App replicas", () => {
    const collected = { characterImageUrls: [`blob:${FIRST}`] };
    expect(currentCameraReferences(collected, new Date(NOW + 29_999), OWNER, NOW))
      .toEqual([`blob:${FIRST}`]);
    expect(currentCameraReferences(collected, new Date(NOW + 30_001), OWNER, NOW))
      .toEqual([]);
  });
});
