import { and, asc, eq, gte, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { recordActivityEvent } from "@/lib/activity-events";
import { CONVERSATION_RESUME_DAYS } from "@/lib/conversation-policy";
import { db } from "@/lib/db";
import { sendInboundMessage } from "@/lib/generation-queue";
import { conversations, twilioInboundMessages, type Conversation } from "@/lib/schema";
import type { AgentCollected, ComicAgentSubmission } from "@/lib/comic-agent";
import type { TwilioMessageChannel } from "@/lib/twilio";

export type InboundMessageStatus = "pending" | "processing" | "reply_pending" | "completed";

export interface StoredInboundMessage {
  messageSid: string;
  channel: TwilioMessageChannel;
  fromAddress: string;
  toAddress: string;
  body: string;
  mediaUrls: string[];
  mediaContentTypes: string[];
  status: InboundMessageStatus;
  replyBody: string | null;
  outboundSid: string | null;
  submission: ComicAgentSubmission | null;
  attemptCount: number;
  createdAt: Date;
}

export interface RecordInboundMessageInput {
  messageSid: string;
  channel: TwilioMessageChannel;
  fromAddress: string;
  toAddress: string;
  body: string;
  mediaUrls: string[];
  mediaContentTypes: string[];
}

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows?: T[] }).rows ?? (result as T[]);
}

function toStored(row: typeof twilioInboundMessages.$inferSelect): StoredInboundMessage {
  if (row.channel !== "sms" && row.channel !== "whatsapp") {
    throw new Error(`Unsupported inbound message channel: ${row.channel}`);
  }
  if (!["pending", "processing", "reply_pending", "completed"].includes(row.status)) {
    throw new Error(`Unsupported inbound message status: ${row.status}`);
  }
  return {
    messageSid: row.messageSid,
    channel: row.channel,
    fromAddress: row.fromAddress,
    toAddress: row.toAddress,
    body: row.body,
    mediaUrls: row.mediaUrls,
    mediaContentTypes: row.mediaContentTypes,
    status: row.status as InboundMessageStatus,
    replyBody: row.replyBody,
    outboundSid: row.outboundSid,
    submission: row.submission,
    attemptCount: row.attemptCount,
    createdAt: row.createdAt,
  };
}

/** A duplicate pending receipt is deliberately publishable again after a queue outage. */
export async function recordInboundMessage(
  input: RecordInboundMessageInput,
): Promise<{ shouldEnqueue: boolean }> {
  const [inserted] = await db
    .insert(twilioInboundMessages)
    .values({ ...input, status: "pending" })
    .onConflictDoNothing({ target: twilioInboundMessages.messageSid })
    .returning({ messageSid: twilioInboundMessages.messageSid });
  if (inserted) return { shouldEnqueue: true };

  const [existing] = await db
    .select({
      messageSid: twilioInboundMessages.messageSid,
      channel: twilioInboundMessages.channel,
      fromAddress: twilioInboundMessages.fromAddress,
      toAddress: twilioInboundMessages.toAddress,
      status: twilioInboundMessages.status,
    })
    .from(twilioInboundMessages)
    .where(eq(twilioInboundMessages.messageSid, input.messageSid))
    .limit(1);
  if (!existing) throw new Error("Inbound receipt disappeared after insert conflict");
  if (
    existing.channel !== input.channel ||
    existing.fromAddress !== input.fromAddress ||
    existing.toAddress !== input.toAddress
  ) {
    throw new Error("Inbound MessageSid conflicts with a different sender");
  }
  return { shouldEnqueue: existing.status !== "completed" };
}

export async function getInboundMessage(messageSid: string): Promise<StoredInboundMessage | null> {
  const [row] = await db
    .select()
    .from(twilioInboundMessages)
    .where(eq(twilioInboundMessages.messageSid, messageSid))
    .limit(1);
  return row ? toStored(row) : null;
}

export async function getOldestOpenInboundMessage(
  channel: TwilioMessageChannel,
  fromAddress: string,
): Promise<StoredInboundMessage | null> {
  const [row] = await db
    .select()
    .from(twilioInboundMessages)
    .where(and(
      eq(twilioInboundMessages.channel, channel),
      eq(twilioInboundMessages.fromAddress, fromAddress),
      ne(twilioInboundMessages.status, "completed"),
    ))
    .orderBy(asc(twilioInboundMessages.createdAt), asc(twilioInboundMessages.messageSid))
    .limit(1);
  return row ? toStored(row) : null;
}

