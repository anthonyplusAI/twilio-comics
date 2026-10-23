import { buildComicPrompt } from "./prompt";
import { generateComicImage } from "./image-generation";
import {
  blobExists,
  getBlobPublicUrl,
  uploadBufferToBlob,
} from "./blob-storage";
import { generateTitleAndDescription } from "./title-generation";
import {
  createStory,
  createPage,
  getStoryWithPages,
  updateStory,
  updatePage,
  deleteStory,
  deleteBlankContinuationPage,
} from "./db-actions";
import { isContentPolicyViolation } from "./utils";

const PUBLIC_MODERATION_CATEGORIES = [
  "harassment",
  "harassment/threatening",
  "hate",
  "hate/threatening",
  "illicit",
  "illicit/violent",
  "self-harm",
  "self-harm/intent",
  "self-harm/instructions",
  "sexual",
  "sexual/minors",
  "violence",
  "violence/graphic",
] as const;

export type ComicModerationCategory = (typeof PUBLIC_MODERATION_CATEGORIES)[number];
export type ComicModerationStage = "input" | "output" | "unknown";
export interface ComicModerationDetails {
  stage?: ComicModerationStage;
  categories: ComicModerationCategory[];
}

export class ComicServiceError extends Error {
  type: "content_policy" | "credit_limit" | "api_error";
  status?: number;
  code?: "moderation_blocked";
  moderationDetails?: ComicModerationDetails;
  constructor(
    type: "content_policy" | "credit_limit" | "api_error",
    message: string,
    status?: number,
    options?: { code?: "moderation_blocked"; moderationDetails?: ComicModerationDetails },
  ) {
    super(message);
    this.type = type;
    this.status = status;
    this.code = options?.code;
    this.moderationDetails = options?.moderationDetails;
  }
}

function providerModerationDetails(error: unknown): ComicModerationDetails | undefined {
  if (!error || typeof error !== "object" || !("error" in error)) return undefined;
  const body = (error as { error?: unknown }).error;
  if (!body || typeof body !== "object" || !("moderation_details" in body)) return undefined;
  const raw = (body as { moderation_details?: unknown }).moderation_details;
  if (!raw || typeof raw !== "object") return undefined;

  const stageValue = "moderation_stage" in raw
    ? (raw as { moderation_stage?: unknown }).moderation_stage : undefined;
  const stage = stageValue === "input" || stageValue === "output" || stageValue === "unknown"
    ? stageValue : undefined;
  const categoryValues = "categories" in raw
    ? (raw as { categories?: unknown }).categories : undefined;
  const categories = Array.isArray(categoryValues)
    ? [...new Set(categoryValues.filter((value): value is ComicModerationCategory =>
      typeof value === "string" &&
      (PUBLIC_MODERATION_CATEGORIES as readonly string[]).includes(value),
    ))]
    : [];
  return stage || categories.length ? { ...(stage ? { stage } : {}), categories } : undefined;
}

function comicImageError(error: unknown): ComicServiceError {
  const message = error instanceof Error ? error.message : "Unknown error";
  const statusValue = error && typeof error === "object" && "status" in error
    ? (error as { status?: unknown }).status : undefined;
  const status = typeof statusValue === "number" && Number.isInteger(statusValue)
    ? statusValue : undefined;
  const code = error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code : undefined;

  if (code === "moderation_blocked" || isContentPolicyViolation(message)) {
    return new ComicServiceError("content_policy", message, status, code === "moderation_blocked"
      ? { code, moderationDetails: providerModerationDetails(error) } : undefined);
  }
  if (status === 402 || status === 429) {
    return new ComicServiceError("credit_limit", message, status);
  }
  return new ComicServiceError("api_error", message, status);
}

export interface CreateComicArgs {
  userId: string;
  prompt: string;
  apiKey?: string;
  storyId?: string;
  pageId?: string;
  imageKey?: string;
  preserveOnFailure?: boolean;
  style?: string;
  characterImageUrls?: string[];
  source: "web" | "sms" | "whatsapp" | "voice";
  generateTitle?: boolean;
  usesOwnApiKey?: boolean;
}

