import { describe, expect, it } from "vitest";
import {
  isPhotoOnlySmsStage,
  photoHandoffSourceChannels,
  planVoicePhotoHandoff,
  VOICE_PHOTO_HANDOFF_WINDOW_MS,
  withoutVoicePhotoReferences,
  type PhotoHandoffConversation,
  type VoicePhotoDraft,
} from "@/lib/voice-photo-handoff";

const NOW = new Date("2026-10-22T12:00:00.000Z");
const PHOTO_1 = "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM123/Media/ME111";
const PHOTO_2 = "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM123/Media/ME222";
const CAMERA_PHOTO = `blob:uploads/twilio_${"a".repeat(32)}/camera/123e4567-e89b-42d3-a456-426614174000.jpg`;

function source(
  collected: PhotoHandoffConversation["collected"] = { characterImageUrls: [PHOTO_1] },
  overrides: Partial<PhotoHandoffConversation> = {},
): PhotoHandoffConversation {
  return {
    state: "collecting",
    collected,
    updatedAt: new Date(NOW.getTime() - 60_000),
    ...overrides,
  };
}

function voice(overrides: Partial<VoicePhotoDraft> = {}): VoicePhotoDraft {
  return { state: "collecting", collected: {}, activeStoryId: null, ...overrides };
}

function applied(plan: ReturnType<typeof planVoicePhotoHandoff>): VoicePhotoDraft {
  if (!plan || plan === "unchanged") throw new Error("Expected a new Voice photo draft");
  return plan;
}

describe("Voice photo handoff", () => {
  it("selects the configured photo source", () => {
    expect(photoHandoffSourceChannels("sms", false)).toEqual(["sms"]);
    expect(photoHandoffSourceChannels("sms", true)).toEqual(["sms", "camera"]);
    expect(photoHandoffSourceChannels("camera", true)).toEqual(["camera", "sms"]);
    expect(photoHandoffSourceChannels("camera", false)).toEqual(["sms"]);
    expect(photoHandoffSourceChannels("none", true)).toEqual([]);
  });

  it("copies at most two recent MMS photos into an unfinished Voice draft", () => {
    const existing = voice({
      state: "confirming",
      collected: { prompt: "A moon adventure", style: "manga" },
    });
    const staged = source({ characterImageUrls: [PHOTO_1, PHOTO_2, PHOTO_2] });
    const planned = applied(planVoicePhotoHandoff({
      mode: "sms",
      sourceChannel: "sms",
      voice: existing,
      source: staged,
      recentSmsMediaUrls: [PHOTO_1, PHOTO_2],
      now: NOW,
    }));

    expect(planned?.state).toBe("confirming");
    expect(planned?.collected).toMatchObject({
      prompt: "A moon adventure",
      style: "manga",
      characterImageUrls: [PHOTO_1, PHOTO_2],
    });
    expect(planned?.collected.photoHandoffFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(planVoicePhotoHandoff({
      mode: "sms",
      sourceChannel: "sms",
      voice: planned,
      source: staged,
      recentSmsMediaUrls: [PHOTO_1, PHOTO_2],
      now: NOW,
    })).toBe("unchanged");
  });

  it("begins a fresh Voice draft only when new photos follow a finished comic", () => {
    const previous = voice({
      state: "done",
      activeStoryId: "story-1",
      collected: { prompt: "Old story", characterImageUrls: [PHOTO_2] },
    });
    const planned = applied(planVoicePhotoHandoff({
      mode: "sms",
      sourceChannel: "sms",
      voice: previous,
      source: source(),
      recentSmsMediaUrls: [PHOTO_1],
      now: NOW,
    }));

    expect(planned).toMatchObject({
      state: "collecting",
      activeStoryId: null,
      collected: { characterImageUrls: [PHOTO_1] },
    });
    expect(planned?.collected.prompt).toBeUndefined();
  });

  it("does not import old media merely because a newer SMS refreshed the draft", () => {
    expect(planVoicePhotoHandoff({
      mode: "sms",
      sourceChannel: "sms",
      voice: voice(),
      source: source(),
      recentSmsMediaUrls: [],
      now: NOW,
    })).toBeNull();
  });

  it("rejects stale, finished, and generating source conversations", () => {
    for (const staged of [
      source(undefined, { updatedAt: new Date(NOW.getTime() - VOICE_PHOTO_HANDOFF_WINDOW_MS - 1) }),
      source(undefined, { state: "done" }),
      source(undefined, { state: "generating" }),
    ]) {
      expect(planVoicePhotoHandoff({
        mode: "sms", sourceChannel: "sms", voice: voice(), source: staged, recentSmsMediaUrls: [PHOTO_1], now: NOW,
      })).toBeNull();
    }
  });

  it("does not alter an in-flight job or any Voice draft in generic mode", () => {
    expect(planVoicePhotoHandoff({
      mode: "sms",
      sourceChannel: "sms",
      voice: voice({ state: "generating" }),
      source: source(),
      recentSmsMediaUrls: [PHOTO_1],
      now: NOW,
    })).toBeNull();
    expect(planVoicePhotoHandoff({
      mode: "none", sourceChannel: "sms", voice: voice(), source: source(), recentSmsMediaUrls: [PHOTO_1], now: NOW,
    })).toBeNull();
  });

  it("accepts only staged app-owned camera references in camera mode", () => {
    const planned = applied(planVoicePhotoHandoff({
      mode: "camera",
      sourceChannel: "camera",
      voice: voice(),
      source: source({ characterImageUrls: [CAMERA_PHOTO, "https://evil.example/photo.jpg"] }),
      now: NOW,
    }));
    expect(planned?.collected.characterImageUrls).toEqual([CAMERA_PHOTO]);
  });

  it("also accepts kiosk photos as the fallback for text-first Voice", () => {
    const planned = applied(planVoicePhotoHandoff({
      mode: "sms",
      sourceChannel: "camera",
      voice: voice(),
      source: source({ characterImageUrls: [CAMERA_PHOTO] }),
      now: NOW,
    }));
    expect(planned?.collected.characterImageUrls).toEqual([CAMERA_PHOTO]);
  });

  it("clears existing photos from generic calls without discarding the idea", () => {
    const existing = voice({
      state: "confirming",
      collected: { prompt: "A moon adventure", characterImageUrls: [PHOTO_1], photoHandoffFingerprint: "saved" },
    });
    expect(withoutVoicePhotoReferences(existing)).toMatchObject({
      state: "confirming",
      collected: { prompt: "A moon adventure", characterImageUrls: [], photoHandoffFingerprint: undefined },
    });
    expect(withoutVoicePhotoReferences(voice({ state: "generating", collected: { characterImageUrls: [PHOTO_1] } }))).toBeNull();
  });

  it("marks only a photo-only SMS stage for a fresh set on the next MMS", () => {
    expect(isPhotoOnlySmsStage(source())).toBe(true);
    expect(isPhotoOnlySmsStage(source({ prompt: "Use these photos" }))).toBe(false);
    expect(isPhotoOnlySmsStage(source({ messages: [{ role: "user", content: "idea" }] }))).toBe(false);
  });
});
