import { describe, expect, it } from "vitest";
import { advanceComicAgent } from "@/lib/comic-agent";
import {
  isPhotoOnlySmsStage,
  photoHandoffSourceChannels,
  planConsumedSmsPhotoStage,
  planVoicePhotoHandoff,
  selectVoicePhotoHandoff,
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

  it.each(["NEW", "RESET", "RESTART", "DISCARD"])(
    "does not hand the same staged photos back to Voice after %s",
    async (command) => {
      const originalSource = source(
        { characterImageUrls: [PHOTO_1] },
        { updatedAt: new Date(Date.now() - 60_000) },
      );
      const imported = applied(planVoicePhotoHandoff({
        mode: "sms", sourceChannel: "sms", voice: voice(), source: originalSource,
        recentSmsMediaUrls: [PHOTO_1], now: new Date(),
      }));
      const reset = await advanceComicAgent(imported, { text: command, channel: "voice" });
      const resetAt = Date.parse(reset.collected.photoHandoffResetAt || "");
      const nextCall = voice({
        state: reset.nextState,
        collected: reset.collected,
        activeStoryId: reset.activeStoryId,
      });

      expect(Number.isFinite(resetAt)).toBe(true);
      expect(reset.collected.characterImageUrls).toBeUndefined();
      expect(planVoicePhotoHandoff({
        mode: "sms", sourceChannel: "sms", voice: nextCall, source: originalSource,
        recentSmsMediaUrls: [PHOTO_1], now: new Date(resetAt + 2_000),
      })).toBe("unchanged");

      const newlyStaged = applied(planVoicePhotoHandoff({
        mode: "sms", sourceChannel: "sms", voice: nextCall,
        source: source(
          { characterImageUrls: [PHOTO_2] },
          { updatedAt: new Date(resetAt + 1_000) },
        ),
        recentSmsMediaUrls: [PHOTO_2], now: new Date(resetAt + 2_000),
      }));
      expect(newlyStaged.collected.characterImageUrls).toEqual([PHOTO_2]);
    },
  );

  it("does not reimport old photos after a completed Voice comic starts a new idea", async () => {
    const originalSource = source({ characterImageUrls: [PHOTO_1] });
    const imported = applied(planVoicePhotoHandoff({
      mode: "sms", sourceChannel: "sms", voice: voice(), source: originalSource,
      recentSmsMediaUrls: [PHOTO_1], now: NOW,
    }));
    const nextIdea = await advanceComicAgent(
      {
        state: "done",
        activeStoryId: "completed-story",
        collected: { ...imported.collected, prompt: "The first comic" },
      },
      { text: "A completely new space adventure", channel: "voice" },
      async () => ({
        reply: "A space adventure. Sound right?",
        prompt: "A completely new space adventure",
        style: "noir",
        readyForConfirmation: true,
      }),
    );

    expect(nextIdea.collected.characterImageUrls).toBeUndefined();
    expect(planVoicePhotoHandoff({
      mode: "sms", sourceChannel: "sms",
      voice: voice({
        state: nextIdea.nextState,
        collected: nextIdea.collected,
        activeStoryId: nextIdea.activeStoryId,
      }),
      source: originalSource,
      recentSmsMediaUrls: [PHOTO_1], now: NOW,
    })).toBe("unchanged");
  });

  it("uses a newly staged camera photo when the earlier SMS handoff is unchanged", async () => {
    const originalSms = source(
      { characterImageUrls: [PHOTO_1] },
      { updatedAt: new Date(Date.now() - 60_000) },
    );
    const imported = applied(planVoicePhotoHandoff({
      mode: "sms", sourceChannel: "sms", voice: voice(), source: originalSms,
      recentSmsMediaUrls: [PHOTO_1], now: new Date(),
    }));
    const reset = await advanceComicAgent(imported, { text: "NEW", channel: "voice" });
    const resetAt = Date.parse(reset.collected.photoHandoffResetAt || "");
    const selected = selectVoicePhotoHandoff({
      mode: "sms",
      voice: voice({ state: reset.nextState, collected: reset.collected, activeStoryId: reset.activeStoryId }),
      candidates: [
        { sourceChannel: "sms", source: originalSms, recentSmsMediaUrls: [PHOTO_1] },
        {
          sourceChannel: "camera",
          source: source({ characterImageUrls: [CAMERA_PHOTO] }, { updatedAt: new Date(resetAt + 1_000) }),
        },
      ],
      now: new Date(resetAt + 2_000),
    });

    expect(Number.isFinite(resetAt)).toBe(true);
    expect(selected?.sourceChannel).toBe("camera");
    expect(selected?.handoff.collected.characterImageUrls).toEqual([CAMERA_PHOTO]);
  });

  it("rejects old kiosk photos after Voice reset even when the SMS stage was consumed", async () => {
    const initial = applied(planVoicePhotoHandoff({
      mode: "sms", sourceChannel: "sms", voice: voice(),
      source: source({ characterImageUrls: [PHOTO_1] }, { updatedAt: new Date(Date.now() - 60_000) }),
      recentSmsMediaUrls: [PHOTO_1], now: new Date(),
    }));
    const reset = await advanceComicAgent(initial, { text: "NEW", channel: "voice" });
    const resetAt = Date.parse(reset.collected.photoHandoffResetAt || "");
    const afterReset = voice({ state: reset.nextState, collected: reset.collected, activeStoryId: reset.activeStoryId });
    const oldCamera = source(
      { characterImageUrls: [CAMERA_PHOTO] },
      { updatedAt: new Date(resetAt - 90_000) },
    );

    expect(selectVoicePhotoHandoff({
      mode: "sms", voice: afterReset,
      candidates: [{ sourceChannel: "camera", source: oldCamera }],
      now: new Date(resetAt + 2_000),
    })).toBeNull();

    const newCamera = source(
      { characterImageUrls: [CAMERA_PHOTO] },
      { updatedAt: new Date(resetAt + 1_000) },
    );
    expect(selectVoicePhotoHandoff({
      mode: "sms", voice: afterReset,
      candidates: [{ sourceChannel: "camera", source: newCamera }],
      now: new Date(resetAt + 2_000),
    })?.handoff.collected.characterImageUrls).toEqual([CAMERA_PHOTO]);
  });

  it("does not take an older fallback when the preferred photo stage is unchanged", () => {
    const sms = source({ characterImageUrls: [PHOTO_1] }, { updatedAt: new Date(NOW.getTime() - 60_000) });
    const imported = applied(planVoicePhotoHandoff({
      mode: "sms", sourceChannel: "sms", voice: voice(), source: sms,
      recentSmsMediaUrls: [PHOTO_1], now: NOW,
    }));
    const olderCamera = source(
      { characterImageUrls: [CAMERA_PHOTO] },
      { updatedAt: new Date(NOW.getTime() - 90_000) },
    );
    expect(selectVoicePhotoHandoff({
      mode: "sms", voice: imported,
      candidates: [
        { sourceChannel: "sms", source: sms, recentSmsMediaUrls: [PHOTO_1] },
        { sourceChannel: "camera", source: olderCamera },
      ],
      now: NOW,
    })).toBeNull();
  });

  it("still gives a fresh SMS photo set priority over camera photos in text-first mode", () => {
    const selected = selectVoicePhotoHandoff({
      mode: "sms",
      voice: voice(),
      candidates: [
        { sourceChannel: "sms", source: source({ characterImageUrls: [PHOTO_2] }), recentSmsMediaUrls: [PHOTO_2] },
        { sourceChannel: "camera", source: source({ characterImageUrls: [CAMERA_PHOTO] }) },
      ],
      now: NOW,
    });

    expect(selected?.sourceChannel).toBe("sms");
    expect(selected?.handoff.collected.characterImageUrls).toEqual([PHOTO_2]);
  });

  it("consumes only the SMS photo-only stage that was submitted by Voice", async () => {
    const staged = source({ characterImageUrls: [PHOTO_1] });
    const handoff = applied(planVoicePhotoHandoff({
      mode: "sms", sourceChannel: "sms", voice: voice(), source: staged,
      recentSmsMediaUrls: [PHOTO_1], now: NOW,
    }));
    const markedStage = source({
      characterImageUrls: [PHOTO_1],
      photoHandoffFingerprint: handoff.collected.photoHandoffFingerprint,
    });

    const consumed = planConsumedSmsPhotoStage(markedStage, [PHOTO_1]);
    expect(consumed).toEqual({
      characterImageUrls: [],
      photoHandoffFingerprint: undefined,
    });
    if (!consumed) throw new Error("Expected matching SMS stage to be consumed");
    const nextSmsIdea = await advanceComicAgent(
      { state: "collecting", collected: consumed },
      { text: "A rocket visits the moon", channel: "sms" },
      async () => ({
        reply: "A rocket visits the moon. Ready?",
        prompt: "A rocket visits the moon",
        style: "noir",
        readyForConfirmation: true,
      }),
    );
    const nextSmsComic = await advanceComicAgent(
      {
        state: nextSmsIdea.nextState,
        collected: nextSmsIdea.collected,
        activeStoryId: nextSmsIdea.activeStoryId,
      },
      { text: "CREATE", channel: "sms" },
    );
    expect(nextSmsComic.submission?.characterImageUrls).toEqual([]);
    expect(planConsumedSmsPhotoStage(markedStage, [PHOTO_2])).toBeNull();
    expect(planConsumedSmsPhotoStage(staged, [PHOTO_1])).toBeNull();
    expect(planConsumedSmsPhotoStage(
      source({ ...markedStage.collected, characterImageUrls: [PHOTO_2] }),
      [PHOTO_1],
    )).toBeNull();
    expect(planConsumedSmsPhotoStage(
      source({ ...markedStage.collected, prompt: "A new SMS idea" }, { state: "confirming" }),
      [PHOTO_1],
    )).toBeNull();
    expect(planConsumedSmsPhotoStage(
      source({ ...markedStage.collected, targetStoryId: "existing-story" }),
      [PHOTO_1],
    )).toBeNull();
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