/** The receipt is already durable before this is called under the sender lease. */
export async function getInboundMessagePosition(message: Pick<
  StoredInboundMessage,
  "messageSid" | "channel" | "fromAddress" | "createdAt"
>): Promise<{ dailyCount: number; firstMessage: boolean }> {
  const dayStart = new Date(Date.UTC(
    message.createdAt.getUTCFullYear(),
    message.createdAt.getUTCMonth(),
    message.createdAt.getUTCDate(),
  ));
  const nextDay = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const sender = and(
    eq(twilioInboundMessages.channel, message.channel),
    eq(twilioInboundMessages.fromAddress, message.fromAddress),
  );

  const [daily] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(twilioInboundMessages)
    .where(and(
      sender,
      gte(twilioInboundMessages.createdAt, dayStart),
      lt(twilioInboundMessages.createdAt, nextDay),
      or(
        lt(twilioInboundMessages.createdAt, message.createdAt),
        and(
          eq(twilioInboundMessages.createdAt, message.createdAt),
          lte(twilioInboundMessages.messageSid, message.messageSid),
        ),
      ),
    ));
  const [first] = await db
    .select({ messageSid: twilioInboundMessages.messageSid })
    .from(twilioInboundMessages)
    .where(sender)
    .orderBy(asc(twilioInboundMessages.createdAt), asc(twilioInboundMessages.messageSid))
    .limit(1);

  return { dailyCount: daily?.count ?? 0, firstMessage: first?.messageSid === message.messageSid };
}

export async function claimConversationLease(
  channel: TwilioMessageChannel,
  fromAddress: string,
  leaseOwner: string,
  leaseSeconds: number,
): Promise<Conversation | null> {
  await db
    .insert(conversations)
    .values({ phoneNumber: fromAddress, channel, state: "collecting", collected: {} })
    .onConflictDoNothing({ target: [conversations.channel, conversations.phoneNumber] });

  // SET expressions read the row before this UPDATE changes updated_at.
  // Generating rows retain their request marker until the job reaches a
  // terminal state; clearing it here would detach a late result from its draft.
  const staleDraft = sql<boolean>`
    ${conversations.updatedAt} < NOW() - (${CONVERSATION_RESUME_DAYS} * INTERVAL '1 day')
    AND ${conversations.state} <> 'generating'
  `;
  const [claimed] = await db
    .update(conversations)
    .set({
      state: sql`CASE WHEN ${staleDraft} THEN 'collecting' ELSE ${conversations.state} END`,
      collected: sql`CASE WHEN ${staleDraft} THEN '{}'::jsonb ELSE ${conversations.collected} END`,
      activeStoryId: sql`CASE WHEN ${staleDraft} THEN NULL ELSE ${conversations.activeStoryId} END`,
      leaseOwner,
      leaseExpiresAt: sql`NOW() + (${leaseSeconds} * INTERVAL '1 second')`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(conversations.channel, channel),
      eq(conversations.phoneNumber, fromAddress),
      or(isNull(conversations.leaseExpiresAt), sql`${conversations.leaseExpiresAt} <= NOW()`),
    ))
    .returning();
  return claimed ?? null;
}

export async function renewConversationLease(
  conversationId: string,
  leaseOwner: string,
  leaseSeconds: number,
): Promise<Conversation | null> {
  const [renewed] = await db
    .update(conversations)
    .set({
      leaseExpiresAt: sql`NOW() + (${leaseSeconds} * INTERVAL '1 second')`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(conversations.id, conversationId),
      eq(conversations.leaseOwner, leaseOwner),
      sql`${conversations.leaseExpiresAt} > NOW()`,
    ))
    .returning();
  return renewed ?? null;
}

export async function releaseConversationLease(
  conversationId: string,
  leaseOwner: string,
): Promise<void> {
  await db
    .update(conversations)
    .set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() })
    .where(and(eq(conversations.id, conversationId), eq(conversations.leaseOwner, leaseOwner)));
}

