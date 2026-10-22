import { createHash } from "node:crypto";
import { eq, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  activityEvents,
  channelIdentities,
  generationJobs,
  stories,
  twilioInboundMessages,
  users,
  voiceCalls,
} from "@/lib/schema";

const E164 = /^\+[1-9]\d{6,14}$/;
const TERMINAL_JOB_STATUSES = new Set(["succeeded", "failed", "quota_rejected"]);
const ACTIVE_FALLBACK_STATUSES = new Set(["sending", "retry_pending"]);

export interface DeletionSubject {
  sender: string;
  userId: string;
  addresses: [string, string];
}

/** The channel user ID uses the same stable derivation as channel-identities.ts. */
export function deletionSubjectForSender(sender: string): DeletionSubject {
  if (!E164.test(sender)) {
    throw new Error("Sender must be an exact E.164 number, such as +15551234567");
  }
  const digest = createHash("sha256").update(sender).digest("hex");
  return {
    sender,
    userId: `twilio_${digest.slice(0, 32)}`,
    addresses: [sender, `whatsapp:${sender}`],
  };
}

export interface SubjectDatabaseCounts {
  users: number;
  channelIdentities: number;
  conversations: number;
  inboundMessages: number;
  voiceCalls: number;
  generationJobs: number;
  stories: number;
  pages: number;
  activityEvents: number;
  feedback: number;
  quotaRows: number;
  quotaClaims: number;
  accounts: number;
  sessions: number;
  verificationTokens: number;
  activeInboundMessages: number;
  activeVoiceCalls: number;
  activeConversations: number;
  mixedOwnershipEvents: number;
  mixedOwnershipCalls: number;
}

export interface SubjectDatabaseSnapshot {
  user: { id: string; kind: string; email: string | null } | null;
  identities: Array<{ userId: string; normalizedAddress: string; channel: string; provider: string }>;
  jobs: Array<{
    id: string;
    userId: string;
    recipientAddress: string;
    status: string;
    storyId: string | null;
    targetStoryId: string | null;
    deliveryFallbackStatus: string | null;
    deliverySid: string | null;
    deliveryFallbackSid: string | null;
  }>;
  stories: Array<{ id: string; userId: string }>;
  messages: Array<{ messageSid: string; outboundSid: string | null }>;
  calls: Array<{ callSid: string }>;
  eventSids: Array<{ messageSid: string | null; callSid: string | null }>;
  counts: SubjectDatabaseCounts;
}

export interface DeletionPlan extends DeletionSubject {
  readOnly: true;
  counts: SubjectDatabaseCounts;
  storyIds: string[];
  jobIds: string[];
  providerMessageSids: string[];
  providerCallSids: string[];
  blobPrefixes: string[];
  blockers: string[];
  readyForManualDeletion: boolean;
}

