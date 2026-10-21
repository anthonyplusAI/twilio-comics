import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
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
  reserveFreeTierQuota,
} from "@/lib/quota";
import { buildComicPrompt } from "@/lib/prompt";
import { generateComicImage } from "@/lib/image-generation";
import {
  isContentPolicyViolation,
  getContentPolicyErrorMessage,
} from "@/lib/utils";
import { createComicStory, ComicServiceError } from "@/lib/comic-service";

export async function POST(request: NextRequest) {
  let quotaClaimKey: string | null = null;
  async function releasePendingQuota(): Promise<void> {
    if (!quotaClaimKey) return;
    const claimKey = quotaClaimKey;
    await releaseFreeTierQuota(claimKey);
    quotaClaimKey = null;
  }

  async function finishSavedQuota(): Promise<void> {
    const claimKey = quotaClaimKey;
    // The comic is already saved and this reservation already counts toward
    // the limit. A failed status write must not refund it or hide the result.
    quotaClaimKey = null;
    if (!claimKey) return;
    try {
      await consumeFreeTierQuota(claimKey);
    } catch (error) {
      console.error("Failed to mark saved comic quota consumed:", error);
    }
  }

  try {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const {
      storyId,
      prompt,
      apiKey,
      style = "noir",
      characterImages = [],
      isContinuation = false,
      previousContext = "",
    } = await request.json();

    if (!prompt) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    const openAIApiKey = apiKey || process.env.OPENAI_API_KEY;
    if (!openAIApiKey) {
      return NextResponse.json(
        { error: "Server configuration error - OpenAI API key not available" },
        { status: 500 },
      );
    }

    // New-story path: delegate to channel-agnostic service and return early.
    // The continuation path (storyId present) falls through to the existing logic below.
    if (!storyId) {
      if (!apiKey) {
        quotaClaimKey = `web-generation:${userId}:${randomUUID()}`;
        const reservation = await reserveFreeTierQuota(userId, quotaClaimKey);
        if (!reservation.allowed) {
          return NextResponse.json(
            {
              error: "You've reached the free limit of 3 comics this week.",
              errorType: "quota_limit",
              isRateLimited: true,
              creditsRemaining: reservation.remaining,
              resetTime: reservation.reset,
            },
            { status: 429 },
          );
        }
      }
      try {
        const result = await createComicStory({
          userId,
          prompt,
          apiKey,
          style,
          characterImageUrls: characterImages,
          source: "web",
          generateTitle: true,
          usesOwnApiKey: !!apiKey,
        });
        await finishSavedQuota();
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
        await releasePendingQuota();
        if (error instanceof ComicServiceError) {
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

    if (!apiKey) {
      quotaClaimKey = `web-generation:${userId}:${randomUUID()}`;
      const reservation = await reserveFreeTierQuota(userId, quotaClaimKey);
      if (!reservation.allowed) {
        return NextResponse.json(
          {
            error: "You've reached the free limit of 3 comics this week.",
            errorType: "quota_limit",
            isRateLimited: true,
            creditsRemaining: reservation.remaining,
            resetTime: reservation.reset,
          },
          { status: 429 },
        );
      }
    }

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
      console.dir({
        fullPrompt,
        referenceImages,
      });
      const startTime = Date.now();
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
      await releasePendingQuota();

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
      await releasePendingQuota();
      return NextResponse.json(
        { error: "Failed to save generated image" },
        { status: 500 },
      );
    }

    await finishSavedQuota();

    return NextResponse.json({
      imageUrl,
      pageId: page.id,
      pageNumber: page.pageNumber,
    });
  } catch (error) {
    if (quotaClaimKey) {
      try {
        await releasePendingQuota();
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
