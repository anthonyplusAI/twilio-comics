import { createHash } from "node:crypto";
import type { AgentCollected } from "@/lib/comic-agent";
import type { VoicePhotoMode } from "@/lib/schema";
import { isTwilioMediaUrl } from "@/lib/twilio";

/** Photos are offered to a call only shortly after the sender provided them. */
export const VOICE_PHOTO_HANDOFF_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface PhotoHandoffConversation {
  state: string;
  collected: AgentCollected;
  updatedAt: Date;
}

export interface VoicePhotoDraft {
  state: string;
  collected: AgentCollected;
  activeStoryId: string | null;
}

const CAMERA_REFERENCE = /^blob:uploads\/twilio_[a-f0-9]{32}\/camera\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.jpg$/;

export type PhotoHandoffSourceChannel = "sms" | "camera";

export interface VoicePhotoHandoffCandidate<TSource extends PhotoHandoffConversation> {
  sourceChannel: PhotoHandoffSourceChannel;
  source: TSource;
  recentSmsMediaUrls?: string[];
}

/** Select the first fresh source in the admin's preferred order. */
export function selectVoicePhotoHandoff<TSource extends PhotoHandoffConversation>(input: {
  mode: VoicePhotoMode;
  voice: VoicePhotoDraft;
  candidates: VoicePhotoHandoffCandidate<TSource>[];
  now?: Date;
}): (VoicePhotoHandoffCandidate<TSource> & { handoff: VoicePhotoDraft }) | null {
  let newestUnchangedSourceAt = -Infinity;
  for (const candidate of input.candidates) {
    const handoff = planVoicePhotoHandoff({
      mode: input.mode,
      sourceChannel: candidate.sourceChannel,
      voice: input.voice,
      source: candidate.source,
      recentSmsMediaUrls: candidate.recentSmsMediaUrls,
      now: input.now,
    });
    if (handoff === "unchanged") {
      newestUnchangedSourceAt = Math.max(
        newestUnchangedSourceAt,
        candidate.source.updatedAt.getTime(),
      );
      continue;
    }
    if (handoff && candidate.source.updatedAt.getTime() > newestUnchangedSourceAt) {
      return { ...candidate, handoff };
    }
  }
  return null;
}

function photoFingerprint(sourceChannel: PhotoHandoffSourceChannel, references: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ sourceChannel, references }))
    .digest("hex");
}

/** An accepted Voice job consumes only the SMS photo stage it actually used. */
export function planConsumedSmsPhotoStage(
  source: PhotoHandoffConversation,
  submittedReferences: readonly string[],
): AgentCollected | null {
  const staged = source.collected.characterImageUrls;
  if (!isPhotoOnlySmsStage(source) || source.collected.targetStoryId ||
      !Array.isArray(staged) || staged.length < 1 || staged.length > 2 ||
      submittedReferences.length !== staged.length ||
      !staged.every((reference, index) =>
        isTwilioMediaUrl(reference) && reference === submittedReferences[index]) ||
      source.collected.photoHandoffFingerprint !== photoFingerprint("sms", staged)) {
    return null;
  }
  return { ...source.collected, characterImageUrls: [], photoHandoffFingerprint: undefined };
}

/** The selected source wins when both text and kiosk photos are staged. */
export function photoHandoffSourceChannels(
  mode: VoicePhotoMode,
  cameraEnabled: boolean,
): PhotoHandoffSourceChannel[] {
  if (mode === "none") return [];
  if (!cameraEnabled) return ["sms"];
  return mode === "camera" ? ["camera", "sms"] : ["sms", "camera"];
}

/** A generic Voice setting also removes photos copied before it was selected. */
export function withoutVoicePhotoReferences(voice: VoicePhotoDraft): VoicePhotoDraft | null {
  if (voice.state === "generating" || !voice.collected.characterImageUrls?.length) return null;
  return {
    ...voice,
    collected: { ...voice.collected, characterImageUrls: [], photoHandoffFingerprint: undefined },
  };
}

/** An SMS photo-only draft can still be finished by text after a call begins. */
export function isPhotoOnlySmsStage(source: PhotoHandoffConversation): boolean {
  return source.state === "collecting" &&
    !source.collected.prompt?.trim() &&
    (!Array.isArray(source.collected.messages) || source.collected.messages.length === 0);
}

/**
 * Plan a same-number photo transfer into a verified Voice call. The source
 * conversation must contain a current, unfinished photo draft. Recent SMS
 * media receipts further ensure an unrelated text cannot refresh old photos.
 */
export function planVoicePhotoHandoff({
  mode,
  sourceChannel,
  voice,
  source,
  recentSmsMediaUrls = [],
  now = new Date(),
}: {
  mode: VoicePhotoMode;
  sourceChannel: PhotoHandoffSourceChannel;
  voice: VoicePhotoDraft;
  source: PhotoHandoffConversation | null;
  recentSmsMediaUrls?: string[];
  now?: Date;
}): VoicePhotoDraft | "unchanged" | null {
  if (mode === "none" || voice.state === "generating" || !source ||
      !["collecting", "confirming"].includes(source.state)) return null;

  const ageMs = now.getTime() - source.updatedAt.getTime();
  if (!Number.isFinite(ageMs) || ageMs > VOICE_PHOTO_HANDOFF_WINDOW_MS || ageMs < -5 * 60_000) {
    return null;
  }

  const recentSmsUrls = new Set(recentSmsMediaUrls);
  const stagedReferences = Array.isArray(source.collected?.characterImageUrls)
    ? source.collected.characterImageUrls
    : [];
  const references = [...new Set(stagedReferences)]
    .filter((reference): reference is string => typeof reference === "string" &&
      (sourceChannel === "sms"
        ? isTwilioMediaUrl(reference) && recentSmsUrls.has(reference)
        : CAMERA_REFERENCE.test(reference)))
    .slice(0, 2);
  if (references.length === 0) return null;

  const fingerprint = photoFingerprint(sourceChannel, references);
  if (voice.collected.photoHandoffFingerprint === fingerprint) return "unchanged";

  const resetAt = Date.parse(voice.collected.photoHandoffResetAt || "");
  if (Number.isFinite(resetAt) && source.updatedAt.getTime() <= resetAt) return null;

  // A finished Voice comic is preserved until the person stages new photos.
  // New photos signal a fresh comic, while an unfinished call keeps its idea.
  if (voice.state === "done") {
    return {
      state: "collecting",
      collected: { characterImageUrls: references, photoHandoffFingerprint: fingerprint },
      activeStoryId: null,
    };
  }
  return {
    state: voice.state,
    collected: {
      ...voice.collected,
      characterImageUrls: references,
      photoHandoffFingerprint: fingerprint,
    },
    activeStoryId: voice.activeStoryId,
  };
}
