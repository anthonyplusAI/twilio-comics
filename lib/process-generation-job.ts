import { recordActivityEvent } from "@/lib/activity-events";
import { blobExists, getBlobPublicUrl, uploadBufferToBlob } from "@/lib/blob-storage";
import {
  cleanupFailedContinuationPage,
  createComicContinuationPage,
  createComicStory,
  ComicServiceError,
} from "@/lib/comic-service";
import {
  GenerationJobLeaseLostError,
  checkpointGenerationDelivery,
  checkpointGenerationOutput,
  claimGenerationJob,
  getGenerationJob,
  markGenerationJobFailed,
  markGenerationJobSucceeded,
  returnGenerationJobToQueue,
} from "@/lib/generation-jobs";
import { consumeFreeTierQuota } from "@/lib/quota";
import {
  downloadTwilioMedia,
  isTwilioMediaUrl,
  sendChannelMessage,
  type TwilioMessageChannel,
} from "@/lib/twilio";
import {
  completeConversationForGeneration,
  failConversationForGeneration,
} from "@/lib/db-actions";
import { createMmsPreview } from "@/lib/mms-preview";
import sharp from "sharp";
import type { GenerationJob } from "@/lib/schema";

const RESULT_DELIVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TWILIO_VALIDITY_SAFETY_SECONDS = 10;
const MIN_TWILIO_VALIDITY_SECONDS = 6;
const EXPIRED_DELIVERY_REASON = "Result delivery expired after 24 hours";

function resultDeliveryValiditySeconds(job: Pick<GenerationJob, "createdAt">): number | null {
  const createdAt = job.createdAt instanceof Date ? job.createdAt.getTime() : NaN;
  if (!Number.isFinite(createdAt)) return null;
  // Twilio measures validity from API acceptance, so leave a small margin for
  // request travel and never set a queue period beyond the job's deadline.
  const seconds = Math.floor(
    (createdAt + RESULT_DELIVERY_MAX_AGE_MS - Date.now()) / 1000,
  ) - TWILIO_VALIDITY_SAFETY_SECONDS;
  return seconds >= MIN_TWILIO_VALIDITY_SECONDS ? Math.min(seconds, 36000) : null;
}

function resultDeliveryExpired(job: Pick<GenerationJob, "createdAt">): boolean {
  return resultDeliveryValiditySeconds(job) === null;
}

function elapsedMs(since: Date | null | undefined): number | null {
  return since instanceof Date ? Math.max(0, Date.now() - since.getTime()) : null;
}

function errorDetails(error: unknown): Record<string, unknown> {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
  return {
    errorType: error instanceof ComicServiceError
      ? error.type : error instanceof Error ? error.name : "unknown",
    httpStatus: error instanceof ComicServiceError ? error.status || null : null,
    errorCode: /^[A-Za-z0-9_-]{1,32}$/.test(code) ? code : null,
  };
}

