import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { photoRequestHasAllowedOrigin } from "@/lib/browser-photo-session";
import {
  updatePage,
  createPage,
  getNextPageNumber,
  getStoryById,
  getLastPageImage,
  deletePage,
} from "@/lib/db-actions";
import { uploadBufferToBlob } from "@/lib/blob-storage";
import {
  consumeFreeTierQuota,
  releaseFreeTierQuota,
} from "@/lib/quota";
import {
  chooseGenerationApiKey,
} from "@/lib/generation-capacity";
import { buildComicPrompt } from "@/lib/prompt";
import { generateComicImage } from "@/lib/image-generation";
import {
  isContentPolicyViolation,
  getContentPolicyErrorMessage,
} from "@/lib/utils";
import { createComicStory, ComicServiceError } from "@/lib/comic-service";
import { generateComicRequestSchema } from "@/lib/browser-generation-request";
import {
  markStudioAppGenerationPaidStarted,
  reserveStudioAppGenerationCapacity,
} from "@/lib/studio-guest-capacity";
import { readBoundedStudioJson } from "@/lib/studio-guest-json";
import { getStudioActor, guestOwnsReferenceImages } from "@/lib/studio-guest-session";

const PHOTO_REQUIRED_MESSAGE = "Add at least one reference photo before generating your comic.";

