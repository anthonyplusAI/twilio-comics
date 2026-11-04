import { describe, expect, it } from "vitest";
import type { AgentCollected } from "@/lib/comic-agent";
import {
  assessVoiceCallPhotoReadiness,
  type VoiceCallPhotoSource,
} from "@/lib/voice-call-photo-readiness";

const NOW = new Date("2026-10-22T12:00:00.000Z");
const MMS = "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages/SM123/Media/ME111";
const CAMERA = `blob:uploads/twilio_${"a".repeat(32)}/camera/123e4567-e89b-42d3-a456-426614174000.jpg`;

function voice(
  state: string,
  collected: AgentCollected = {},
  updatedAt = new Date(NOW.getTime() - 60_000),
  activeStoryId: string | null = null,
) {
  return { state, collected, updatedAt, activeStoryId };
}

function smsSource(overrides: Partial<VoiceCallPhotoSource> = {}): VoiceCallPhotoSource {
  return {
    sourceChannel: "sms",
    source: voice("collecting", { characterImageUrls: [MMS] }),
    recentSmsMediaUrls: [MMS],
    ...overrides,
  };
}

function assess(input: Parameters<typeof assessVoiceCallPhotoReadiness>[0]) {
  return assessVoiceCallPhotoReadiness({ now: NOW, ...input });
}

describe("Voice call photo readiness", () => {
  it("asks for photos when no draft or fresh stage exists", () => {
    expect(assess({ mode: "sms", voice: null, candidates: [] })).toEqual({ kind: "missing" });
  });

  it("accepts one fresh MMS that is also in a recent Twilio receipt", () => {
    expect(assess({ mode: "sms", voice: null, candidates: [smsSource()] }))
      .toEqual({ kind: "photos", count: 1 });
  });

  it("ignores an SMS photo without a matching recent MMS receipt", () => {
    expect(assess({ mode: "sms", voice: null, candidates: [smsSource({ recentSmsMediaUrls: [] })] }))
      .toEqual({ kind: "missing" });
  });

  it("ignores an old photo stage and a photo stage from before NEW", () => {
    const old = smsSource({
      source: voice("collecting", { characterImageUrls: [MMS] }, new Date(NOW.getTime() - 25 * 60 * 60_000)),
    });
    const reset = voice("collecting", { photoHandoffResetAt: new Date(NOW.getTime() - 30_000).toISOString() });
    expect(assess({ mode: "sms", voice: null, candidates: [old] })).toEqual({ kind: "missing" });
    expect(assess({ mode: "sms", voice: reset, candidates: [smsSource()] }))
      .toEqual({ kind: "missing" });
  });

  it("keeps a saved unfinished Voice draft when its original MMS stage is gone", () => {
    expect(assess({ mode: "sms", voice: voice("confirming", { characterImageUrls: [MMS] }), candidates: [] }))
      .toEqual({ kind: "photos", count: 1 });
  });

  it("accepts a current browser photo when that photo path is enabled", () => {
    const camera: VoiceCallPhotoSource = {
      sourceChannel: "camera",
      source: voice("collecting", { characterImageUrls: [CAMERA] }),
    };
    expect(assess({ mode: "camera", voice: null, candidates: [camera] }))
      .toEqual({ kind: "photos", count: 1 });
  });

  it("offers continuation for a finished story without reusing its old photo as a new comic", () => {
    expect(assess({
      mode: "sms",
      voice: voice("done", { characterImageUrls: [MMS] }, undefined, "story-1"),
      candidates: [],
    })).toEqual({ kind: "continuation", phase: "finished" });
  });

  it("offers continuation for an unfinished next-page draft", () => {
    expect(assess({
      mode: "sms",
      voice: voice("confirming", { targetStoryId: "story-1" }, undefined, "story-1"),
      candidates: [],
    })).toEqual({ kind: "continuation", phase: "draft" });
  });

  it("offers status while a comic is generating, including after NEW was requested", () => {
    expect(assess({
      mode: "sms",
      voice: voice("generating", { newDraftRequestedAt: NOW.toISOString() }),
      candidates: [],
    })).toEqual({ kind: "generating" });
  });

  it("does not revive an inactive Voice draft after the resume window", () => {
    expect(assess({
      mode: "sms",
      voice: voice("collecting", { characterImageUrls: [MMS] }, new Date(NOW.getTime() - 15 * 24 * 60 * 60_000)),
      candidates: [],
    })).toEqual({ kind: "missing" });
  });

  it("blocks the call when Voice photo use is disabled", () => {
    expect(assess({ mode: "none", voice: voice("confirming", { characterImageUrls: [MMS] }), candidates: [] }))
      .toEqual({ kind: "missing" });
  });
});