/** Build an exact storage scope; mixed or active records become visible blockers. */
export function buildDeletionPlan(sender: string, snapshot: SubjectDatabaseSnapshot): DeletionPlan {
  const subject = deletionSubjectForSender(sender);
  const blockers: string[] = [];
  const addressSet = new Set<string>(subject.addresses);
  const ownedStories = snapshot.stories.filter((story) => story.userId === subject.userId);
  const ownedStoryIds = new Set(ownedStories.map((story) => story.id));
  const ownedJobs = snapshot.jobs.filter((job) =>
    job.userId === subject.userId && addressSet.has(job.recipientAddress));

  if (snapshot.user && (snapshot.user.id !== subject.userId || snapshot.user.kind !== "channel" || snapshot.user.email)) {
    blockers.push("Channel user has a different owner, account kind, or email; review linked identity before deleting it.");
  }
  if (snapshot.user && !snapshot.identities.some((identity) =>
    identity.userId === subject.userId &&
    identity.normalizedAddress === sender &&
    identity.provider === "twilio")) {
    blockers.push("Channel user has no matching identity for this sender; review its ownership manually.");
  }
  for (const identity of snapshot.identities) {
    if (identity.userId !== subject.userId || identity.normalizedAddress !== sender || identity.provider !== "twilio") {
      blockers.push(`Identity ${identity.channel} is linked to another owner or address; review manually.`);
    }
  }
  for (const job of snapshot.jobs) {
    if (job.userId !== subject.userId || !addressSet.has(job.recipientAddress)) {
      blockers.push(`Generation job ${job.id} has mixed ownership or a different recipient.`);
      continue;
    }
    if (!TERMINAL_JOB_STATUSES.has(job.status) ||
      (job.deliveryFallbackStatus && ACTIVE_FALLBACK_STATUSES.has(job.deliveryFallbackStatus))) {
      blockers.push(`Generation job ${job.id} is active (${job.status}/${job.deliveryFallbackStatus || "no fallback"}).`);
    }
    if ((job.storyId && !ownedStoryIds.has(job.storyId)) ||
      (job.targetStoryId && !ownedStoryIds.has(job.targetStoryId))) {
      blockers.push(`Generation job ${job.id} references a story outside this sender's owned stories.`);
    }
  }
  if (snapshot.stories.some((story) => story.userId !== subject.userId)) {
    blockers.push("A listed story belongs to another user; review ownership manually.");
  }
  if (snapshot.counts.accounts || snapshot.counts.sessions) {
    blockers.push("The channel user has linked account or session records; review before deleting the user.");
  }
  if (snapshot.counts.activeInboundMessages) {
    blockers.push(`${snapshot.counts.activeInboundMessages} inbound message receipt(s) are unfinished.`);
  }
  if (snapshot.counts.activeVoiceCalls) {
    blockers.push(`${snapshot.counts.activeVoiceCalls} voice call(s) have no end record.`);
  }
  if (snapshot.counts.activeConversations) {
    blockers.push(`${snapshot.counts.activeConversations} conversation(s) are generating or leased.`);
  }
  if (snapshot.counts.mixedOwnershipEvents || snapshot.counts.mixedOwnershipCalls) {
    blockers.push("Address history is attributed to a different user; review the affected event and call records.");
  }
  if (snapshot.counts.users !== Number(Boolean(snapshot.user)) ||
    snapshot.counts.channelIdentities !== snapshot.identities.length ||
    snapshot.counts.generationJobs !== snapshot.jobs.length ||
    snapshot.counts.stories !== snapshot.stories.length ||
    snapshot.counts.inboundMessages !== snapshot.messages.length ||
    snapshot.counts.voiceCalls !== snapshot.calls.length) {
    blockers.push("The database changed while the inventory was read; rerun after intake and workers are paused.");
  }

  const blobPrefixes = new Set<string>([`uploads/${subject.userId}/`]);
  for (const story of ownedStories) {
    blobPrefixes.add(`${story.id}/`);
    blobPrefixes.add(`stories/${story.id}/`);
  }
  for (const job of ownedJobs) {
    blobPrefixes.add(`stories/${job.id}/`);
    blobPrefixes.add(`references/twilio/${job.id}/`);
  }

  const providerMessageSids = new Set<string>();
  const providerCallSids = new Set<string>();
  for (const message of snapshot.messages) {
    providerMessageSids.add(message.messageSid);
    if (message.outboundSid) providerMessageSids.add(message.outboundSid);
  }
  for (const job of ownedJobs) {
    if (job.deliverySid) providerMessageSids.add(job.deliverySid);
    if (job.deliveryFallbackSid) providerMessageSids.add(job.deliveryFallbackSid);
  }
  for (const call of snapshot.calls) providerCallSids.add(call.callSid);
  for (const event of snapshot.eventSids) {
    if (event.messageSid) providerMessageSids.add(event.messageSid);
    if (event.callSid) providerCallSids.add(event.callSid);
  }

  return {
    ...subject,
    readOnly: true,
    counts: snapshot.counts,
    storyIds: [...ownedStoryIds].sort(),
    jobIds: ownedJobs.map((job) => job.id).sort(),
    providerMessageSids: [...providerMessageSids].sort(),
    providerCallSids: [...providerCallSids].sort(),
    blobPrefixes: [...blobPrefixes].sort(),
    blockers: [...new Set(blockers)],
    readyForManualDeletion: blockers.length === 0,
  };
}

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows?: T[] }).rows ?? (result as T[]);
}

function numeric(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Invalid count returned by the database");
  }
  return parsed;
}