async function logGenerationEvent(
  job: GenerationJob,
  kind: string,
  suffix: string,
  status: string,
  details: Record<string, unknown>,
  options: { storyId?: string | null; messageSid?: string | null; content?: string } = {},
): Promise<void> {
  try {
    await recordActivityEvent({
      eventKey: `job:${job.id}:${suffix}`,
      userId: job.userId,
      channel: job.source,
      kind,
      direction: kind === "generation.delivery" && status !== "suppressed"
        ? "outbound" : "internal",
      address: job.recipientAddress,
      jobId: job.id,
      storyId: options.storyId || job.storyId || null,
      messageSid: options.messageSid || null,
      content: options.content,
      status,
      details: { attemptCount: job.attemptCount, ...details },
    });
  } catch (error) {
    console.error("Generation history failed", {
      jobId: job.id,
      kind,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

async function logGenerationSuccess(job: GenerationJob, storyId: string, deliverySid: string): Promise<void> {
  await logGenerationEvent(job, "generation.succeeded", "succeeded", "succeeded", {
    deliverySid,
    totalDurationMs: elapsedMs(job.createdAt),
    processingMs: elapsedMs(job.updatedAt),
  }, { storyId, messageSid: deliverySid });
}

async function suppressExpiredResult(
  job: GenerationJob,
  workerId: string,
  storyId: string | null = job.storyId,
): Promise<void> {
  // The existing failed state is terminal and releases the reserved quota.
  // Any generated story and page remain saved; a late result is never sent to
  // a number that may now belong to someone else.
  await markGenerationJobFailed(job.id, workerId, EXPIRED_DELIVERY_REASON);
  await logGenerationEvent(job, "generation.delivery", "delivery:expired", "suppressed", {
    reason: "delivery_window_expired",
    resultGenerated: Boolean(storyId),
    ageMs: elapsedMs(job.createdAt),
  }, { storyId });
  await logGenerationEvent(job, "generation.failed", "failed", "failed", {
    reason: "delivery_window_expired",
    resultGenerated: Boolean(storyId),
    totalDurationMs: elapsedMs(job.createdAt),
  }, { storyId });
}

function extensionFor(contentType: string): string {
  return contentType.includes("png") ? "png" : "jpg";
}

async function ingestReferences(jobId: string, urls: string[]): Promise<string[]> {
  return Promise.all(
    urls.slice(0, 2).map(async (url, index) => {
      if (!isTwilioMediaUrl(url)) throw new Error("Untrusted Twilio media URL");

      const keyBase = `references/twilio/${jobId}/${index}`;
      for (const extension of ["png", "jpg"]) {
        const key = `${keyBase}.${extension}`;
        if (await blobExists(key)) return getBlobPublicUrl(key);
      }

      const { buffer, contentType } = await downloadTwilioMedia(url);
      const isPng = contentType.toLowerCase().startsWith("image/png");
      const image = isPng ? buffer : await sharp(buffer).rotate().jpeg({ quality: 90 }).toBuffer();
      return uploadBufferToBlob(
        image,
        `${keyBase}.${extensionFor(isPng ? "image/png" : "image/jpeg")}`,
        isPng ? "image/png" : "image/jpeg",
      );
    }),
  );
}

function failureMessage(error: unknown): string {
  if (error instanceof ComicServiceError) {
    if (error.type === "content_policy") {
      return "That idea couldn't be illustrated. Tell me what to change, or send NEW for a new story.";
    }
    if (error.type === "credit_limit") {
      return "Our comic studio is temporarily unavailable. Please try again later.";
    }
  }
  return "Sorry, we couldn't create your comic this time. Tell me what to change or send NEW.";
}

function isPermanent(error: unknown, attempts: number): boolean {
  if (attempts >= 3) return true;
  return error instanceof ComicServiceError
    ? error.type === "content_policy" ||
        error.type === "credit_limit" ||
        [403, 404, 409].includes(error.status || 0)
    : false;
}

function isMediaSubmissionError(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
  return ["11751", "21620", "21621", "21622", "63019", "63021"].includes(code);
}

export async function processGenerationJob(jobId: string): Promise<void> {
  // Even replicas sharing WORKER_ID need a distinct owner for each claim.
  const workerId = `${process.env.WORKER_ID || "generation"}:${crypto.randomUUID()}`;
  const claimed = await claimGenerationJob(jobId, workerId, 20 * 60);
  if (!claimed) {
    const existing = await getGenerationJob(jobId);
    if (!existing) return;
    if (existing.status === "succeeded" && existing.storyId) {
      await logGenerationSuccess(existing, existing.storyId, existing.deliverySid || "");
      try {
        await completeConversationForGeneration(existing, existing.storyId);
      } catch (error) {
        console.error("Failed to reconcile completed conversation", error);
      }
      return;
    }
    if (["failed", "quota_rejected", "processing"].includes(existing.status)) {
      return;
    }
    throw new Error("Generation job is already being processed");
  }

  await logGenerationEvent(
    claimed,
    "generation.started",
    `attempt:${claimed.attemptCount}:started`,
    "processing",
    {
      queueWaitMs: elapsedMs(claimed.queuedAt),
      totalElapsedMs: elapsedMs(claimed.createdAt),
    },
  );

  let acceptedDeliverySid: string | null = claimed.deliverySid;
  try {
    // A prior worker may have sent the result and then failed to checkpoint
    // quota or the terminal job state. Its accepted Message SID is enough to
    // finish this claim without depending on the original Twilio media,
    // OpenAI, or Blob storage still being available.
    if (claimed.deliverySid && claimed.storyId && claimed.imageUrl) {
      await consumeFreeTierQuota(claimed.quotaClaimKey);
      await markGenerationJobSucceeded(claimed.id, workerId, {
        storyId: claimed.storyId,
        imageUrl: claimed.imageUrl,
        deliverySid: claimed.deliverySid,
      });
      await logGenerationSuccess(claimed, claimed.storyId, claimed.deliverySid);
      try {
        await completeConversationForGeneration(claimed, claimed.storyId);
      } catch (error) {
        console.error("Failed to update completed conversation", error);
      }
      return;
    }

    if (resultDeliveryExpired(claimed)) {
      await suppressExpiredResult(claimed, workerId);
      return;
    }

    const publicBaseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
    if (!publicBaseUrl) throw new Error("PUBLIC_BASE_URL is not configured");
    const characterImageUrls = await ingestReferences(
      claimed.id,
      claimed.characterImageUrls,
    );
    if (resultDeliveryExpired(claimed)) {
      await suppressExpiredResult(claimed, workerId);
      return;
    }
    const imageKey = claimed.targetStoryId
      ? `stories/${claimed.targetStoryId}/page-${claimed.id}.png`
      : `stories/${claimed.id}/page-1.png`;
    const result = claimed.targetStoryId
      ? await createComicContinuationPage({
          userId: claimed.userId,
          storyId: claimed.targetStoryId,
          pageId: claimed.id,
          prompt: claimed.prompt,
          characterImageUrls,
          imageKey,
        })
      : await createComicStory({
          userId: claimed.userId,
          prompt: claimed.prompt,
          style: claimed.style,
          characterImageUrls,
          source: claimed.source as "sms" | "whatsapp" | "voice",
          storyId: claimed.id,
          pageId: claimed.id,
          imageKey,
          preserveOnFailure: true,
        });

    if (resultDeliveryExpired(claimed)) {
      await checkpointGenerationOutput(claimed.id, workerId, {
        storyId: result.story.id,
        imageUrl: result.imageUrl,
        deliveryHadMedia: false,
      });
      await suppressExpiredResult(claimed, workerId, result.story.id);
      return;
    }

    const link = `${publicBaseUrl}/story/${result.story.slug}`;
    const body = claimed.targetStoryId
      ? `Page ${result.page.pageNumber} of "${result.story.title}" is ready! View it here: ${link}`
      : `Your comic "${result.story.title}" is ready! View it here: ${link}`;
    const statusCallback = `${publicBaseUrl}/api/twilio/status?jobId=${encodeURIComponent(claimed.id)}#rc=3&rp=5xx,ct,rt`;
    const current = await getGenerationJob(claimed.id);
    let deliverySid = current?.deliverySid || claimed.deliverySid;
    let deliveryHadMedia = current?.deliveryHadMedia || claimed.deliveryHadMedia || false;
    acceptedDeliverySid = deliverySid;
    if (!deliverySid) {
      let mediaUrl: string | undefined;
      try {
        mediaUrl = await createMmsPreview(
          imageKey,
          imageKey.replace(/\.png$/, "-mms.jpg"),
        );
      } catch (error) {
        console.error("MMS preview failed; sending story link", error);
      }
      await checkpointGenerationOutput(claimed.id, workerId, {
        storyId: result.story.id,
        imageUrl: result.imageUrl,
        deliveryHadMedia: Boolean(mediaUrl),
      });
      deliveryHadMedia = Boolean(mediaUrl);
      const validityPeriod = resultDeliveryValiditySeconds(claimed);
      if (validityPeriod === null) {
        await suppressExpiredResult(claimed, workerId, result.story.id);
        return;
      }
      const channel = (claimed.source === "voice" ? "sms" : claimed.source) as TwilioMessageChannel;
      const message = {
        channel,
        to: claimed.recipientAddress,
        from: claimed.senderAddress,
        body,
        statusCallback,
        ...(channel === "sms" ? { validityPeriod } : {}),
      };
      try {
        deliverySid = await sendChannelMessage({ ...message, mediaUrl });
      } catch (error) {
        if (!mediaUrl || !isMediaSubmissionError(error)) throw error;
        console.warn("Twilio rejected comic media; sending story link", error);
        await checkpointGenerationOutput(claimed.id, workerId, {
          storyId: result.story.id,
          imageUrl: result.imageUrl,
          deliveryHadMedia: false,
        });
        deliveryHadMedia = false;
        const retryValidityPeriod = resultDeliveryValiditySeconds(claimed);
        if (retryValidityPeriod === null) {
          await suppressExpiredResult(claimed, workerId, result.story.id);
          return;
        }
        deliverySid = await sendChannelMessage({
          ...message,
          ...(channel === "sms" ? { validityPeriod: retryValidityPeriod } : {}),
        });
      }
      acceptedDeliverySid = deliverySid;
    }

    await logGenerationEvent(
      claimed,
      "generation.delivery",
      `delivery:${deliverySid}`,
      "accepted",
      { hadMedia: deliveryHadMedia, fallback: false },
      { storyId: result.story.id, messageSid: deliverySid, content: body },
    );

    await checkpointGenerationDelivery(claimed.id, workerId, {
      storyId: result.story.id,
      imageUrl: result.imageUrl,
      deliverySid,
    });
    await consumeFreeTierQuota(claimed.quotaClaimKey);
    await markGenerationJobSucceeded(claimed.id, workerId, {
      storyId: result.story.id,
      imageUrl: result.imageUrl,
      deliverySid,
    });
    await logGenerationSuccess(claimed, result.story.id, deliverySid);

    try {
      await completeConversationForGeneration(claimed, result.story.id);
    } catch (error) {
      console.error("Failed to update completed conversation", error);
    }
  } catch (error) {
    if (error instanceof GenerationJobLeaseLostError) {
      // A newer queue delivery owns the job or it already finished. Only
      // that owner may change state, release quota, or notify the caller.
      return;
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    if (acceptedDeliverySid) {
      // Twilio accepted the result. Retrying DB/quota checkpoints must never
      // release the reservation or send a false generation-failed message.
      try {
        await returnGenerationJobToQueue(claimed.id, workerId, message);
        await logGenerationEvent(
          claimed,
          "generation.retry",
          `attempt:${claimed.attemptCount}:retry`,
          "queued",
          { ...errorDetails(error), acceptedDeliverySid },
        );
      } catch (checkpointError) {
        if (checkpointError instanceof GenerationJobLeaseLostError) return;
        console.error("Failed to requeue an accepted delivery", checkpointError);
      }
      throw error;
    }
    const expired = resultDeliveryExpired(claimed);
    if (!expired && !isPermanent(error, claimed.attemptCount)) {
      try {
        await returnGenerationJobToQueue(claimed.id, workerId, message);
        await logGenerationEvent(
          claimed,
          "generation.retry",
          `attempt:${claimed.attemptCount}:retry`,
          "queued",
          errorDetails(error),
        );
      } catch (checkpointError) {
        if (checkpointError instanceof GenerationJobLeaseLostError) return;
        throw checkpointError;
      }
      throw error;
    }

    try {
      await markGenerationJobFailed(
        claimed.id,
        workerId,
        expired ? EXPIRED_DELIVERY_REASON : message,
      );
      await logGenerationEvent(claimed, "generation.failed", "failed", "failed", {
        ...errorDetails(error),
        ...(expired ? { reason: "delivery_window_expired" } : {}),
        totalDurationMs: elapsedMs(claimed.createdAt),
        processingMs: elapsedMs(claimed.updatedAt),
      });
      if (expired) {
        await logGenerationEvent(claimed, "generation.delivery", "delivery:expired", "suppressed", {
          reason: "delivery_window_expired",
          ageMs: elapsedMs(claimed.createdAt),
        });
      }
    } catch (checkpointError) {
      if (checkpointError instanceof GenerationJobLeaseLostError) return;
      throw checkpointError;
    }
    if (claimed.targetStoryId) {
      try {
        await cleanupFailedContinuationPage({
          userId: claimed.userId,
          storyId: claimed.targetStoryId,
          pageId: claimed.id,
        });
      } catch (cleanupError) {
        console.error("Failed to remove unfinished continuation page", cleanupError);
      }
    }
    if (expired) return;
    try {
      const validityPeriod = resultDeliveryValiditySeconds(claimed);
      if (validityPeriod === null) {
        await logGenerationEvent(claimed, "generation.delivery", "delivery:expired", "suppressed", {
          reason: "delivery_window_expired",
          ageMs: elapsedMs(claimed.createdAt),
          purpose: "generation_failure_notice",
        });
        return;
      }
      const failureBody = failureMessage(error);
      const channel = (claimed.source === "voice" ? "sms" : claimed.source) as TwilioMessageChannel;
      const callbackBaseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
      const failureSid = await sendChannelMessage({
        channel,
        to: claimed.recipientAddress,
        from: claimed.senderAddress,
        body: failureBody,
        ...(channel === "sms" ? { validityPeriod } : {}),
        ...(callbackBaseUrl ? {
          statusCallback: `${callbackBaseUrl}/api/twilio/status?jobId=${encodeURIComponent(claimed.id)}&failure=1#rc=3&rp=5xx,ct,rt`,
        } : {}),
      });
      await recordActivityEvent({
        eventKey: `message:${failureSid}:outbound`,
        userId: claimed.userId,
        channel,
        kind: "message.outbound",
        direction: "outbound",
        address: claimed.recipientAddress,
        messageSid: failureSid,
        jobId: claimed.id,
        content: failureBody,
        status: "accepted",
        details: { source: claimed.source, purpose: "generation_failure_notice", attemptCount: claimed.attemptCount },
      });
    } catch (notificationError) {
      console.error("Failed to send generation failure notification", notificationError);
    }
    try {
      await failConversationForGeneration(claimed);
    } catch (conversationError) {
      console.error("Failed to restore draft after generation failure", conversationError);
    }
  }
}
