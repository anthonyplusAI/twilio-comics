import { recordActivityEvent } from "@/lib/activity-events";
import { blobExists, getBlobPublicUrl, uploadBufferToBlob } from "@/lib/blob-storage";
import {
  cleanupFailedContinuationPage,
  createComicContinuationPage,
  createComicStory,
  ComicServiceError,
} from "@/lib/comic-service";
import { CONVERSATION_RESUME_DAYS } from "@/lib/conversation-policy";
import {
  GenerationJobLeaseLostError,
  checkpointGenerationDelivery,
  checkpointGenerationOutput,
  claimGenerationJob,
  getGenerationJob,
  markGenerationJobFailed,
  markGenerationJobSuppressed,
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
  deleteBlankFailedGenerationStory,
  expireConversationForGeneration,
  failConversationForGeneration,
} from "@/lib/db-actions";
import { createMmsPreview } from "@/lib/mms-preview";
import { comicDeliveryUrl } from "@/lib/dub-short-links";
import sharp from "sharp";
import type { GenerationJob } from "@/lib/schema";

const RESULT_DELIVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TWILIO_VALIDITY_SAFETY_SECONDS = 10;
const MIN_TWILIO_VALIDITY_SECONDS = 6;
const FAILED_RECONCILIATION_GRACE_MS = 60_000;
const EXPIRED_DELIVERY_REASON = "Result delivery expired after 24 hours";
const EXPIRED_POLICY_REJECTION_REASON = "Result delivery expired after 24 hours (policy rejection)";
const OPTED_OUT_DELIVERY_REASON = "recipient_opted_out";
const POLICY_REJECTION_REASON = "Image service policy rejection";