export interface CreateComicResult {
  story: { id: string; slug: string; title: string; description?: string };
  page: { id: string; pageNumber: number };
  imageUrl: string;
}

export async function createComicStory({
  userId,
  prompt,
  apiKey,
  storyId,
  pageId,
  imageKey,
  preserveOnFailure = false,
  style = "noir",
  characterImageUrls = [],
  source,
  generateTitle = true,
  usesOwnApiKey = !!apiKey,
}: CreateComicArgs): Promise<CreateComicResult> {
  const openAIApiKey = apiKey || process.env.OPENAI_API_KEY;
  if (!openAIApiKey) {
    throw new ComicServiceError(
      "api_error",
      "OPENAI_API_KEY environment variable is not set",
      500,
    );
  }

  const fallbackTitle =
    prompt.length > 50 ? prompt.substring(0, 50) + "..." : prompt;

  const story = await createStory({
    id: storyId,
    title: fallbackTitle,
    description: undefined,
    userId,
    style,
    source,
    usesOwnApiKey,
  });

  const cleanupStoryAfterFailure = async () => {
    if (preserveOnFailure) return;
    try {
      await deleteStory(story.id);
    } catch (cleanupError) {
      console.error("Error cleaning up story after generation failure:", cleanupError);
    }
  };

  let page: Awaited<ReturnType<typeof createPage>>;
  try {
    page = await createPage({
      id: pageId,
      storyId: story.id,
      pageNumber: 1,
      prompt,
      characterImageUrls,
    });
  } catch (error) {
    await cleanupStoryAfterFailure();
    throw error;
  }

  if (page.generatedImageUrl) {
    return {
      story: {
        id: story.id,
        slug: story.slug,
        title: story.title,
        description: story.description || undefined,
      },
      page: { id: page.id, pageNumber: page.pageNumber },
      imageUrl: page.generatedImageUrl,
    };
  }

  const blobKey =
    imageKey || `${story.id}/page-${page.pageNumber}-${Date.now()}.png`;
  if (imageKey && (await blobExists(blobKey))) {
    const existingImageUrl = getBlobPublicUrl(blobKey);
    await updatePage(page.id, existingImageUrl);
    return {
      story: {
        id: story.id,
        slug: story.slug,
        title: story.title,
        description: story.description || undefined,
      },
      page: { id: page.id, pageNumber: page.pageNumber },
      imageUrl: existingImageUrl,
    };
  }

  const fullPrompt = buildComicPrompt({
    prompt,
    style,
    characterImages: characterImageUrls,
  });

  // Kick off title generation in parallel and settle errors before image work finishes.
  const titlePromise = (generateTitle
    ? generateTitleAndDescription({ apiKey: openAIApiKey, prompt, style })
    : Promise.resolve({
        title: fallbackTitle,
        description: undefined as string | undefined,
      })).catch((error) => {
        console.error("Error generating title and description:", error);
        return { title: fallbackTitle, description: undefined };
      });

  let imageBuffer: Buffer;
  try {
    imageBuffer = await generateComicImage({
      apiKey: openAIApiKey,
      prompt: fullPrompt,
      referenceImageUrls: characterImageUrls,
    });
  } catch (error) {
    await cleanupStoryAfterFailure();
    throw comicImageError(error);
  }

  let imageUrl: string;
  try {
    imageUrl = await uploadBufferToBlob(imageBuffer, blobKey, "image/png");
    await updatePage(page.id, imageUrl);
  } catch (error) {
    await cleanupStoryAfterFailure();
    throw error;
  }

  const { title, description } = await titlePromise;
  try {
    await updateStory(story.id, { title, description });
  } catch (dbError) {
    console.error("Error updating story title/description:", dbError);
  }

  return {
    story: { id: story.id, slug: story.slug, title, description },
    page: { id: page.id, pageNumber: page.pageNumber },
    imageUrl,
  };
}