export async function POST(request: NextRequest) {
  let quotaClaimKey: string | null = null;
  let providerStarted = false;
  async function markProviderStarted(): Promise<void> {
    if (!quotaClaimKey || providerStarted) return;
    await markStudioAppGenerationPaidStarted(quotaClaimKey);
    providerStarted = true;
  }

  async function settlePendingQuota(): Promise<void> {
    const claimKey = quotaClaimKey;
    if (!claimKey) return;
    if (providerStarted) {
      // The persisted paid-start marker keeps the rolling charge even when a
      // status write fails; an image-policy error must never refund this call.
      quotaClaimKey = null;
      try {
        await consumeFreeTierQuota(claimKey);
      } catch (error) {
        console.error("Failed to mark paid comic generation consumed:", error);
      }
    } else {
      await releaseFreeTierQuota(claimKey);
      quotaClaimKey = null;
    }
  }

  try {
    const actor = await getStudioActor(request);
    if (!actor) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }
    if (actor.kind === "guest" && !photoRequestHasAllowedOrigin(request)) {
      return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
    }
    const userId = actor.userId;
    const studioActor = actor;

    const json = await readBoundedStudioJson(request);
    if (!json.ok) return NextResponse.json({ error: json.error }, { status: json.status });
    const body = json.value;
    const parsed = generateComicRequestSchema.safeParse(body);
    if (!parsed.success) {
      const fields = body && typeof body === "object" && !Array.isArray(body)
        ? body as Record<string, unknown>
        : null;
      const error = fields && !fields.prompt ? "Missing required fields" : "Invalid comic request";
      return NextResponse.json({ error }, { status: 400 });
    }

    const {
      storyId,
      prompt,
      apiKey,
      style,
      characterImages,
      isContinuation,
      previousContext,
    } = parsed.data;

    if (!storyId && characterImages.length === 0) {
      return NextResponse.json({ error: PHOTO_REQUIRED_MESSAGE }, { status: 400 });
    }
    if (actor.kind === "guest" && apiKey !== undefined) {
      return NextResponse.json({ error: "Browser Studio uses the app's OpenAI key" }, { status: 400 });
    }
    if (actor.kind === "guest" && !guestOwnsReferenceImages(userId, characterImages)) {
      return NextResponse.json({ error: "Reference photos must belong to this browser session" }, { status: 403 });
    }

    const keyChoice = chooseGenerationApiKey(
      actor.kind === "guest" ? undefined : apiKey,
      process.env.OPENAI_API_KEY,
    );
    if (!keyChoice.valid) {
      return NextResponse.json(
        { error: keyChoice.reason === "missing"
          ? "Server configuration error - OpenAI API key not available"
          : "Invalid OpenAI API key" },
        { status: keyChoice.reason === "missing" ? 500 : 400 },
      );
    }
    const openAIApiKey = keyChoice.apiKey;

    async function reserveGeneration(): Promise<NextResponse | null> {
      if (!keyChoice.valid || !keyChoice.appFunded) return null;
      const claimKey = `web-generation:${userId}:${randomUUID()}`;
      const admission = await reserveStudioAppGenerationCapacity(studioActor, claimKey, request);
      if (admission.reason === "accepted") {
        quotaClaimKey = claimKey;
        return null;
      }
      if (admission.reason === "busy") {
        return NextResponse.json({
          error: admission.scope === "user"
            ? "Your comic is still being drawn. Wait for it to finish before making another."
            : "Browser Studio is busy right now. Please try again shortly.",
          errorType: "generation_busy",
          isRateLimited: true,
        }, { status: 429 });
      }
      if (admission.reason === "rate_limit") {
        return NextResponse.json({
          error: admission.message,
          errorType: "generation_rate_limit",
          isRateLimited: true,
        }, { status: 429 });
      }
      if (admission.reason === "unavailable") {
        return NextResponse.json({ error: "Browser Studio is temporarily unavailable" }, { status: 503 });
      }
      return NextResponse.json({ error: "Browser Studio is temporarily unavailable" }, { status: 503 });
    }

    // New-story path: delegate to channel-agnostic service and return early.
    // The continuation path (storyId present) falls through to the existing logic below.
    if (!storyId) {
      const admissionError = await reserveGeneration();
      if (admissionError) return admissionError;
      try {
        const result = await createComicStory({
          userId,
          prompt,
          apiKey: openAIApiKey,
          style,
          characterImageUrls: characterImages,
          source: "web",
          generateTitle: true,
          usesOwnApiKey: !keyChoice.appFunded,
          beforeProviderCall: keyChoice.appFunded ? markProviderStarted : undefined,
        });
        await settlePendingQuota();
        return NextResponse.json({
          imageUrl: result.imageUrl,
          storyId: result.story.id,
          storySlug: result.story.slug,
          pageId: result.page.id,
          pageNumber: result.page.pageNumber,
          title: result.story.title,
          description: result.story.description,
        });
      } catch (error) {
        await settlePendingQuota();
        if (error instanceof ComicServiceError) {
          if (error.type === "missing_reference") {
            return NextResponse.json(
              { error: PHOTO_REQUIRED_MESSAGE, errorType: "missing_reference" },
              { status: 400 },
            );
          }
          if (error.type === "content_policy") {
            return NextResponse.json(
              { error: getContentPolicyErrorMessage(), errorType: "content_policy" },
              { status: 400 },
            );
          }
          if (error.type === "credit_limit") {
            return NextResponse.json(
              {
                error:
                  "Insufficient API credits. Please add credits to your OpenAI account at https://platform.openai.com/account/billing or update your API key.",
                errorType: "credit_limit",
              },
              { status: 402 },
            );
          }
          return NextResponse.json(
            { error: error.message || "Failed to generate image", errorType: "api_error" },
            { status: error.status || 500 },
          );
        }
        throw error;
      }
    }

    const referenceImages: string[] = [];

    // Continuation: get previous page image and story character images.
    const story = await getStoryById(storyId);
    if (!story) {
      return NextResponse.json({ error: "Story not found" }, { status: 404 });
    }
    if (story.userId !== userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    const admissionError = await reserveGeneration();
    if (admissionError) return admissionError;

    const nextPageNumber = await getNextPageNumber(storyId);
    const page = await createPage({
      storyId,
      pageNumber: nextPageNumber,
      prompt,
      characterImageUrls: characterImages,
    });

    // Get previous page image for style consistency (unless it's page 1)
    if (nextPageNumber > 1) {
      const lastPageImage = await getLastPageImage(storyId);
      if (lastPageImage) {
        referenceImages.push(lastPageImage);
      }
    }

    // Use only the character images sent from the frontend
    referenceImages.push(...characterImages);

    const fullPrompt = buildComicPrompt({
      prompt,
      style: story.style,
      characterImages,
      isContinuation,
      previousContext,
    });

    let imageBuffer: Buffer;
    try {
      console.log("Starting image generation for ...");
      const startTime = Date.now();
      await markProviderStarted();
      imageBuffer = await generateComicImage({
        apiKey: openAIApiKey,
        prompt: fullPrompt,
        referenceImageUrls: referenceImages,
      });
      const endTime = Date.now();
      const durationMs = endTime - startTime;
      const durationSeconds = (durationMs / 1000).toFixed(2);
      console.log(`Image generation completed in ${durationSeconds} seconds`);
    } catch (error) {
      console.error("Image generation error:", error);
      await settlePendingQuota();

      // Clean up DB records if generation failed
      try {
        await deletePage(page.id);
      } catch (cleanupError) {
        console.error(
          "Error cleaning up DB on image generation failure:",
          cleanupError,
        );
      }

      if (
        error instanceof Error &&
        error.message &&
        isContentPolicyViolation(error.message)
      ) {
        return NextResponse.json(
          {
            error: getContentPolicyErrorMessage(),
            errorType: "content_policy",
          },
          { status: 400 },
        );
      }

      if (error instanceof Error && "status" in error) {
        const status = (error as any).status;
        if (status === 402) {
          return NextResponse.json(
            {
              error:
                "Insufficient API credits. Please add credits to your OpenAI account at https://platform.openai.com/account/billing or update your API key.",
              errorType: "credit_limit",
            },
            { status: 402 },
          );
        }
        return NextResponse.json(
          {
            error: error.message || `Failed to generate image: ${status}`,
            errorType: "api_error",
          },
          { status: status || 500 },
        );
      }

      return NextResponse.json(
        {
          error: `Internal server error: ${
            error instanceof Error ? error.message : "Unknown error"
          }`,
        },
        { status: 500 },
      );
    }

    const blobKey = `${story.id}/page-${
      page.pageNumber
    }-${Date.now()}.png`;
    const imageUrl = await uploadBufferToBlob(imageBuffer, blobKey, "image/png");

    // Save the Azure media URL on the generated page.
    try {
      await updatePage(page.id, imageUrl);
    } catch (dbError) {
      console.error("Error updating page in database:", dbError);
      await settlePendingQuota();
      return NextResponse.json(
        { error: "Failed to save generated image" },
        { status: 500 },
      );
    }

    await settlePendingQuota();

    return NextResponse.json({
      imageUrl,
      pageId: page.id,
      pageNumber: page.pageNumber,
    });
  } catch (error) {
    if (quotaClaimKey) {
      try {
        await settlePendingQuota();
      } catch (quotaError) {
        console.error("Failed to release generation quota", quotaError);
      }
    }
    console.error("Error in generate-comic API:", error);
    return NextResponse.json(
      {
        error: `Internal server error: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      },
      { status: 500 },
    );
  }
}