interface RawCounts {
  users: unknown;
  channel_identities: unknown;
  conversations: unknown;
  inbound_messages: unknown;
  voice_calls: unknown;
  generation_jobs: unknown;
  stories: unknown;
  pages: unknown;
  activity_events: unknown;
  feedback: unknown;
  quota_rows: unknown;
  quota_claims: unknown;
  accounts: unknown;
  sessions: unknown;
  verification_tokens: unknown;
  active_inbound_messages: unknown;
  active_voice_calls: unknown;
  active_conversations: unknown;
  mixed_ownership_events: unknown;
  mixed_ownership_calls: unknown;
}

function parseCounts(row: RawCounts | undefined): SubjectDatabaseCounts {
  if (!row) throw new Error("The database returned no deletion counts");
  return {
    users: numeric(row.users),
    channelIdentities: numeric(row.channel_identities),
    conversations: numeric(row.conversations),
    inboundMessages: numeric(row.inbound_messages),
    voiceCalls: numeric(row.voice_calls),
    generationJobs: numeric(row.generation_jobs),
    stories: numeric(row.stories),
    pages: numeric(row.pages),
    activityEvents: numeric(row.activity_events),
    feedback: numeric(row.feedback),
    quotaRows: numeric(row.quota_rows),
    quotaClaims: numeric(row.quota_claims),
    accounts: numeric(row.accounts),
    sessions: numeric(row.sessions),
    verificationTokens: numeric(row.verification_tokens),
    activeInboundMessages: numeric(row.active_inbound_messages),
    activeVoiceCalls: numeric(row.active_voice_calls),
    activeConversations: numeric(row.active_conversations),
    mixedOwnershipEvents: numeric(row.mixed_ownership_events),
    mixedOwnershipCalls: numeric(row.mixed_ownership_calls),
  };
}

