import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { AgentCollected } from "@/lib/comic-agent";
import { CONVERSATION_RESUME_DAYS } from "@/lib/conversation-policy";
import { db } from "@/lib/db";
import type { ExperienceSettings, VoicePhotoMode } from "@/lib/photo-experience-settings";
import { conversations, twilioInboundMessages } from "@/lib/schema";
import {
  photoHandoffSourceChannels,
  selectVoicePhotoHandoff,
  VOICE_PHOTO_HANDOFF_WINDOW_MS,
  voiceSmsMediaCutoff,
  type PhotoHandoffConversation,
  type VoicePhotoDraft,
  type VoicePhotoHandoffCandidate,
} from "@/lib/voice-photo-handoff";

type VoiceCallDraft = VoicePhotoDraft & { updatedAt: Date };
export type VoiceCallPhotoSource = VoicePhotoHandoffCandidate<PhotoHandoffConversation>;
export type VoiceCallPhotoReadiness =
  | { kind: "photos"; count: number }
  | { kind: "continuation"; phase: "finished" | "draft" }
  | { kind: "generating" }
  | { kind: "missing" };

function photoCount(collected: AgentCollected): number {
  const references = Array.isArray(collected.characterImageUrls)
    ? collected.characterImageUrls
    : [];
  return new Set(references.filter((value): value is string =>
    typeof value === "string" && Boolean(value.trim()))).size;
}

/** Apply the same handoff rules used when Relay loads the verified call. */
export function assessVoiceCallPhotoReadiness({
  mode,
  voice,
  candidates,
  now = new Date(),
}: {
  mode: VoicePhotoMode;
  voice: VoiceCallDraft | null;
  candidates: VoiceCallPhotoSource[];
  now?: Date;
}): VoiceCallPhotoReadiness {
  if (mode === "none") return { kind: "missing" };

  const resumeCutoff = now.getTime() - CONVERSATION_RESUME_DAYS * 24 * 60 * 60_000;
  const current = voice && (voice.state === "generating" || voice.updatedAt.getTime() >= resumeCutoff)
    ? voice
    : null;
  const draft: VoicePhotoDraft = current
    ? { state: current.state, collected: current.collected, activeStoryId: current.activeStoryId }
    : { state: "collecting", collected: {}, activeStoryId: null };

  if (draft.state === "generating") return { kind: "generating" };

  const selected = selectVoicePhotoHandoff({ mode, voice: draft, candidates, now });
  if (selected) {
    const count = photoCount(selected.handoff.collected);
    if (count > 0) return { kind: "photos", count };
  }

  if (draft.state === "done" && draft.activeStoryId) {
    return { kind: "continuation", phase: "finished" };
  }
  if (draft.collected.targetStoryId &&
      draft.collected.targetStoryId === draft.activeStoryId) {
    return { kind: "continuation", phase: "draft" };
  }
  if (draft.state !== "done") {
    const count = photoCount(draft.collected);
    if (count > 0) return { kind: "photos", count };
  }
  return { kind: "missing" };
}

/** Read-only check before sending a Verify SMS and again before Relay opens. */
export async function getVoiceCallPhotoReadiness(
  phone: string,
  settings: ExperienceSettings,
  now = new Date(),
): Promise<VoiceCallPhotoReadiness> {
  if (!/^\+[1-9]\d{6,14}$/.test(phone) || settings.voicePhotoMode === "none") {
    return { kind: "missing" };
  }

  const [voiceRow] = await db.select({
    state: conversations.state,
    collected: conversations.collected,
    activeStoryId: conversations.activeStoryId,
    updatedAt: conversations.updatedAt,
  }).from(conversations)
    .where(and(eq(conversations.channel, "voice"), eq(conversations.phoneNumber, phone)))
    .limit(1);
  const voice = voiceRow ?? null;
  const sourceChannels = photoHandoffSourceChannels(
    settings.voicePhotoMode,
    settings.cameraEnabled,
  );
  const windowStart = new Date(now.getTime() - VOICE_PHOTO_HANDOFF_WINDOW_MS);
  const candidates: VoiceCallPhotoSource[] = [];
  for (const sourceChannel of sourceChannels) {
    const [source] = await db.select({
      state: conversations.state,
      collected: conversations.collected,
      updatedAt: conversations.updatedAt,
    }).from(conversations)
      .where(and(
        eq(conversations.channel, sourceChannel),
        eq(conversations.phoneNumber, phone),
        gte(conversations.updatedAt, windowStart),
      ))
      .limit(1);
    if (!source) continue;

    const recentSmsMediaUrls = sourceChannel === "sms"
      ? (await db.select({ mediaUrls: twilioInboundMessages.mediaUrls })
        .from(twilioInboundMessages)
        .where(and(
          eq(twilioInboundMessages.channel, "sms"),
          eq(twilioInboundMessages.fromAddress, phone),
          gte(twilioInboundMessages.createdAt, voiceSmsMediaCutoff(
            { collected: voice?.collected ?? {} },
            windowStart,
          )),
          sql`jsonb_array_length(${twilioInboundMessages.mediaUrls}) > 0`,
        ))
        .orderBy(desc(twilioInboundMessages.createdAt))
        .limit(20))
        .flatMap((message) => message.mediaUrls)
      : [];
    candidates.push({ sourceChannel, source, recentSmsMediaUrls });
  }

  return assessVoiceCallPhotoReadiness({
    mode: settings.voicePhotoMode,
    voice,
    candidates,
    now,
  });
}
