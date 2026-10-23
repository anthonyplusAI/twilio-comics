import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { select: h.select } }));

import { getStagedCameraPhotoReferences } from "@/lib/browser-photo-staging";
import { VOICE_PHOTO_HANDOFF_WINDOW_MS } from "@/lib/voice-photo-handoff";

const PHONE = "+14155552671";
const OWNER = `twilio_${"a".repeat(32)}`;
const OTHER = `twilio_${"b".repeat(32)}`;
const FIRST = `blob:uploads/${OWNER}/camera/00000000-0000-4000-8000-000000000001.jpg`;
const SECOND = `blob:uploads/${OWNER}/camera/00000000-0000-4000-8000-000000000002.jpg`;

function setCameraRow(collected: unknown, updatedAt: Date) {
  const limit = vi.fn().mockResolvedValue([{ collected, updatedAt }]);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  h.select.mockReturnValue({ from });
  return { limit };
}

beforeEach(() => h.select.mockReset());

describe("camera references for a verified phone", () => {
  it("returns only fresh references scoped to the phone owner", async () => {
    setCameraRow({ characterImageUrls: [FIRST, `blob:uploads/${OTHER}/camera/00000000-0000-4000-8000-000000000003.jpg`, SECOND] }, new Date());
    expect(await getStagedCameraPhotoReferences(PHONE, OWNER)).toEqual([FIRST, SECOND]);
  });

  it("does not hand off stale photos or query for malformed identities", async () => {
    setCameraRow({ characterImageUrls: [FIRST] },
      new Date(Date.now() - VOICE_PHOTO_HANDOFF_WINDOW_MS - 1000));
    expect(await getStagedCameraPhotoReferences(PHONE, OWNER)).toEqual([]);

    h.select.mockClear();
    expect(await getStagedCameraPhotoReferences("bad phone", OWNER)).toEqual([]);
    expect(await getStagedCameraPhotoReferences(PHONE, "foreign-user")).toEqual([]);
    expect(h.select).not.toHaveBeenCalled();
  });
});
