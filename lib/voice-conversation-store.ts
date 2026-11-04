import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { conversations, twilioInboundMessages } from "@/lib/schema";
import type { AgentCollected } from "@/lib/comic-agent";
import { isTwilioMediaUrl } from "@/lib/twilio";
import type { VoiceConversationSnapshot, VoiceConversationUpdate } from "@/lib/voice-conversation";

const E164 = /^\+[1-9]\d{6,14}$/;

const nextRevision = sql`GREATEST(
  date_trunc('milliseconds', NOW()),
  date_trunc('milliseconds', ${conversations.updatedAt}) + INTERVAL '1 millisecond'
)`;

/** Persist a spoken NEW and reset the same phone's SMS draft in one transaction. */
export async function saveVoiceFreshStart(
  previous: VoiceConversationSnapshot,
  update: VoiceConversationUpdate,
): Promise<VoiceConversationSnapshot | null> {
  const reset = update.freshStart;
  if (!reset || !E164.test(reset.phoneNumber) || !Number.isFinite(Date.parse(reset.requestedAt))) {
    throw new Error("A spoken NEW needs a valid phone and reset time");
  }

  return db.transaction(async (tx) => {
    // An SMS NEW checkpoints SMS before Voice. Use the same lock order here
    // so simultaneous spoken and texted restarts cannot deadlock.
    const [sms] = await tx.select({
      id: conversations.id,
      state: conversations.state,
      collected: conversations.collected,
    }).from(conversations)
      .where(and(
        eq(conversations.channel, "sms"),
        eq(conversations.phoneNumber, reset.phoneNumber),
      ))
      .for("update")
      .limit(1);

    const [voice] = await tx.update(conversations)
      .set({
        state: update.state,
        collected: update.collected,
        activeStoryId: update.activeStoryId,
        updatedAt: nextRevision,
      })
      .where(and(
        eq(conversations.id, previous.id),
        eq(conversations.updatedAt, previous.updatedAt),
      ))
      .returning();
    if (!voice) return null;

    // A later texted NEW is already the replacement draft. Its photos must
    // win over this older spoken command even if Voice had to retry its CAS.
    const smsRestartedAt = Date.parse((sms?.collected as AgentCollected | undefined)?.phoneRestartedAt || "");
    const newerSmsRestart = sms?.state !== "generating" && Number.isFinite(smsRestartedAt) &&
      smsRestartedAt > Date.parse(reset.requestedAt);
    const stagedReferences = Array.isArray(sms?.collected.characterImageUrls)
      ? sms.collected.characterImageUrls
      : [];
    let newerSavedPhotos: string[] = [];
    if (sms && sms.state !== "generating" && !newerSmsRestart && stagedReferences.length) {
      // A photo texted after the spoken command may have reached the SMS
      // draft before this Voice save. Keep only those checkpointed MMS refs,
      // not the older idea or older photos already in that draft.
      const recentMedia = await tx.select({
        mediaUrls: twilioInboundMessages.mediaUrls,
        mediaContentTypes: twilioInboundMessages.mediaContentTypes,
      }).from(twilioInboundMessages)
        .where(and(
          eq(twilioInboundMessages.channel, "sms"),
          eq(twilioInboundMessages.fromAddress, reset.phoneNumber),
          gt(twilioInboundMessages.createdAt, new Date(reset.requestedAt)),
          inArray(twilioInboundMessages.status, ["reply_pending", "completed"]),
        ))
        .orderBy(desc(twilioInboundMessages.createdAt))
        .limit(20);
      const savedMediaUrls = new Set(recentMedia.flatMap((receipt) =>
        receipt.mediaUrls.filter((url, index) =>
          receipt.mediaContentTypes[index]?.toLowerCase().startsWith("image/") &&
          isTwilioMediaUrl(url))));
      newerSavedPhotos = stagedReferences.filter((reference) => savedMediaUrls.has(reference)).slice(0, 2);
    }
    const newerPhotosSql = newerSavedPhotos.length
      ? sql`, 'characterImageUrls', ${JSON.stringify(newerSavedPhotos)}::jsonb`
      : sql``;
    if (sms && !newerSmsRestart) {
      const [resetSms] = await tx.update(conversations)
        .set({
          state: sql`CASE WHEN ${conversations.state} = 'generating'
            THEN 'generating' ELSE 'collecting' END`,
          collected: sql`CASE WHEN ${conversations.state} = 'generating'
            THEN (${conversations.collected} - 'phoneRestartedByMessageSid') || jsonb_build_object(
              'newDraftRequestedAt', GREATEST(
                COALESCE(${conversations.collected}->>'newDraftRequestedAt', ''),
                ${reset.requestedAt}
              ),
              'phoneRestartedAt', GREATEST(
                COALESCE(${conversations.collected}->>'phoneRestartedAt', ''),
                ${reset.requestedAt}
              )
            )
            ELSE jsonb_build_object(
              'phoneRestartedAt', GREATEST(
                COALESCE(${conversations.collected}->>'phoneRestartedAt', ''),
                ${reset.requestedAt}
              )${newerPhotosSql}
            ) END`,
          activeStoryId: sql`CASE WHEN ${conversations.state} = 'generating'
            THEN ${conversations.activeStoryId} ELSE NULL END`,
          updatedAt: nextRevision,
        })
        .where(eq(conversations.id, sms.id))
        .returning({ id: conversations.id });
      if (!resetSms) throw new Error("SMS draft disappeared during spoken NEW");
    }

    return {
      id: voice.id,
      state: voice.state,
      collected: voice.collected,
      activeStoryId: voice.activeStoryId,
      updatedAt: voice.updatedAt,
    };
  });
}