export interface CreateComicContinuationArgs {
  userId: string;
  storyId: string;
  pageId: string;
  prompt: string;
  apiKey?: string;
  characterImageUrls?: string[];
  imageKey?: string;
}

/** Safe to call after a continuation job is marked failed; generated pages survive. */
export async function cleanupFailedContinuationPage(args: {
  userId: string;
  storyId: string;
  pageId: string;
}): Promise<boolean> {
  return deleteBlankContinuationPage(args);
}

/** Add one idempotent page to an existing, owned comic book. */
export async function createComicContinuationPage({
  userId,
  storyId,
  pageId,
  prompt,
  apiKey,
  characterImageUrls = [],
  imageKey = `stories/${storyId}/page-${pageId}.png`,
}: CreateComicContinuationArgs): Promise<CreateComicResult> {
  const openAIApiKey = apiKey || process.env.OPENAI_API_KEY;
  if (!openAIApiKey) {
    throw new ComicServiceError("api_error", "OPENAI_API_KEY environment variable is not set", 500);
  }

  const storyData = await getStoryWithPages(storyId);
  if (!storyData) throw new ComicServiceError("api_error", "Story not found", 404);
  const { story } = storyData;
  if (story.userId !== userId) {
    throw new ComicServiceError("api_error", "Story does not belong to this caller", 403);
  }

  let existingPages = storyData.pages;
  let page = existingPages.find((candidate) => candidate.id === pageId);
  if (!page) {
    // The (story_id, page_number) unique index resolves concurrent page
    // allocations. A contender may retry after the other insert commits.
    for (let attempt = 0; attempt < 3 && !page; attempt++) {
      const pageNumber = Math.max(0, ...existingPages.map((candidate) => candidate.pageNumber)) + 1;
      try {
        page = await createPage({
          id: pageId,
          storyId,
          pageNumber,
          prompt,
          characterImageUrls,
        });
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
        if (code !== "23505" || attempt === 2) throw error;
        const refreshed = await getStoryWithPages(storyId);
        if (!refreshed) throw new ComicServiceError("api_error", "Story disappeared", 404);
        existingPages = refreshed.pages;
        page = existingPages.find((candidate) => candidate.id === pageId);
      }
    }
  }
  if (!page || page.storyId !== storyId) {
    throw new ComicServiceError("api_error", "Page ID belongs to a different story", 409);
  }

  const storyResult = {
    id: story.id,
    slug: story.slug,
    title: story.title,
    description: story.description || undefined,
  };
  const pageResult = { id: page.id, pageNumber: page.pageNumber };
  if (page.generatedImageUrl) {
    return { story: storyResult, page: pageResult, imageUrl: page.generatedImageUrl };
  }
  if (await blobExists(imageKey)) {
    const imageUrl = getBlobPublicUrl(imageKey);
    await updatePage(page.id, imageUrl);
    return { story: storyResult, page: pageResult, imageUrl };
  }

  const previousPages = existingPages
    .filter((candidate) => candidate.pageNumber < page!.pageNumber)
    .sort((a, b) => a.pageNumber - b.pageNumber);
  const lastImage = [...previousPages]
    .reverse()
    .find((candidate) => candidate.generatedImageUrl)?.generatedImageUrl;
  const referenceImageUrls = [
    ...(lastImage ? [lastImage] : []),
    ...characterImageUrls,
  ];
  const fullPrompt = buildComicPrompt({
    prompt,
    style: story.style,
    characterImages: characterImageUrls,
    isAddPage: true,
    previousPages: previousPages.map((candidate) => ({ prompt: candidate.prompt })),
  });

  let imageBuffer: Buffer;
  try {
    imageBuffer = await generateComicImage({
      apiKey: openAIApiKey,
      prompt: fullPrompt,
      referenceImageUrls,
    });
  } catch (error) {
    throw comicImageError(error);
  }

  const imageUrl = await uploadBufferToBlob(imageBuffer, imageKey, "image/png");
  await updatePage(page.id, imageUrl);
  return { story: storyResult, page: pageResult, imageUrl };
}
