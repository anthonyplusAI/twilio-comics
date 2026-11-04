import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { photoRequestHasAllowedOrigin } from "@/lib/browser-photo-session";
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
} from "@/lib/generation-capacity";
import { buildComicPrompt } from "@/lib/prompt";
import { generateComicImage } from "@/lib/image-generation";
import {
  isContentPolicyViolation,
  getContentPolicyErrorMessage,
} from "@/lib/utils";
import { addPageRequestSchema } from "@/lib/browser-generation-request";
import { isAllowedReferenceImageUrl } from "@/lib/reference-image-url";
import {
  markStudioAppGenerationPaidStarted,
  reserveStudioAppGenerationCapacity,
} from "@/lib/studio-guest-capacity";
import { readBoundedStudioJson } from "@/lib/studio-guest-json";
import { getStudioActor, guestOwnsReferenceImages } from "@/lib/studio-guest-session";

const FIRST_PAGE_REFERENCE_MESSAGE = "This first page has no authorized original photo to redraw.";

function authorizedOriginalReferences(
  urls: unknown,
  actor: { userId: string; kind: "guest" | "google" },
): string[] {
  if (!Array.isArray(urls)) return [];
  return urls.filter((url): url is string =>
    typeof url === "string" && (actor.kind === "guest"
      ? guestOwnsReferenceImages(actor.userId, [url])
      : isAllowedReferenceImageUrl(url)),
  ).slice(0, 2);
}

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
      quotaClaimKey = null;
      try {
        await consumeFreeTierQuota(claimKey);
      } catch (error) {
        console.error("Failed to mark paid page generation consumed:", error);
      }
    } else {
      await releaseFreeTierQuota(claimKey);
      quotaClaimKey = null;
    }
  }

  try {
    const actor = await getStudioActor(request);
    const userId = actor?.userId;
    const apiKey = request.headers.get("x-api-key") ?? undefined;

    if (!actor || !userId) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }
    if (actor.kind === "guest" && !photoRequestHasAllowedOrigin(request)) {
      return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
    }

    const json = await readBoundedStudioJson(request);
    if (!json.ok) return NextResponse.json({ error: json.error }, { status: json.status });
    const body = json.value;
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

    // Validate redraw targets before reserving a generation slot.
    // An unknown page must not leave a live claim behind.
    let page = pageId ? pages.find((candidate) => candidate.id === pageId) : undefined;
    if (pageId && !page) {
      return NextResponse.json({ error: "Page not found" }, { status: 404 });
    }
    if (page?.pageNumber === 1 &&
        authorizedOriginalReferences(page.characterImageUrls, actor).length === 0) {
      return NextResponse.json({ error: FIRST_PAGE_REFERENCE_MESSAGE }, { status: 400 });
    }

    if (keyChoice.appFunded) {
      const claimKey = `web-page:${userId}:${randomUUID()}`;
      const admission = await reserveStudioAppGenerationCapacity(actor, claimKey, request);
      if (admission.reason !== "accepted") {
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
      quotaClaimKey = claimKey;
    }

    let pageNumber: number;
    const isRedraw = Boolean(pageId);
    let firstPageReferences: string[] = [];

    if (isRedraw) {
      // Preserve the post-reservation recheck: a page may be removed while the
      // quota request is in flight. Release its claim before returning.
      const refreshed = await getStoryWithPagesBySlug(storyId);
      if (!refreshed) {
        await settlePendingQuota();
        return NextResponse.json({ error: "Story not found" }, { status: 404 });
      }
      if (refreshed.story.userId !== userId) {
        await settlePendingQuota();
        return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
      }
      page = refreshed.pages.find((candidate) => candidate.id === pageId);
      if (!page) {
        await settlePendingQuota();
        return NextResponse.json({ error: "Page not found" }, { status: 404 });
      }
      pageNumber = page.pageNumber;
      if (pageNumber === 1) {
        firstPageReferences = authorizedOriginalReferences(page.characterImageUrls, actor);
        if (firstPageReferences.length === 0) {
          await settlePendingQuota();
          return NextResponse.json({ error: FIRST_PAGE_REFERENCE_MESSAGE }, { status: 400 });
        }
      }
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

    // A first-page redraw keeps at least one authorized original portrait.
    const effectiveCharacterImages = firstPageReferences.length > 0
      ? [...new Set([...firstPageReferences, ...characterImages])].slice(0, 2)
      : characterImages;
    referenceImages.push(...effectiveCharacterImages);

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
      characterImages: effectiveCharacterImages,
      isAddPage: true,
      previousPages,
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
