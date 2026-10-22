import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { recordActivityEvent } from "@/lib/activity-events";
import { db } from "@/lib/db";
import { generationJobs, type GenerationJob } from "@/lib/schema";
import { sendGenerationJob } from "@/lib/generation-queue";
import { releaseFreeTierQuota, reserveFreeTierQuota } from "@/lib/quota";
import { DAILY_GENERATION_CAPACITY_REASON } from "@/lib/generation-policy";
import { reserveDailyGenerationCapacity } from "@/lib/generation-capacity";
import type { MessagingChannel } from "@/lib/channel-identities";

export interface SubmitGenerationJobInput {
  idempotencyKey: string;
  userId: string;
  source: MessagingChannel;
  recipientAddress: string;
  senderAddress: string;
  prompt: string;
  style?: string;
  characterImageUrls?: string[];
  targetStoryId?: string;
}

/** A queue delivery finished after its processing lease was replaced or closed. */
export class GenerationJobLeaseLostError extends Error {
  constructor(jobId: string) {
    super(`Generation job lease lost: ${jobId}`);
    this.name = "GenerationJobLeaseLostError";
  }
}

function assertProcessingLeaseUpdated(rows: { id: string }[], jobId: string): void {
  if (rows.length === 0) throw new GenerationJobLeaseLostError(jobId);
}

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows?: T[] }).rows ?? (result as T[]);
}