class TerminalConversationReconciliationError extends Error {}

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
  const rawCode = error && typeof error === "object" && "code" in error
    ? (error as { code: unknown }).code : undefined;
  const code = typeof rawCode === "string" || typeof rawCode === "number"
    ? String(rawCode) : "";
  const moderation = error instanceof ComicServiceError ? error.moderationDetails : undefined;
  return {
    errorType: error instanceof ComicServiceError
      ? error.type : error instanceof Error ? error.name : "unknown",
    httpStatus: error instanceof ComicServiceError ? error.status || null : null,
    errorCode: /^[A-Za-z0-9_-]{1,32}$/.test(code) ? code : null,
    ...(moderation ? {
      moderationStage: moderation.stage || null,
      moderationCategories: moderation.categories,
    } : {}),
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

async function cleanupFailedEmptyOutput(job: GenerationJob): Promise<void> {
  try {
    if (job.targetStoryId) {
      await cleanupFailedContinuationPage({
        userId: job.userId,
        storyId: job.targetStoryId,
        pageId: job.id,
      });
    } else {
      await deleteBlankFailedGenerationStory({ jobId: job.id, userId: job.userId });
    }
  } catch (error) {
    console.error("Failed to remove unfinished comic after terminal generation failure", {
      jobId: job.id,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

async function suppressExpiredResult(
  job: GenerationJob,
  workerId: string,
  storyId: string | null = job.storyId,
): Promise<void> {
  // A late result is never sent to a number that may now belong to someone
  // else. Its saved story still counts as a generated comic.
  if (storyId) {
    await markGenerationJobSuppressed(job.id, workerId, EXPIRED_DELIVERY_REASON, storyId);
  } else {
    await markGenerationJobFailed(job.id, workerId, EXPIRED_DELIVERY_REASON);
    await cleanupFailedEmptyOutput(job);
  }
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
  await clearExpiredConversation(job);
}

/** Twilio 21610 means further texts to this recipient are blocked until opt-in. */
function isTwilioOptOut(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, status } = error as { code?: unknown; status?: unknown };
  return String(code) === "21610" && Number(status) === 400;
}

async function suppressOptedOutResult(
  job: GenerationJob,
  workerId: string,
  storyId: string | null,
): Promise<void> {
  // A saved story and page count against both the weekly and daily limits,
  // even when Twilio blocks the outbound result after generation.
  if (storyId) {
    await markGenerationJobSuppressed(job.id, workerId, OPTED_OUT_DELIVERY_REASON, storyId);
  } else {
    await markGenerationJobFailed(job.id, workerId, OPTED_OUT_DELIVERY_REASON);
  }
  await logGenerationEvent(job, "generation.delivery", "delivery:opted-out", "suppressed", {
    reason: OPTED_OUT_DELIVERY_REASON,
    errorCode: "21610",
    resultGenerated: Boolean(storyId),
  }, { storyId });
  await logGenerationEvent(job, "generation.failed", "failed", "failed", {
    reason: OPTED_OUT_DELIVERY_REASON,
    resultGenerated: Boolean(storyId),
    totalDurationMs: elapsedMs(job.createdAt),
  }, { storyId });
  if (resultDeliveryExpired(job)) {
    await clearExpiredConversation(job);
  } else if (storyId) {
    await completeSavedStoryConversation(job, storyId);
  } else {
    await restoreFailedDraft(job);
  }
}

function extensionFor(contentType: string): string {
  return contentType.includes("png") ? "png" : "jpg";
}

const SAFE_CAMERA_OWNER = /^[A-Za-z0-9_-]{1,128}$/;
const CAMERA_JPEG_NAME = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.jpg$/;

function ownedCameraBlobKey(reference: string, userId: string): string | null {
  if (!SAFE_CAMERA_OWNER.test(userId)) return null;
  const prefix = `blob:uploads/${userId}/camera/`;
  if (!reference.startsWith(prefix)) return null;
  const filename = reference.slice(prefix.length);
  return CAMERA_JPEG_NAME.test(filename) ? reference.slice("blob:".length) : null;
}

async function ingestReferences(
  job: Pick<GenerationJob, "id" | "userId">,
  urls: string[],
): Promise<string[]> {
  return Promise.all(
    urls.slice(0, 2).map(async (url, index) => {
      if (typeof url !== "string") throw new Error("Untrusted image reference");
      if (url.startsWith("blob:")) {
        const key = ownedCameraBlobKey(url, job.userId);
        if (!key) throw new Error("Untrusted camera reference");
        if (!(await blobExists(key))) throw new Error("Camera photo is no longer available");
        return getBlobPublicUrl(key);
      }
      if (!isTwilioMediaUrl(url)) throw new Error("Untrusted Twilio media URL");

      const keyBase = `references/twilio/${job.id}/${index}`;
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

function policyRevisionHint(error: ComicServiceError): string {
  const details = error.moderationDetails;
  if (details?.stage === "output") return "Try a different scene.";
  const categories = details?.categories || [];
  if (categories.some((category) => category.startsWith("sexual"))) {
    return "Try a non-explicit scene.";
  }
  if (categories.some((category) => category.startsWith("self-harm"))) {
    return "Try a scene without self-harm.";
  }
  if (categories.some((category) =>
    category.startsWith("harassment") || category.startsWith("hate"))) {
    return "Remove abusive or targeting language.";
  }
  if (categories.some((category) => category.startsWith("violence"))) {
    return "Try a less violent, non-graphic scene.";
  }
  if (categories.some((category) => category.startsWith("illicit"))) {
    return "Avoid how-to details.";
  }
  if (details?.stage === "input") {
    return "Try a simpler scene.";
  }
  return "It gave no detail. Try a simpler scene.";
}

function failureMessage(error: unknown, source: string, hasPhotos: boolean): string {
  if (error instanceof ComicServiceError) {
    if (error.type === "content_policy") {
      const reason = error.moderationDetails?.stage === "output"
        ? "The generated image was blocked by a safety check."
        : error.code === "moderation_blocked"
          ? "The image service blocked this comic for safety."
          : "The image service declined this request.";
      const recovery = source === "voice"
        ? "Call again, verify, and tell me what to change or say NEW."
        : hasPhotos
          ? "Reply with a change, or NEW to resend photos and idea."
          : "Reply with a change or NEW.";
      return `${reason} ${policyRevisionHint(error)}\n\n${recovery}`;
    }
    if (error.type === "credit_limit") {
      const recovery = source === "voice"
        ? "Call again, verify, and say create it to retry or say NEW."
        : "Reply CREATE later to retry, or NEW for a new comic.";
      return `The image service is temporarily unavailable. Your idea is saved.\n\n${recovery}`;
    }
  }
  const recovery = source === "voice"
    ? "Call again, verify, and say create it to retry or say NEW."
    : "Reply CREATE later to retry, or NEW for a new comic.";
  return `A technical issue stopped your comic. Your idea is saved.\n\n${recovery}`;
}

function recoveredFailureMessage(source: string): string {
  const recovery = source === "voice"
    ? "Call again, verify, and revise your idea or say create it to retry."
    : "Reply with a change or CREATE to retry; NEW starts a new comic.";
  return `We couldn't finish your comic. Your idea is saved.\n\n${recovery}`;
}

function recoveredPolicyFailureMessage(source: string, hasPhotos: boolean): string {
  const recovery = source === "voice"
    ? "Call again, verify, and tell me what to change or say NEW."
    : hasPhotos
      ? "Reply with a change, or NEW to resend photos and idea."
      : "Reply with a change or NEW.";
  return `The image service declined this comic. Your idea is saved for revision.\n\n${recovery}`;
}

async function restoreFailedDraft(job: GenerationJob, requireRevision = false): Promise<boolean> {
  try {
    const restored = requireRevision
      ? await failConversationForGeneration(job, { requireRevision: true })
      : await failConversationForGeneration(job);
    if (!restored) {
      console.warn("No matching draft to restore after generation failure", { jobId: job.id });
    }
    return restored;
  } catch (error) {
    console.error("Failed to restore draft after generation failure", {
      jobId: job.id,
      error: error instanceof Error ? error.name : "unknown",
    });
    // The job is already terminal. Keep the queue message for a later
    // reconciliation attempt instead of leaving the draft stuck generating.
    throw new TerminalConversationReconciliationError("Failed to restore comic draft after terminal failure");
  }
}

async function completeSavedStoryConversation(job: GenerationJob, storyId: string): Promise<boolean> {
  try {
    return await completeConversationForGeneration(job, storyId);
  } catch (error) {
    console.error("Failed to complete saved comic conversation", {
      jobId: job.id,
      error: error instanceof Error ? error.name : "unknown",
    });
    throw new TerminalConversationReconciliationError("Failed to complete comic conversation after terminal failure");
  }
}

async function clearExpiredConversation(job: GenerationJob): Promise<boolean> {
  try {
    return await expireConversationForGeneration(job);
  } catch (error) {
    console.error("Failed to clear expired comic conversation", {
      jobId: job.id,
      error: error instanceof Error ? error.name : "unknown",
    });
    throw new TerminalConversationReconciliationError("Failed to clear expired comic conversation");
  }
}

async function notifyGenerationFailure(job: GenerationJob, failureBody: string): Promise<void> {
  try {
    const validityPeriod = resultDeliveryValiditySeconds(job);
    if (validityPeriod === null) {
      await logGenerationEvent(job, "generation.delivery", "delivery:expired", "suppressed", {
        reason: "delivery_window_expired",
        ageMs: elapsedMs(job.createdAt),
        purpose: "generation_failure_notice",
      });
      return;
    }
    const channel = (job.source === "voice" ? "sms" : job.source) as TwilioMessageChannel;
    const callbackBaseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
    const failureSid = await sendChannelMessage({
      channel,
      to: job.recipientAddress,
      from: job.senderAddress,
      body: failureBody,
      ...(channel === "sms" ? { validityPeriod } : {}),
      ...(callbackBaseUrl ? {
        statusCallback: `${callbackBaseUrl}/api/twilio/status?jobId=${encodeURIComponent(job.id)}&failure=1#rc=3&rp=5xx,ct,rt`,
      } : {}),
    });
    await recordActivityEvent({
      eventKey: `message:${failureSid}:outbound`,
      userId: job.userId,
      channel,
      kind: "message.outbound",
      direction: "outbound",
      address: job.recipientAddress,
      messageSid: failureSid,
      jobId: job.id,
      content: failureBody,
      status: "accepted",
      details: { source: job.source, purpose: "generation_failure_notice", attemptCount: job.attemptCount },
    });
  } catch (error) {
    console.error("Failed to send generation failure notification", {
      jobId: job.id,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
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
    if (existing.status === "failed") {
      // The previous worker may have failed to restore the submitted draft
      // after marking its job terminal. Only the matching generating draft
      // can be restored, so duplicate queue deliveries cannot notify twice.
      const failedForMs = elapsedMs(existing.completedAt);
      if (failedForMs !== null && failedForMs < FAILED_RECONCILIATION_GRACE_MS) {
        // A separate queue delivery may race the worker that just marked the
        // job failed. Keep it retryable while that worker cleans up output.
        throw new Error("Terminal comic failure is still reconciling");
      }
      const expired = existing.lastError === EXPIRED_DELIVERY_REASON ||
        existing.lastError === EXPIRED_POLICY_REJECTION_REASON || resultDeliveryExpired(existing);
      if (expired) {
        await clearExpiredConversation(existing);
        return;
      }
      if (existing.storyId) {
        await completeSavedStoryConversation(existing, existing.storyId);
        return;
      }
      const policyRejected = existing.lastError === POLICY_REJECTION_REASON;
      const restored = await restoreFailedDraft(existing, policyRejected);
      if (restored && existing.lastError !== OPTED_OUT_DELIVERY_REASON) {
        await notifyGenerationFailure(existing, policyRejected
          ? recoveredPolicyFailureMessage(existing.source, existing.characterImageUrls.length > 0)
          : recoveredFailureMessage(existing.source));
      }
      return;
    }
    if (["admitting", "quota_rejected", "processing"].includes(existing.status)) {
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
  let generatedStoryId: string | null = claimed.storyId;
  let deliveryAttempted = false;
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
    const characterImageUrls = await ingestReferences(claimed, claimed.characterImageUrls);
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
    generatedStoryId = result.story.id;

    if (resultDeliveryExpired(claimed)) {
      await checkpointGenerationOutput(claimed.id, workerId, {
        storyId: result.story.id,
        imageUrl: result.imageUrl,
        deliveryHadMedia: false,
      });
      await suppressExpiredResult(claimed, workerId, result.story.id);
      return;
    }

    const canonicalUrl = `${publicBaseUrl}/story/${result.story.slug}`;
    const link = await comicDeliveryUrl(result.story.id, result.story.slug, canonicalUrl);
    const readyMessage = claimed.targetStoryId
      ? `Page ${result.page.pageNumber} is ready:\n${link}`
      : `Your comic is ready:\n${link}`;
    const continuationInstruction = claimed.source === "voice"
      ? `Call again from this number within ${CONVERSATION_RESUME_DAYS} days; say CONTINUE for another page or NEW for a new comic.`
      : `Reply CONTINUE within ${CONVERSATION_RESUME_DAYS} days for another page, or NEW for a new comic.`;
    const body = `${readyMessage}\n\n${continuationInstruction}`;
    const statusCallback = `${publicBaseUrl}/api/twilio/status?jobId=${encodeURIComponent(claimed.id)}#rc=3&rp=5xx,ct,rt`;
    const current = await getGenerationJob(claimed.id);
    let deliverySid = current?.deliverySid || claimed.deliverySid;
    let deliveryHadMedia = current?.deliveryHadMedia || claimed.deliveryHadMedia || false;
    acceptedDeliverySid = deliverySid;
    if (!deliverySid) {
      let mediaUrl: string | undefined;
      if (process.env.RESULT_MEDIA_PREVIEW_ENABLED === "true") {
        try {
          mediaUrl = await createMmsPreview(
            imageKey,
            imageKey.replace(/\.png$/, "-mms.jpg"),
          );
        } catch (error) {
          console.error("MMS preview failed; sending story link", error);
        }
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
        deliveryAttempted = true;
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
    if (error instanceof TerminalConversationReconciliationError) {
      // A failed job cannot be claimed again, but its queue redelivery can
      // repair the matching conversation without regenerating or texting.
      throw error;
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
    if (deliveryAttempted && isTwilioOptOut(error)) {
      try {
        await suppressOptedOutResult(claimed, workerId, generatedStoryId);
      } catch (checkpointError) {
        if (checkpointError instanceof GenerationJobLeaseLostError) return;
        throw checkpointError;
      }
      return;
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
      const policyRejected = !generatedStoryId && error instanceof ComicServiceError &&
        error.type === "content_policy";
      const terminalReason = expired
        ? policyRejected ? EXPIRED_POLICY_REJECTION_REASON : EXPIRED_DELIVERY_REASON
        : policyRejected ? POLICY_REJECTION_REASON : message;
      if (generatedStoryId) {
        await markGenerationJobSuppressed(claimed.id, workerId, terminalReason, generatedStoryId);
      } else {
        await markGenerationJobFailed(claimed.id, workerId, terminalReason);
      }
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
    if (!generatedStoryId && !claimed.storyId) {
      await cleanupFailedEmptyOutput(claimed);
    }
    if (expired || resultDeliveryExpired(claimed)) {
      await clearExpiredConversation(claimed);
      return;
    }
    if (generatedStoryId) {
      const completed = await completeSavedStoryConversation(claimed, generatedStoryId);
      // A newer draft may have replaced this submission while delivery was
      // failing. Do not invite the current owner to retrieve that older job.
      if (!completed) return;
    }
    // Restore before inviting CREATE or a revision. While still generating,
    // inbound messages would only get a "still creating" reply. A false
    // result means the original draft no longer matches this failed job.
    if (!generatedStoryId) {
      const policyRejected = error instanceof ComicServiceError && error.type === "content_policy";
      const restored = await restoreFailedDraft(claimed, policyRejected);
      if (!restored) return;
    }
    const failureBody = generatedStoryId
      ? "Your comic was created, but I couldn't deliver the link.\n\nReply STATUS to get it."
      : failureMessage(error, claimed.source, claimed.characterImageUrls.length > 0);
    await notifyGenerationFailure(claimed, failureBody);
  }
}