export async function markInboundProcessing(messageSid: string): Promise<void> {
  await db
    .update(twilioInboundMessages)
    .set({
      status: "processing",
      attemptCount: sql`${twilioInboundMessages.attemptCount} + 1`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(twilioInboundMessages.messageSid, messageSid),
      or(
        eq(twilioInboundMessages.status, "pending"),
        eq(twilioInboundMessages.status, "processing"),
      ),
    ));
}

/** Update state and its outbox reply in one PostgreSQL statement. */
export async function checkpointInboundTurn(input: {
  messageSid: string;
  conversationId: string;
  leaseOwner: string;
  state: string;
  collected: AgentCollected;
  activeStoryId: string | null;
  replyBody: string;
  submission: ComicAgentSubmission | null;
}): Promise<void> {
  const collected = JSON.stringify(input.collected);
  const submission = input.submission ? JSON.stringify(input.submission) : null;
  const result = await db.execute(sql`
    WITH checkpointed_conversation AS (
      UPDATE conversations
      SET state = ${input.state},
          collected = ${collected}::jsonb,
          active_story_id = ${input.activeStoryId}::uuid,
          updated_at = NOW()
      WHERE id = ${input.conversationId}::uuid
        AND lease_owner = ${input.leaseOwner}
        AND lease_expires_at > NOW()
      RETURNING id
    ), checkpointed_message AS (
      UPDATE twilio_inbound_messages
      SET status = 'reply_pending',
          reply_body = ${input.replyBody},
          submission = ${submission}::jsonb,
          updated_at = NOW()
      WHERE message_sid = ${input.messageSid}
        AND status <> 'completed'
        AND EXISTS (SELECT 1 FROM checkpointed_conversation)
      RETURNING message_sid
    )
    SELECT message_sid FROM checkpointed_message
  `);
  if (rowsOf<{ message_sid: string }>(result).length !== 1) {
    throw new Error("Unable to checkpoint inbound turn: conversation lease lost");
  }
}

export async function completeInboundReply(
  messageSid: string,
  outboundSid: string,
): Promise<void> {
  const [updated] = await db
    .update(twilioInboundMessages)
    .set({ status: "completed", outboundSid, updatedAt: new Date() })
    .where(and(
      eq(twilioInboundMessages.messageSid, messageSid),
      eq(twilioInboundMessages.status, "reply_pending"),
    ))
    .returning({ messageSid: twilioInboundMessages.messageSid });
  if (updated) return;

  const [existing] = await db
    .select({ status: twilioInboundMessages.status, outboundSid: twilioInboundMessages.outboundSid })
    .from(twilioInboundMessages)
    .where(eq(twilioInboundMessages.messageSid, messageSid))
    .limit(1);
  if (existing?.status === "completed" && existing.outboundSid === outboundSid) return;
  throw new Error(`Unable to complete inbound reply for ${messageSid}`);
}

/** Close a saved reply after Twilio 21610, retaining any generation checkpoint. */
export async function completeInboundOptedOutReply(messageSid: string): Promise<void> {
  // The receipt and its suppression reason commit together. A failure to write
  // history leaves the receipt open for a retry instead of hiding the rejection.
  const [suppressed] = rowsOf<{ message_sid: string }>(await db.execute(sql`
    WITH suppressed AS (
      UPDATE twilio_inbound_messages
      SET status = 'completed', updated_at = NOW()
      WHERE message_sid = ${messageSid}
        AND status = 'reply_pending'
        AND outbound_sid IS NULL
        AND reply_body IS NOT NULL
        AND reply_body <> ''
      RETURNING message_sid, channel, from_address, to_address
    ), history AS (
      INSERT INTO activity_events
        (event_key, channel, kind, direction, address, message_sid, status, details)
      SELECT
        ${`message:${messageSid}:reply:suppressed`},
        suppressed.channel,
        'message.reply.suppressed',
        'outbound',
        suppressed.from_address,
        suppressed.message_sid,
        'suppressed',
        jsonb_build_object(
          'toAddress', suppressed.to_address,
          'errorCode', '21610',
          'reason', 'recipient_opted_out',
          'purpose', 'agent_reply'
        )
      FROM suppressed
      WHERE TRUE
      ON CONFLICT (event_key) DO NOTHING
      RETURNING id
    )
    SELECT suppressed.message_sid
    FROM suppressed
    LEFT JOIN history ON TRUE
  `));
  if (suppressed?.message_sid === messageSid) return;

  const [existing] = rowsOf<{ status: string }>(await db.execute(sql`
    SELECT status
    FROM twilio_inbound_messages
    WHERE message_sid = ${messageSid}
    LIMIT 1
  `));
  if (existing?.status === "completed") return;
  throw new Error(`Unable to suppress opted-out inbound reply for ${messageSid}`);
}

