import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  row: null as { voicePhotoMode: "sms" | "camera" | "none"; cameraEnabled: boolean } | null,
  select: vi.fn(),
  insert: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { select: h.select, insert: h.insert } }));

import {
  getExperienceSettings,
  setExperienceSettings,
  setVoicePhotoMode,
  type ExperienceSettings,
} from "@/lib/photo-experience-settings";

beforeEach(() => {
  h.row = null;
  h.select.mockReset();
  h.insert.mockReset();
  h.select.mockReturnValue({
    from: () => ({ where: () => ({ limit: async () => h.row ? [h.row] : [] }) }),
  });
  h.insert.mockReturnValue({
    values: () => ({
      onConflictDoUpdate: async ({ set }: { set: ExperienceSettings }) => {
        h.row = { voicePhotoMode: set.voicePhotoMode, cameraEnabled: set.cameraEnabled };
      },
    }),
  });
});

describe("photo experience settings", () => {
  it("defaults to text-first calls with camera off, then reads saved choices", async () => {
    await expect(getExperienceSettings()).resolves.toEqual({
      voicePhotoMode: "sms",
      cameraEnabled: false,
    });

    await setVoicePhotoMode("none");
    await expect(getExperienceSettings()).resolves.toEqual({
      voicePhotoMode: "none",
      cameraEnabled: false,
    });

    await setExperienceSettings({ voicePhotoMode: "sms", cameraEnabled: false });
    await expect(getExperienceSettings()).resolves.toEqual({
      voicePhotoMode: "sms",
      cameraEnabled: false,
    });
  });

  it("rejects unsupported and retired camera settings before writing", async () => {
    await expect(setExperienceSettings({ voicePhotoMode: "other", cameraEnabled: false } as unknown as ExperienceSettings)).rejects.toThrow(
      "Invalid Voice photo mode",
    );
    await expect(setExperienceSettings({ voicePhotoMode: "camera", cameraEnabled: false })).rejects.toThrow(
      "retired",
    );
    await expect(setExperienceSettings({ voicePhotoMode: "sms", cameraEnabled: true })).rejects.toThrow(
      "retired",
    );
    await expect(setVoicePhotoMode("camera")).rejects.toThrow("retired");
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("clears an old camera flag when a caller setting is saved", async () => {
    h.row = { voicePhotoMode: "camera", cameraEnabled: true };
    await setVoicePhotoMode("sms");
    expect(h.row).toEqual({ voicePhotoMode: "sms", cameraEnabled: false });
  });
});
