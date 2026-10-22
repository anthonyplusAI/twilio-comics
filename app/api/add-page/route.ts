import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  updatePage,
  createPage,
  getNextPageNumber,
  getStoryWithPagesBySlug,
  deletePage,
} from "@/lib/db-actions";
import { uploadBufferToBlob } from "@/lib/blob-storage";
import {
  consumeFreeTierQuota,
  releaseFreeTierQuota,
} from "@/lib/quota";
import {
  chooseGenerationApiKey,
  reserveBrowserGenerationCapacity,
} from "@/lib/generation-capacity";
import { buildComicPrompt } from "@/lib/prompt";
import { generateComicImage } from "@/lib/image-generation";
import {
  isContentPolicyViolation,
  getContentPolicyErrorMessage,
} from "@/lib/utils";
import { addPageRequestSchema } from "@/lib/browser-generation-request";

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
    // Saving the image already spent this reservation. Keep the saved result
    // visible even if marking its claim consumed temporarily fails.
    quotaClaimKey = null;
    if (!claimKey) return;
    try {
      await consumeFreeTierQuota(claimKey);
    } catch (error) {
      console.error("Failed to mark saved page quota consumed:", error);
    }
  }

  try {
    const session = await auth();
    const userId = session?.user?.id;
    const apiKey = request.headers.get("x-api-key") ?? undefined;

    if (!userId) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON request" }, { status: 400 });
    }
    const parsed = addPageRequestSchema.safeParse(body);
    if (!parsed.success) {
      const fields = body && typeof body === "object" && !Array.isArray(body)
        ? body as Record<string, unknown>
        : null;
      const error = fields && (!fields.storyId || !fields.prompt)
        ? "Missing required fields: storyId and prompt"
        : "Invalid page request";
      return NextResponse.json({ error }, { status: 400 });
    }

    const {
      storyId,
      pageId,
      prompt,
      characterImages,
    } = parsed.data;

    const keyChoice = chooseGenerationApiKey(apiKey, process.env.OPENAI_API_KEY);
    if (!keyChoice.valid) {
      return NextResponse.json(
        { error: keyChoice.reason === "missing"
          ? "Server configuration error - OpenAI API key not available"
          : "Invalid OpenAI API key" },
        { status: keyChoice.reason === "missing" ? 500 : 400 },
      );
    }
    const openAIApiKey = keyChoice.apiKey;

    // Get the story and all its pages
    const storyData = await getStoryWithPagesBySlug(storyId);
    if (!storyData) {
      return NextResponse.json({ error: "Story not found" }, { status: 404 });
    }

    const { story, pages } = storyData;

    // Check ownership
    if (story.userId !== userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    // Validate redraw targets before reserving a weekly generation credit.
    // An unknown page must not leave a live quota claim behind.
    let page = pageId ? pages.find((candidate) => candidate.id === pageId) : undefined;
    if (pageId && !page) {
      return NextResponse.json({ error: "Page not found" }, { status: 404 });
    }

    if (keyChoice.appFunded) {
      quotaClaimKey = `web-page:${userId}:${randomUUID()}`;
      const admission = await reserveBrowserGenerationCapacity(userId, quotaClaimKey);
      if (admission.reason !== "accepted") {
        quotaClaimKey = null;
        if (admission.reason === "daily_capacity") {
          return NextResponse.json(
            {
              error: "Comic generation is at today's capacity. Please try again tomorrow.",
              errorType: "daily_capacity",
              isRateLimited: true,
            },
            { status: 429 },
          );
        }
        return NextResponse.json(
          {
            error: "You've reached the free limit of 3 comics this week.",
            errorType: "quota_limit",
            isRateLimited: true,
            creditsRemaining: admission.quota.remaining,
            resetTime: admission.quota.reset,
          },
          { status: 429 },
        );
      }
    }

    let pageNumber: number;
    const isRedraw = Boolean(pageId);

    if (isRedraw) {
      // Preserve the post-reservation recheck: a page may be removed while the
      // quota request is in flight. Release its claim before returning.
      const refreshed = await getStoryWithPagesBySlug(storyId);
      if (!refreshed) {
        await releasePendingQuota();
        return NextResponse.json({ error: "Story not found" }, { status: 404 });
      }
      if (refreshed.story.userId !== userId) {
        await releasePendingQuota();
        return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
      }
      page = refreshed.pages.find((candidate) => candidate.id === pageId);
      if (!page) {
        await releasePendingQuota();
        return NextResponse.json({ error: "Page not found" }, { status: 404 });
      }
      pageNumber = page.pageNumber;
    } else {
      // Add new page mode
      pageNumber = await getNextPageNumber(story.id);
      page = await createPage({
        storyId: story.id,
        pageNumber,
        prompt,
        characterImageUrls: characterImages,
      });
    }

    // Collect reference images: previous page + story characters + current characters
    const referenceImages: string[] = [];

    // Get previous page image for style consistency (unless it's page 1)
    if (pageNumber > 1) {
      // Always use the previous page's image, regardless of new page or redraw
      const storyData = await getStoryWithPagesBySlug(storyId);
      if (storyData) {
        const previousPage = storyData.pages.find(
          (p) => p.pageNumber === pageNumber - 1,
        );
        if (previousPage?.generatedImageUrl) {
          referenceImages.push(previousPage.generatedImageUrl);
        }
      }
    }

    // Use only the character images sent from the frontend (user's selection)
    // These are already the most recent/relevant characters the user wants to use
    referenceImages.push(...characterImages);

    // Build the prompt with continuation context
    // For redraw, only include pages up to the current page being redrawn
    // For new page, include all existing pages
    const relevantPages = isRedraw
      ? pages.filter((p) => p.pageNumber < pageNumber)
      : pages;

    const previousPages = relevantPages.map((p) => ({
      prompt: p.prompt,
    }));

    const fullPrompt = buildComicPrompt({
      prompt,
      style: story.style,
      characterImages,
      isAddPage: true,
      previousPages,
    });

    let imageBuffer: Buffer;
    try {
      console.log("Starting image generation for ...");
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
        if (!isRedraw) {
          // For new page, delete the page that was created
          await deletePage(page.id);
        }
        // For redraw, we don't delete the page, just don't update it
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
              error: "Insufficient API credits.",
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

    const blobKey = `${story.id}/page-${page.pageNumber}-${Date.now()}.png`;
    const imageUrl = await uploadBufferToBlob(imageBuffer, blobKey, "image/png");

    await updatePage(page.id, imageUrl);

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
    console.error("Error in add-page API:", error);
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
