import { and, eq, gt, inArray, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import { recordActivityEvent } from "@/lib/activity-events";
import { db } from "@/lib/db";
import { generationJobs, type GenerationJob } from "@/lib/schema";
import { getStoryById } from "@/lib/db-actions";
import { sendChannelMessage, type TwilioMessageChannel } from "@/lib/twilio";

export const deliveryStatuses = [
  "accepted",
  "scheduled",
  "queued",
  "sending",
  "sent",
  "delivered",
  "read",
  "failed",
  "undelivered",
  "canceled",
] as const;

export type DeliveryStatus = (typeof deliveryStatuses)[number];

const deliveryRank: Record<DeliveryStatus, number> = {
  accepted: 0,
  scheduled: 0,
  queued: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  failed: 4,
  undelivered: 4,
  canceled: 4,
};

const terminalStatuses = [
  "delivered",
  "read",
  "failed",
  "undelivered",
  "canceled",
] as const;

// These errors can be caused by the media itself or by a handset/region that
// cannot receive MMS. A text link is useful; retrying blocked or opted-out
// messages as SMS is not.
const mediaFallbackErrorCodes = [
  "11751", "21620", "21621", "21622", "30008", "30011", "63019", "63021",
] as const;
const RESULT_DELIVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TWILIO_VALIDITY_SAFETY_SECONDS = 10;
const MIN_TWILIO_VALIDITY_SECONDS = 6;

function resultDeliveryValiditySeconds(job: Pick<GenerationJob, "createdAt">): number | null {
  const createdAt = job.createdAt instanceof Date ? job.createdAt.getTime() : NaN;
  if (!Number.isFinite(createdAt)) return null;
  const seconds = Math.floor(
    (createdAt + RESULT_DELIVERY_MAX_AGE_MS - Date.now()) / 1000,
  ) - TWILIO_VALIDITY_SAFETY_SECONDS;
  return seconds >= MIN_TWILIO_VALIDITY_SECONDS ? Math.min(seconds, 36000) : null;
}

function deliveryCutoff(now: Date): Date {
  return new Date(now.getTime() - RESULT_DELIVERY_MAX_AGE_MS +
    (TWILIO_VALIDITY_SAFETY_SECONDS + MIN_TWILIO_VALIDITY_SECONDS) * 1000);
}

export function isMediaDeliveryFailure(errorCode: string | null): boolean {
  return errorCode !== null &&
    (mediaFallbackErrorCodes as readonly string[]).includes(errorCode);
}

export function isDeliveryStatus(value: string): value is DeliveryStatus {
  return (deliveryStatuses as readonly string[]).includes(value);
}

export function shouldRecordDeliveryStatus(
  current: string | null,
  next: DeliveryStatus,
): boolean {
  if (!current) return true;
  if (current === "delivered") return next === "read";
  if ((terminalStatuses as readonly string[]).includes(current)) return false;
  return deliveryRank[next] > (isDeliveryStatus(current) ? deliveryRank[current] : -1);
}

export interface GeneratedMessageStatus {
  jobId: string;
  messageSid: string;
  status: DeliveryStatus;
  errorCode: string | null;
}

type DeliveryContext = Pick<
  GenerationJob,
  "id" | "userId" | "source" | "recipientAddress" | "storyId" | "attemptCount"
>;

async function logMessageDelivery(
  job: DeliveryContext,
  messageSid: string,
  status: DeliveryStatus,
  errorCode: string | null,
  fallback: boolean,
): Promise<void> {
  try {
    await recordActivityEvent({
      eventKey: `message:${messageSid}:status:${status}`,
      userId: job.userId,
      channel: job.source === "voice" ? "sms" : job.source,
      kind: "message.delivery",
      direction: "outbound",
      address: job.recipientAddress,
      messageSid,
      jobId: job.id,
      storyId: job.storyId,
      status,
      details: { source: job.source, fallback, errorCode, attemptCount: job.attemptCount },
    });
  } catch (error) {
    console.error("Delivery history failed", {
      jobId: job.id,
      messageSid,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

/** Atomically reject stale callbacks and callbacks for a different Message SID. */
export async function recordGeneratedMessageStatus({
  jobId,
  messageSid,
  status,
  errorCode,
}: GeneratedMessageStatus): Promise<boolean> {
  const currentRank = sql<number>`CASE ${generationJobs.deliveryStatus}
    WHEN 'accepted' THEN 0
    WHEN 'scheduled' THEN 0
    WHEN 'queued' THEN 0
    WHEN 'sending' THEN 1
    WHEN 'sent' THEN 2
    ELSE -1
  END`;
  const transition = or(
    isNull(generationJobs.deliveryStatus),
    and(
      notInArray(generationJobs.deliveryStatus, [...terminalStatuses]),
      lt(currentRank, deliveryRank[status]),
    ),
    status === "read" ? eq(generationJobs.deliveryStatus, "delivered") : undefined,
  );

  const [updated] = await db
    .update(generationJobs)
    .set({
      deliverySid: sql`COALESCE(${generationJobs.deliverySid}, ${messageSid})`,
      deliveryStatus: status,
      deliveryErrorCode:
        status === "failed" || status === "undelivered" ? errorCode : null,
      deliveryUpdatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(generationJobs.id, jobId),
        or(
          isNull(generationJobs.deliverySid),
          eq(generationJobs.deliverySid, messageSid),
        ),
        transition,
      ),
    )
    .returning({
      id: generationJobs.id,
      userId: generationJobs.userId,
      source: generationJobs.source,
      recipientAddress: generationJobs.recipientAddress,
      storyId: generationJobs.storyId,
      attemptCount: generationJobs.attemptCount,
    });
  if (updated) await logMessageDelivery(updated, messageSid, status, errorCode, false);
  return Boolean(updated);
}

/** A failure notice is a separate SMS, never the generated comic delivery. */
export async function recordFailedGenerationNoticeStatus({
  jobId,
  messageSid,
  status,
  errorCode,
}: GeneratedMessageStatus): Promise<boolean> {
  const [job] = await db
    .select({
      id: generationJobs.id,
      userId: generationJobs.userId,
      source: generationJobs.source,
      recipientAddress: generationJobs.recipientAddress,
      attemptCount: generationJobs.attemptCount,
    })
    .from(generationJobs)
    .where(and(eq(generationJobs.id, jobId), eq(generationJobs.status, "failed")))
    .limit(1);
  if (!job) return false;

  await recordActivityEvent({
    eventKey: `message:${messageSid}:status:${status}`,
    userId: job.userId,
    channel: job.source === "voice" ? "sms" : job.source,
    kind: "message.delivery",
    direction: "outbound",
    address: job.recipientAddress,
    messageSid,
    jobId,
    status,
    details: {
      source: job.source,
      purpose: "generation_failure_notice",
      errorCode,
      attemptCount: job.attemptCount,
    },
  });
  return true;
}

/** Track the independent text-only fallback without overwriting the MMS result. */
export async function recordFallbackMessageStatus({
  jobId,
  messageSid,
  status,
  errorCode,
}: GeneratedMessageStatus): Promise<boolean> {
  const currentRank = sql<number>`CASE ${generationJobs.deliveryFallbackStatus}
    WHEN 'accepted' THEN 0
    WHEN 'scheduled' THEN 0
    WHEN 'queued' THEN 0
    WHEN 'sending' THEN 1
    WHEN 'sent' THEN 2
    ELSE -1
  END`;
  const transition = or(
    isNull(generationJobs.deliveryFallbackStatus),
    // The claim starts at our internal `sending` state. Twilio can report a
    // lower-ranked `queued` event before messages.create returns; still save
    // its SID so recovery cannot send a duplicate if this process then dies.
    and(
      isNull(generationJobs.deliveryFallbackSid),
      eq(generationJobs.deliveryFallbackStatus, "sending"),
    ),
    and(
      notInArray(generationJobs.deliveryFallbackStatus, [...terminalStatuses]),
      lt(currentRank, deliveryRank[status]),
    ),
    status === "read" ? eq(generationJobs.deliveryFallbackStatus, "delivered") : undefined,
  );

  const [updated] = await db
    .update(generationJobs)
    .set({
      deliveryFallbackSid: sql`COALESCE(${generationJobs.deliveryFallbackSid}, ${messageSid})`,
      deliveryFallbackStatus: deliveryRank[status] === 0
        ? sql`CASE WHEN ${generationJobs.deliveryFallbackStatus} = 'sending'
            THEN 'sending' ELSE ${status} END`
        : status,
      deliveryFallbackErrorCode:
        status === "failed" || status === "undelivered" ? errorCode : null,
      deliveryFallbackUpdatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(generationJobs.id, jobId),
        or(
          isNull(generationJobs.deliveryFallbackSid),
          eq(generationJobs.deliveryFallbackSid, messageSid),
        ),
        transition,
      ),
    )
    .returning({
      id: generationJobs.id,
      userId: generationJobs.userId,
      source: generationJobs.source,
      recipientAddress: generationJobs.recipientAddress,
      storyId: generationJobs.storyId,
      attemptCount: generationJobs.attemptCount,
    });
  if (updated) await logMessageDelivery(updated, messageSid, status, errorCode, true);
  return Boolean(updated);
}

function eligibleForTextFallback(now: Date) {
  return and(
    eq(generationJobs.deliveryHadMedia, true),
    inArray(generationJobs.deliveryStatus, ["failed", "undelivered"]),
    inArray(generationJobs.deliveryErrorCode, [...mediaFallbackErrorCodes]),
    isNull(generationJobs.deliveryFallbackSid),
    or(
      isNull(generationJobs.deliveryFallbackStatus),
      notInArray(generationJobs.deliveryFallbackStatus, ["suppressed"]),
    ),
    lt(generationJobs.deliveryFallbackAttempts, 2),
    or(
      isNull(generationJobs.deliveryFallbackLeaseExpiresAt),
      lt(generationJobs.deliveryFallbackLeaseExpiresAt, now),
    ),
  );
}

/** Keep expired fallback attempts visible in history without messaging an old number. */
async function suppressExpiredTextFallback(jobId: string, now = new Date()): Promise<void> {
  const [job] = await db
    .update(generationJobs)
    .set({
      deliveryFallbackStatus: "suppressed",
      deliveryFallbackLeaseExpiresAt: null,
      deliveryFallbackUpdatedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(generationJobs.id, jobId),
      eq(generationJobs.deliveryHadMedia, true),
      inArray(generationJobs.deliveryStatus, ["failed", "undelivered"]),
      inArray(generationJobs.deliveryErrorCode, [...mediaFallbackErrorCodes]),
      isNull(generationJobs.deliveryFallbackSid),
      or(
        isNull(generationJobs.deliveryFallbackStatus),
        notInArray(generationJobs.deliveryFallbackStatus, ["suppressed"]),
      ),
      lte(generationJobs.createdAt, deliveryCutoff(now)),
    ))
    .returning({
      id: generationJobs.id,
      userId: generationJobs.userId,
      source: generationJobs.source,
      recipientAddress: generationJobs.recipientAddress,
      storyId: generationJobs.storyId,
      attemptCount: generationJobs.attemptCount,
    });
  if (!job) return;
  try {
    await recordActivityEvent({
      eventKey: `job:${job.id}:fallback:suppressed`,
      userId: job.userId,
      channel: job.source === "voice" ? "sms" : job.source,
      kind: "generation.delivery",
      direction: "internal",
      address: job.recipientAddress,
      jobId: job.id,
      storyId: job.storyId,
      status: "suppressed",
      details: {
        reason: "delivery_window_expired",
        fallback: true,
        attemptCount: job.attemptCount,
      },
    });
  } catch (error) {
    console.error("Fallback suppression history failed", {
      jobId,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

/** Claim at most two text-link attempts across duplicate callbacks and recovery runs. */
export async function sendFailedMmsTextFallback(jobId: string): Promise<boolean> {
  const now = new Date();
  const [job] = await db
    .update(generationJobs)
    .set({
      deliveryFallbackStatus: "sending",
      deliveryFallbackAttempts: sql`${generationJobs.deliveryFallbackAttempts} + 1`,
      deliveryFallbackLeaseExpiresAt: sql`NOW() + INTERVAL '2 minutes'`,
      deliveryFallbackUpdatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      eq(generationJobs.id, jobId),
      eligibleForTextFallback(now),
      gt(generationJobs.createdAt, deliveryCutoff(now)),
    ))
    .returning();
  if (!job) {
    await suppressExpiredTextFallback(jobId, now);
    return false;
  }

  let acceptedSid: string | undefined;
  try {
    if (!job.storyId) throw new Error("Generated comic has no story ID for delivery fallback");
    const story = await getStoryById(job.storyId);
    if (!story) throw new Error("Generated comic story was not found for delivery fallback");
    const baseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
    if (!baseUrl) throw new Error("PUBLIC_BASE_URL is not configured");
    const body = `Your comic "${story.title.slice(0, 100)}" is ready. View it here: ${baseUrl}/story/${story.slug}`;
    const validityPeriod = resultDeliveryValiditySeconds(job);
    if (validityPeriod === null) {
      await suppressExpiredTextFallback(jobId);
      return false;
    }
    const channel = (job.source === "voice" ? "sms" : job.source) as TwilioMessageChannel;
    acceptedSid = await sendChannelMessage({
      channel,
      to: job.recipientAddress,
      from: job.senderAddress,
      body,
      ...(channel === "sms" ? { validityPeriod } : {}),
      statusCallback: `${baseUrl}/api/twilio/status?jobId=${encodeURIComponent(job.id)}&fallback=1#rc=3&rp=5xx,ct,rt`,
    });

    try {
      await recordActivityEvent({
        eventKey: `job:${job.id}:fallback:${acceptedSid}:accepted`,
        userId: job.userId,
        channel: job.source === "voice" ? "sms" : job.source,
        kind: "generation.delivery",
        direction: "outbound",
        address: job.recipientAddress,
        messageSid: acceptedSid,
        jobId: job.id,
        storyId: job.storyId,
        content: body,
        status: "accepted",
        details: {
          fallback: true,
          hadMedia: false,
          attemptCount: job.attemptCount,
          fallbackAttempt: job.deliveryFallbackAttempts,
        },
      });
    } catch (error) {
      console.error("Text fallback history failed", {
        jobId: job.id,
        error: error instanceof Error ? error.name : "unknown",
      });
    }

    await db
      .update(generationJobs)
      .set({
        deliveryFallbackSid: sql`COALESCE(${generationJobs.deliveryFallbackSid}, ${acceptedSid})`,
        deliveryFallbackStatus: sql`CASE
          WHEN ${generationJobs.deliveryFallbackStatus} IN
            ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'undelivered', 'canceled')
            THEN ${generationJobs.deliveryFallbackStatus}
          ELSE 'accepted'
        END`,
        deliveryFallbackLeaseExpiresAt: null,
        deliveryFallbackUpdatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(generationJobs.id, job.id),
          or(
            isNull(generationJobs.deliveryFallbackSid),
            eq(generationJobs.deliveryFallbackSid, acceptedSid),
          ),
        ),
      );
    return true;
  } catch (error) {
    // If Twilio accepted the message but the DB checkpoint failed, retain the
    // lease. A later recovery can retry, but may duplicate an accepted send.
    if (!acceptedSid) {
      try {
        await db
          .update(generationJobs)
          .set({
            deliveryFallbackStatus: job.deliveryFallbackAttempts >= 2
              ? "failed"
              : "retry_pending",
            deliveryFallbackLeaseExpiresAt: null,
            deliveryFallbackUpdatedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(generationJobs.id, job.id), isNull(generationJobs.deliveryFallbackSid)));
      } catch (checkpointError) {
        console.error("Failed to checkpoint text fallback error", checkpointError);
      }
    }
    throw error;
  }
}

/** Retry recorded media failures whose text fallback was interrupted. */
export async function recoverFailedMmsTextFallbacks(limit = 50): Promise<number> {
  const candidates = await db
    .select({ id: generationJobs.id })
    .from(generationJobs)
    .where(eligibleForTextFallback(new Date()))
    .orderBy(generationJobs.deliveryUpdatedAt)
    .limit(Math.max(1, Math.min(limit, 100)));
  let sent = 0;
  for (const candidate of candidates) {
    try {
      if (await sendFailedMmsTextFallback(candidate.id)) sent++;
    } catch (error) {
      console.error("Failed to send comic text fallback", candidate.id, error);
    }
  }
  return sent;
}