/** Read-only database inventory. A maintenance window is required for a stable final review. */
export async function loadSubjectDatabaseSnapshot(sender: string): Promise<SubjectDatabaseSnapshot> {
  const { userId, addresses } = deletionSubjectForSender(sender);
  const whatsappAddress = addresses[1];
  const [userRows, identityRows, jobRows, storyRows, messageRows, callRows, eventSidRows, countResult] = await Promise.all([
    db.select({ id: users.id, kind: users.kind, email: users.email })
      .from(users).where(eq(users.id, userId)).limit(1),
    db.select({
      userId: channelIdentities.userId,
      normalizedAddress: channelIdentities.normalizedAddress,
      channel: channelIdentities.channel,
      provider: channelIdentities.provider,
    }).from(channelIdentities).where(or(
      eq(channelIdentities.normalizedAddress, sender),
      eq(channelIdentities.userId, userId),
    )),
    db.select({
      id: generationJobs.id,
      userId: generationJobs.userId,
      recipientAddress: generationJobs.recipientAddress,
      status: generationJobs.status,
      storyId: generationJobs.storyId,
      targetStoryId: generationJobs.targetStoryId,
      deliveryFallbackStatus: generationJobs.deliveryFallbackStatus,
      deliverySid: generationJobs.deliverySid,
      deliveryFallbackSid: generationJobs.deliveryFallbackSid,
    }).from(generationJobs).where(or(
      eq(generationJobs.userId, userId),
      eq(generationJobs.recipientAddress, sender),
      eq(generationJobs.recipientAddress, whatsappAddress),
    )),
    db.select({ id: stories.id, userId: stories.userId })
      .from(stories).where(eq(stories.userId, userId)),
    db.select({
      messageSid: twilioInboundMessages.messageSid,
      outboundSid: twilioInboundMessages.outboundSid,
    }).from(twilioInboundMessages).where(or(
      eq(twilioInboundMessages.fromAddress, sender),
      eq(twilioInboundMessages.fromAddress, whatsappAddress),
    )),
    db.select({ callSid: voiceCalls.callSid })
      .from(voiceCalls).where(or(
        eq(voiceCalls.fromAddress, sender),
        eq(voiceCalls.userId, userId),
      )),
    db.select({
      messageSid: activityEvents.messageSid,
      callSid: activityEvents.callSid,
    }).from(activityEvents).where(or(
      eq(activityEvents.userId, userId),
      eq(activityEvents.address, sender),
      eq(activityEvents.address, whatsappAddress),
    )),
    db.execute(sql`
      WITH subject_jobs AS (
        SELECT id, quota_claim_key, delivery_sid, delivery_fallback_sid
        FROM generation_jobs
        WHERE user_id = ${userId}
          OR recipient_address IN (${sender}, ${whatsappAddress})
      ), subject_stories AS (
        SELECT id FROM stories WHERE user_id = ${userId}
      ), subject_messages AS (
        SELECT message_sid, outbound_sid FROM twilio_inbound_messages
        WHERE from_address IN (${sender}, ${whatsappAddress})
      ), subject_calls AS (
        SELECT call_sid, ended_at FROM voice_calls
        WHERE user_id = ${userId} OR from_address = ${sender}
      )
      SELECT
        (SELECT COUNT(*) FROM users WHERE id = ${userId}) AS users,
        (SELECT COUNT(*) FROM channel_identities
          WHERE normalized_address = ${sender} OR user_id = ${userId}) AS channel_identities,
        (SELECT COUNT(*) FROM conversations
          WHERE phone_number IN (${sender}, ${whatsappAddress})) AS conversations,
        (SELECT COUNT(*) FROM subject_messages) AS inbound_messages,
        (SELECT COUNT(*) FROM subject_calls) AS voice_calls,
        (SELECT COUNT(*) FROM subject_jobs) AS generation_jobs,
        (SELECT COUNT(*) FROM subject_stories) AS stories,
        (SELECT COUNT(*) FROM pages WHERE story_id IN (SELECT id FROM subject_stories)) AS pages,
        (SELECT COUNT(*) FROM activity_events AS e
          WHERE e.user_id = ${userId}
            OR e.address IN (${sender}, ${whatsappAddress})
            OR e.job_id IN (SELECT id FROM subject_jobs)
            OR e.story_id IN (SELECT id FROM subject_stories)
            OR e.call_sid IN (SELECT call_sid FROM subject_calls)
            OR e.message_sid IN (
              SELECT message_sid FROM subject_messages
              UNION SELECT outbound_sid FROM subject_messages WHERE outbound_sid IS NOT NULL
              UNION SELECT delivery_sid FROM subject_jobs WHERE delivery_sid IS NOT NULL
              UNION SELECT delivery_fallback_sid FROM subject_jobs WHERE delivery_fallback_sid IS NOT NULL
            )) AS activity_events,
        (SELECT COUNT(*) FROM feedback WHERE user_id = ${userId}) AS feedback,
        (SELECT COUNT(*) FROM free_tier_quotas
          WHERE subject IN (${userId}, ${sender}, ${whatsappAddress})) AS quota_rows,
        (SELECT COUNT(*) FROM free_tier_quota_claims
          WHERE subject IN (${userId}, ${sender}, ${whatsappAddress})
            OR claim_key IN (SELECT quota_claim_key FROM subject_jobs)) AS quota_claims,
        (SELECT COUNT(*) FROM accounts WHERE user_id = ${userId}) AS accounts,
        (SELECT COUNT(*) FROM sessions WHERE user_id = ${userId}) AS sessions,
        (SELECT COUNT(*) FROM verification_tokens
          WHERE identifier IN (${sender}, ${whatsappAddress})
            OR identifier = (SELECT email FROM users WHERE id = ${userId})) AS verification_tokens,
        (SELECT COUNT(*) FROM subject_messages AS m JOIN twilio_inbound_messages AS full_message
          ON full_message.message_sid = m.message_sid
          WHERE full_message.status <> 'completed') AS active_inbound_messages,
        (SELECT COUNT(*) FROM subject_calls WHERE ended_at IS NULL) AS active_voice_calls,
        (SELECT COUNT(*) FROM conversations
          WHERE phone_number IN (${sender}, ${whatsappAddress})
            AND (state = 'generating' OR lease_expires_at > NOW())) AS active_conversations,
        (SELECT COUNT(*) FROM activity_events
          WHERE address IN (${sender}, ${whatsappAddress})
            AND user_id IS NOT NULL AND user_id <> ${userId}) AS mixed_ownership_events,
        (SELECT COUNT(*) FROM voice_calls
          WHERE from_address = ${sender}
            AND user_id IS NOT NULL AND user_id <> ${userId}) AS mixed_ownership_calls
    `),
  ]);

  return {
    user: userRows[0] || null,
    identities: identityRows,
    jobs: jobRows,
    stories: storyRows,
    messages: messageRows,
    calls: callRows,
    eventSids: eventSidRows,
    counts: parseCounts(rowsOf<RawCounts>(countResult)[0]),
  };
}