async function logGenerationEvent(
  job: GenerationJob,
  kind: string,
  suffix: string,
  status: string,
  details: Record<string, unknown>,
  content?: string,
): Promise<void> {
  try {
    await recordActivityEvent({
      eventKey: `job:${job.id}:${suffix}`,
      userId: job.userId,
      channel: job.source,
      kind,
      direction: "internal",
      address: job.recipientAddress,
      jobId: job.id,
      storyId: job.targetStoryId || null,
      content,
      status,
      details,
    });
  } catch (error) {
    console.error("Generation history failed", {
      jobId: job.id,
      kind,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

export async function getGenerationJob(
  jobId: string,
): Promise<GenerationJob | null> {
  const [job] = await db
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.id, jobId))
    .limit(1);
  return job ?? null;
}

export async function submitGenerationJob(
  input: SubmitGenerationJobInput,
): Promise<{ job: GenerationJob; accepted: boolean; remaining: number }> {
  const jobId = randomUUID();
  const publisherId = randomUUID();
  const quotaClaimKey = `generation-job:${jobId}`;
  const [inserted] = await db
    .insert(generationJobs)
    .values({
      id: jobId,
      idempotencyKey: input.idempotencyKey,
      userId: input.userId,
      source: input.source,
      recipientAddress: input.recipientAddress,
      senderAddress: input.senderAddress,
      prompt: input.prompt,
      style: input.style || "noir",
      characterImageUrls: input.characterImageUrls || [],
      targetStoryId: input.targetStoryId || null,
      quotaClaimKey,
      status: "admitting",
      leaseOwner: publisherId,
      leaseExpiresAt: sql`NOW() + INTERVAL '2 minutes'`,
    })
    .onConflictDoNothing({ target: generationJobs.idempotencyKey })
    .returning();

  let job = inserted || (await getGenerationJobByIdempotencyKey(input.idempotencyKey));
  if (!job) throw new Error("Failed to create generation job");

  await logGenerationEvent(job, "generation.requested", "requested", "received", {
    style: job.style,
    referenceCount: job.characterImageUrls.length,
    continuation: Boolean(job.targetStoryId),
  }, job.prompt);

  if (["queued", "processing", "succeeded"].includes(job.status)) {
    return { job, accepted: true, remaining: 0 };
  }
  if (job.status === "quota_rejected") {
    return { job, accepted: false, remaining: 0 };
  }
  if (job.status === "failed") {
    return { job, accepted: false, remaining: 0 };
  }
  if (!inserted && ["admitting", "pending"].includes(job.status)) {
    const [claimed] = await db
      .update(generationJobs)
      .set({
        leaseOwner: publisherId,
        leaseExpiresAt: sql`NOW() + INTERVAL '2 minutes'`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(generationJobs.id, job.id),
          eq(generationJobs.status, job.status),
          or(
            isNull(generationJobs.leaseExpiresAt),
            lt(generationJobs.leaseExpiresAt, new Date()),
          ),
        ),
      )
      .returning();
    if (!claimed) {
      const current = await getGenerationJob(job.id);
      if (!current) throw new Error("Generation job disappeared during publish");
      return {
        job: current,
        accepted: ["queued", "processing", "succeeded"].includes(current.status),
        remaining: 0,
      };
    }
    job = claimed;
  }

  if (job.status === "enqueue_failed") {
    const [retryable] = await db
      .update(generationJobs)
      .set({
        quotaClaimKey: `generation-job:${job.id}:${randomUUID()}`,
        status: "admitting",
        leaseOwner: publisherId,
        leaseExpiresAt: sql`NOW() + INTERVAL '2 minutes'`,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(generationJobs.id, job.id),
          eq(generationJobs.status, "enqueue_failed"),
        ),
      )
      .returning();
    if (!retryable) {
      const current = await getGenerationJob(job.id);
      if (!current) throw new Error("Generation job disappeared during retry");
      if (current.status === "enqueue_failed" || current.status === "failed") {
        throw new Error("Generation job could not be enqueued");
      }
      return {
        job: current,
        accepted: ["queued", "processing", "succeeded"].includes(current.status),
        remaining: 0,
      };
    }
    job = retryable;
  }

  // The user reservation, app-wide admission, and terminal rejection share a
  // transaction. A capacity denial releases the user's weekly slot before the
  // transaction commits. Any database error rolls all three changes back.
  const admission = await db.transaction(async (tx) => {
    const reservation = await reserveFreeTierQuota(job.userId, job.quotaClaimKey, tx);
    let rejectionReason: "free_tier_quota" | typeof DAILY_GENERATION_CAPACITY_REASON | null = null;
    if (!reservation.allowed) {
      rejectionReason = "free_tier_quota";
    } else if (!(await reserveDailyGenerationCapacity(job.id, tx))) {
      if (reservation.status !== "reserved") {
        throw new Error("Cannot release a consumed quota claim after capacity denial");
      }
      await releaseFreeTierQuota(job.quotaClaimKey, tx);
      rejectionReason = DAILY_GENERATION_CAPACITY_REASON;
    }
    if (rejectionReason) {
      const [rejected] = await tx
        .update(generationJobs)
        .set({
          status: "quota_rejected",
          lastError: rejectionReason === DAILY_GENERATION_CAPACITY_REASON
            ? DAILY_GENERATION_CAPACITY_REASON : null,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(and(
          eq(generationJobs.id, job.id),
          eq(generationJobs.status, job.status),
          eq(generationJobs.leaseOwner, publisherId),
        ))
        .returning();
      if (!rejected) throw new Error("Generation job lease changed during admission");
      return { accepted: false as const, job: rejected, remaining: reservation.remaining, rejectionReason };
    }
    const [ready] = await tx
      .update(generationJobs)
      .set({ status: "pending", updatedAt: new Date() })
      .where(and(
        eq(generationJobs.id, job.id),
        eq(generationJobs.status, job.status),
        eq(generationJobs.leaseOwner, publisherId),
      ))
      .returning();
    if (!ready) throw new Error("Generation job lease changed during admission");
    return { accepted: true as const, job: ready, remaining: reservation.remaining };
  });
  if (!admission.accepted) {
    await logGenerationEvent(admission.job, "generation.rejected", "rejected", "quota_rejected", {
      reason: admission.rejectionReason,
      remaining: admission.remaining,
    });
    return { job: admission.job, accepted: false, remaining: admission.remaining };
  }
  const reservation = admission;
  job = admission.job;

  try {
    await sendGenerationJob(job.id);
  } catch (error) {
    // A transport error can occur after Azure accepted the queue message.
    // Keep the quota reservation and a claimable pending job; a queue worker
    // or the recovery sweep may safely process/publish it by job ID.
    const [pending] = await db
      .update(generationJobs)
      .set({
        lastError: error instanceof Error ? error.message.slice(0, 1000) : "Queue publish failed",
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(generationJobs.id, job.id),
          eq(generationJobs.status, "pending"),
          eq(generationJobs.leaseOwner, publisherId),
        ),
      )
      .returning();
    if (!pending) {
      const current = await getGenerationJob(job.id);
      if (current && ["queued", "processing", "succeeded"].includes(current.status)) {
        return { job: current, accepted: true, remaining: reservation.remaining };
      }
    }
    throw error;
  }
  await logGenerationEvent(job, "generation.queued", "queued", "queued", {
    queueAcceptedAt: new Date().toISOString(),
  });
  let queued: GenerationJob | undefined;
  try {
    [queued] = await db
      .update(generationJobs)
      .set({
        status: "queued",
        queuedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(generationJobs.id, job.id),
          eq(generationJobs.status, "pending"),
          eq(generationJobs.leaseOwner, publisherId),
        ),
      )
      .returning();
  } catch (error) {
    // The queue send has succeeded. The worker can claim a pending job even
    // when this optional checkpoint is temporarily unavailable.
    console.error("Queue publish succeeded but job checkpoint failed", error);
    return { job, accepted: true, remaining: reservation.remaining };
  }
  return {
    job: queued || (await getGenerationJob(job.id)) || job,
    accepted: true,
    remaining: reservation.remaining,
  };
}

export async function getGenerationJobByIdempotencyKey(
  idempotencyKey: string,
): Promise<GenerationJob | null> {
  const [job] = await db
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.idempotencyKey, idempotencyKey))
    .limit(1);
  return job ?? null;
}

/** Re-publish jobs stranded by a process crash or a lost Azure Queue message. */
export async function recoverUnpublishedGenerationJobs(limit = 50): Promise<number> {
  const now = new Date();
  const staleQueuedAt = new Date(now.getTime() - 5 * 60_000);
  const candidates = await db
    .select()
    .from(generationJobs)
    .where(
      or(
        and(
          eq(generationJobs.status, "admitting"),
          or(
            isNull(generationJobs.leaseExpiresAt),
            lt(generationJobs.leaseExpiresAt, now),
          ),
        ),
        and(
          eq(generationJobs.status, "pending"),
          or(
            isNull(generationJobs.leaseExpiresAt),
            lt(generationJobs.leaseExpiresAt, now),
          ),
        ),
        eq(generationJobs.status, "enqueue_failed"),
        and(
          eq(generationJobs.status, "queued"),
          or(isNull(generationJobs.queuedAt), lt(generationJobs.queuedAt, staleQueuedAt)),
        ),
        and(
          eq(generationJobs.status, "processing"),
          lt(generationJobs.leaseExpiresAt, now),
        ),
      ),
    )
    .orderBy(generationJobs.createdAt)
    .limit(Math.max(1, Math.min(limit, 100)));

  let recovered = 0;
  for (const candidate of candidates) {
    try {
      if (["admitting", "pending", "enqueue_failed"].includes(candidate.status)) {
        const retry = await submitGenerationJob({
          idempotencyKey: candidate.idempotencyKey,
          userId: candidate.userId,
          source: candidate.source as MessagingChannel,
          recipientAddress: candidate.recipientAddress,
          senderAddress: candidate.senderAddress,
          prompt: candidate.prompt,
          style: candidate.style,
          characterImageUrls: candidate.characterImageUrls,
          targetStoryId: candidate.targetStoryId || undefined,
        });
        if (retry.accepted) recovered++;
        continue;
      }

      const [claim] = await db
        .update(generationJobs)
        .set({ queuedAt: now, updatedAt: now })
        .where(
          and(
            eq(generationJobs.id, candidate.id),
            eq(generationJobs.status, candidate.status),
            candidate.status === "processing"
              ? lt(generationJobs.leaseExpiresAt, now)
              : or(
                  isNull(generationJobs.queuedAt),
                  lt(generationJobs.queuedAt, staleQueuedAt),
                ),
          ),
        )
        .returning();
      if (!claim) continue;
      await sendGenerationJob(candidate.id);
      recovered++;
    } catch (error) {
      console.error("Failed to recover generation job", candidate.id, error);
    }
  }
  await reconcileTerminalGenerationConversations(limit);
  return recovered;
}

/** Repair a conversation if the generation Job finished during a DB outage. */
export async function reconcileTerminalGenerationConversations(limit = 50): Promise<number> {
  const result = await db.execute(sql`
    WITH ready AS (
      SELECT c.id, j.status, j.story_id
      FROM conversations c
      JOIN generation_jobs j
        ON j.recipient_address = c.phone_number
       AND j.source = c.channel
       AND j.idempotency_key = c.collected->>'generationRequestKey'
      WHERE c.state = 'generating'
        AND j.status IN ('succeeded', 'failed', 'quota_rejected')
      ORDER BY j.updated_at
      LIMIT ${Math.max(1, Math.min(limit, 100))}
    )
    UPDATE conversations c
    SET state = CASE
          WHEN ready.status = 'succeeded' AND ready.story_id IS NOT NULL
            THEN 'done'
          WHEN ready.status = 'failed' AND ready.story_id IS NOT NULL
            THEN 'done'
          ELSE 'confirming'
        END,
        active_story_id = CASE
          WHEN ready.status = 'succeeded' AND ready.story_id IS NOT NULL
            THEN ready.story_id
          WHEN ready.status = 'failed' AND ready.story_id IS NOT NULL
            THEN ready.story_id
          ELSE c.active_story_id
        END,
        collected = c.collected - 'generationRequestKey',
        updated_at = NOW()
    FROM ready
    WHERE c.id = ready.id
    RETURNING c.id
  `);
  const rows = "rows" in result ? result.rows : result;
  return rows.length;
}

export async function claimGenerationJob(
  jobId: string,
  workerId: string,
  leaseSeconds = 600,
): Promise<GenerationJob | null> {
  const now = new Date();
  const [job] = await db
    .update(generationJobs)
    .set({
      status: "processing",
      leaseOwner: workerId,
      leaseExpiresAt: sql`NOW() + (${leaseSeconds} * INTERVAL '1 second')`,
      attemptCount: sql`${generationJobs.attemptCount} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(generationJobs.id, jobId),
        or(
          eq(generationJobs.status, "pending"),
          eq(generationJobs.status, "queued"),
          and(
            eq(generationJobs.status, "processing"),
            lt(generationJobs.leaseExpiresAt, now),
          ),
        ),
      ),
    )
    .returning();
  return job ?? null;
}

export async function markGenerationJobSucceeded(
  jobId: string,
  workerId: string,
  data: { storyId: string; imageUrl: string; deliverySid: string },
): Promise<void> {
  const rows = await db
    .update(generationJobs)
    .set({
      ...data,
      status: "succeeded",
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      eq(generationJobs.id, jobId),
      eq(generationJobs.status, "processing"),
      eq(generationJobs.leaseOwner, workerId),
    ))
    .returning({ id: generationJobs.id });
  assertProcessingLeaseUpdated(rows, jobId);
}

export async function checkpointGenerationDelivery(
  jobId: string,
  workerId: string,
  data: { storyId: string; imageUrl: string; deliverySid: string },
): Promise<void> {
  const rows = await db
    .update(generationJobs)
    .set({ ...data, updatedAt: new Date() })
    .where(and(
      eq(generationJobs.id, jobId),
      eq(generationJobs.status, "processing"),
      eq(generationJobs.leaseOwner, workerId),
    ))
    .returning({ id: generationJobs.id });
  assertProcessingLeaseUpdated(rows, jobId);
}

/** Persist the finished comic and whether this send includes media before calling Twilio. */
export async function checkpointGenerationOutput(
  jobId: string,
  workerId: string,
  data: { storyId: string; imageUrl: string; deliveryHadMedia: boolean },
): Promise<void> {
  const rows = await db
    .update(generationJobs)
    .set({ ...data, updatedAt: new Date() })
    .where(and(
      eq(generationJobs.id, jobId),
      eq(generationJobs.status, "processing"),
      eq(generationJobs.leaseOwner, workerId),
    ))
    .returning({ id: generationJobs.id });
  assertProcessingLeaseUpdated(rows, jobId);
}

async function transitionGenerationJobFailed(
  jobId: string,
  workerId: string,
  error: string,
  savedStoryId?: string,
): Promise<void> {
  // A saved comic spends the weekly credit even when delivery is suppressed.
  // The terminal transition, claim update, and any quota refund are atomic.
  // A stale owner updates no job and no claim.
  const savedStoryAssignment = savedStoryId
    ? sql`story_id = COALESCE(j.story_id, ${savedStoryId}::uuid),`
    : sql``;
  const matchingStory = savedStoryId
    ? sql`AND (j.story_id IS NULL OR j.story_id = ${savedStoryId}::uuid)`
    : sql``;
  const result = await db.execute(sql`
    WITH failed_job AS (
      UPDATE generation_jobs AS j
      SET status = 'failed',
          ${savedStoryAssignment}
          last_error = ${error.slice(0, 1000)},
          lease_owner = NULL,
          lease_expires_at = NULL,
          completed_at = NOW(),
          updated_at = NOW()
      WHERE j.id = ${jobId}
        AND j.status = 'processing'
        AND j.lease_owner = ${workerId}
        AND j.delivery_sid IS NULL
        ${matchingStory}
      RETURNING j.id, j.quota_claim_key, j.story_id
    ),
    consumed_claim AS (
      UPDATE free_tier_quota_claims AS claim
      SET status = 'consumed', updated_at = NOW()
      FROM failed_job
      WHERE claim.claim_key = failed_job.quota_claim_key
        AND claim.status = 'reserved'
        AND failed_job.story_id IS NOT NULL
      RETURNING claim.claim_key
    ),
    released_claim AS (
      UPDATE free_tier_quota_claims AS claim
      SET status = 'released', updated_at = NOW()
      FROM failed_job
      WHERE claim.claim_key = failed_job.quota_claim_key
        AND claim.status = 'reserved'
        AND failed_job.story_id IS NULL
      RETURNING claim.subject, claim.window_started_at
    ),
    decremented_quota AS (
      UPDATE free_tier_quotas AS quota
      SET used = GREATEST(0, quota.used - 1), updated_at = NOW()
      FROM released_claim
      WHERE quota.subject = released_claim.subject
        AND quota.window_started_at = released_claim.window_started_at
      RETURNING quota.subject
    )
    SELECT failed_job.id,
      (SELECT COUNT(*) FROM consumed_claim) AS consumed_claims,
      (SELECT COUNT(*) FROM decremented_quota) AS quota_rows
    FROM failed_job
  `);
  assertProcessingLeaseUpdated(rowsOf<{ id: string }>(result), jobId);
}

/** Terminal failure before a comic exists refunds quota; a saved result does not. */
export async function markGenerationJobFailed(
  jobId: string,
  workerId: string,
  error: string,
): Promise<void> {
  await transitionGenerationJobFailed(jobId, workerId, error);
}

/** Preserve the saved comic and its weekly credit when result delivery stops. */
export async function markGenerationJobSuppressed(
  jobId: string,
  workerId: string,
  error: string,
  savedStoryId: string,
): Promise<void> {
  await transitionGenerationJobFailed(jobId, workerId, error, savedStoryId);
}

export async function returnGenerationJobToQueue(
  jobId: string,
  workerId: string,
  error: string,
): Promise<void> {
  const rows = await db
    .update(generationJobs)
    .set({
      status: "queued",
      lastError: error.slice(0, 1000),
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(generationJobs.id, jobId),
      eq(generationJobs.status, "processing"),
      eq(generationJobs.leaseOwner, workerId),
    ))
    .returning({ id: generationJobs.id });
  assertProcessingLeaseUpdated(rows, jobId);
}