/** Close a checkpointed rate-limit denial without creating an outbound SMS. */
export async function completeInboundWithoutReply(messageSid: string): Promise<void> {
  const [updated] = rowsOf<{ message_sid: string }>(await db.execute(sql`
    UPDATE twilio_inbound_messages
    SET status = 'completed', updated_at = NOW()
    WHERE message_sid = ${messageSid}
      AND status = 'reply_pending'
      AND reply_body = ''
      AND submission IS NULL
      AND outbound_sid IS NULL
    RETURNING message_sid
  `));
  if (updated?.message_sid === messageSid) return;

  const [existing] = rowsOf<{
    status: string;
    reply_body: string | null;
    submission: ComicAgentSubmission | null;
    outbound_sid: string | null;
  }>(await db.execute(sql`
    SELECT status, reply_body, submission, outbound_sid
    FROM twilio_inbound_messages
    WHERE message_sid = ${messageSid}
    LIMIT 1
  `));
  if (existing?.status === "completed" && existing.reply_body === "" &&
      existing.submission === null && existing.outbound_sid === null) return;
  throw new Error(`Unable to complete silent inbound message ${messageSid}`);
}

/**
 * Twilio can acknowledge an outbound reply before messages.create returns.
 * Use that signed callback to close the receipt so a worker crash after send
 * does not make the recovery Job send the same conversational reply again.
 */
export async function recordAgentMessageStatus(input: {
  inboundSid: string;
  messageSid: string;
  status: string;
  errorCode: string | null;
}): Promise<boolean> {
  const [receipt] = rowsOf<{ channel: string; from_address: string }>(await db.execute(sql`
    UPDATE twilio_inbound_messages
    SET status = 'completed',
        outbound_sid = ${input.messageSid},
        updated_at = NOW()
    WHERE message_sid = ${input.inboundSid}
      AND channel IN ('sms', 'whatsapp')
      AND (
        (status = 'reply_pending' AND outbound_sid IS NULL)
        OR (status = 'completed' AND outbound_sid = ${input.messageSid})
      )
    RETURNING channel, from_address
  `));
  if (!receipt) return false;

  await recordActivityEvent({
    eventKey: `message:${input.messageSid}:status:${input.status}`,
    channel: receipt.channel,
    kind: "message.delivery",
    direction: "outbound",
    address: receipt.from_address,
    messageSid: input.messageSid,
    status: input.status,
    details: {
      inReplyTo: input.inboundSid,
      errorCode: input.errorCode,
      purpose: "agent_reply",
    },
  });
  return true;
}

/** Scheduled safety net for a receipt saved while Azure Queue was unavailable. */
export async function recoverPendingInboundMessages(limit = 50): Promise<number> {
  const batchLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(Math.trunc(limit), 100))
    : 50;
  const now = Date.now();
  const pendingBefore = new Date(now - 30_000);
  const replyBefore = new Date(now - 2 * 60_000);
  const processingBefore = new Date(now - 6 * 60_000);
  const rows = await db
    .select({ messageSid: twilioInboundMessages.messageSid })
    .from(twilioInboundMessages)
    .where(or(
      and(
        eq(twilioInboundMessages.status, "pending"),
        lt(twilioInboundMessages.createdAt, pendingBefore),
      ),
      and(
        eq(twilioInboundMessages.status, "reply_pending"),
        lt(twilioInboundMessages.updatedAt, replyBefore),
      ),
      and(
        eq(twilioInboundMessages.status, "processing"),
        lt(twilioInboundMessages.updatedAt, processingBefore),
      ),
    ))
    .orderBy(asc(twilioInboundMessages.createdAt), asc(twilioInboundMessages.messageSid))
    .limit(batchLimit);

  for (const row of rows) {
    await sendInboundMessage(row.messageSid);
  }
  return rows.length;
}
