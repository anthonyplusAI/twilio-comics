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
      try {
        await completeConversationForGeneration(claimed, claimed.storyId);
      } catch (error) {
        console.error("Failed to update completed conversation", error);
      }
      return;
    }

    const publicBaseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
    if (!publicBaseUrl) throw new Error("PUBLIC_BASE_URL is not configured");
    const characterImageUrls = await ingestReferences(
      claimed.id,
      claimed.characterImageUrls,
    );
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

    const link = `${publicBaseUrl}/story/${result.story.slug}`;
    const body = claimed.targetStoryId
      ? `Page ${result.page.pageNumber} of "${result.story.title}" is ready! View it here: ${link}`
      : `Your comic "${result.story.title}" is ready! View it here: ${link}`;
    const statusCallback = `${publicBaseUrl}/api/twilio/status?jobId=${encodeURIComponent(claimed.id)}#rc=3&rp=5xx,ct,rt`;
    const current = await getGenerationJob(claimed.id);
    let deliverySid = current?.deliverySid || claimed.deliverySid;
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
      const message = {
        channel: (claimed.source === "voice" ? "sms" : claimed.source) as TwilioMessageChannel,
        to: claimed.recipientAddress,
        from: claimed.senderAddress,
        body,
        statusCallback,
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
        deliverySid = await sendChannelMessage(message);
      }
      acceptedDeliverySid = deliverySid;
    }

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
      } catch (checkpointError) {
        if (checkpointError instanceof GenerationJobLeaseLostError) return;
        console.error("Failed to requeue an accepted delivery", checkpointError);
      }
      throw error;
    }
    if (!isPermanent(error, claimed.attemptCount)) {
      try {
        await returnGenerationJobToQueue(claimed.id, workerId, message);
      } catch (checkpointError) {
        if (checkpointError instanceof GenerationJobLeaseLostError) return;
        throw checkpointError;
      }
      throw error;
    }

    try {
      await markGenerationJobFailed(claimed.id, workerId, message);
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
    try {
      await sendChannelMessage({
        channel: (claimed.source === "voice" ? "sms" : claimed.source) as TwilioMessageChannel,
        to: claimed.recipientAddress,
        from: claimed.senderAddress,
        body: failureMessage(error),
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
