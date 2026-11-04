import { APIConnectionError } from "openai";
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

// A 429 can mean either a temporary request-rate limit or credits that cannot
// recover with a retry. OpenAI exposes the specific cause in the error code.
const HARD_BILLING_CODES = new Set([
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "insufficient_quota", // Legacy code.
]);

export type ComicModerationCategory = (typeof PUBLIC_MODERATION_CATEGORIES)[number];
export type ComicModerationStage = "input" | "output" | "unknown";
export interface ComicModerationDetails {
  stage?: ComicModerationStage;
  categories: ComicModerationCategory[];
}

export class ComicServiceError extends Error {
  type: "content_policy" | "credit_limit" | "api_error" | "missing_reference";
  status?: number;
  code?: "moderation_blocked";
  moderationDetails?: ComicModerationDetails;
  retryAfterSeconds?: number;
  imageGenerationError?: boolean;
  retryableConnection?: boolean;
  constructor(
    type: "content_policy" | "credit_limit" | "api_error" | "missing_reference",
    message: string,
    status?: number,
    options?: {
      code?: "moderation_blocked";
      moderationDetails?: ComicModerationDetails;
      retryAfterSeconds?: number;
      imageGenerationError?: boolean;
      retryableConnection?: boolean;
    },
  ) {
    super(message);
    this.type = type;
    this.status = status;
    this.code = options?.code;
    this.moderationDetails = options?.moderationDetails;
    this.retryAfterSeconds = options?.retryAfterSeconds;
    this.imageGenerationError = options?.imageGenerationError;
    this.retryableConnection = options?.retryableConnection;
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

function providerErrorField(error: unknown, field: "code" | "type"): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const direct = (error as Record<string, unknown>)[field];
  if (typeof direct === "string" && direct) return direct;
  const inner = "error" in error ? (error as { error?: unknown }).error : undefined;
  if (!inner || typeof inner !== "object") return undefined;
  const nested = (inner as Record<string, unknown>)[field];
  return typeof nested === "string" && nested ? nested : undefined;
}

function providerRetryAfterSeconds(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("headers" in error)) return undefined;
  const headers = (error as { headers?: unknown }).headers;
  if (!headers || typeof headers !== "object") return undefined;
  let rawMillis: unknown;
  let raw: unknown;
  if ("get" in headers && typeof headers.get === "function") {
    rawMillis = headers.get("retry-after-ms");
    raw = headers.get("retry-after");
  } else {
    rawMillis = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after-ms")?.[1];
    raw = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
  }
  if (typeof rawMillis === "string" && rawMillis.trim()) {
    const millis = Number(rawMillis);
    if (Number.isFinite(millis) && millis >= 0) return Math.ceil(millis / 1000);
  }
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 0) return Math.ceil(numeric);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : undefined;
}

function comicImageError(error: unknown): ComicServiceError {
  const message = error instanceof Error ? error.message : "Unknown error";
  const statusValue = error && typeof error === "object" && "status" in error
    ? (error as { status?: unknown }).status : undefined;
  const status = typeof statusValue === "number" && Number.isInteger(statusValue)
    ? statusValue : undefined;
  const code = providerErrorField(error, "code");
  const type = providerErrorField(error, "type");

  if (code === "moderation_blocked" || isContentPolicyViolation(message)) {
    return new ComicServiceError("content_policy", message, status, code === "moderation_blocked"
      ? { code, moderationDetails: providerModerationDetails(error) } : undefined);
  }
  if (status === 402 || HARD_BILLING_CODES.has(code || "") ||
      (status === 429 && !code && type === "insufficient_quota")) {
    return new ComicServiceError("credit_limit", message, status);
  }
  // Mark the origin so an image API 409 can retry without changing the
  // terminal handling of story ownership conflicts elsewhere in the service.
  return new ComicServiceError("api_error", message, status, {
    imageGenerationError: true,
    retryableConnection: error instanceof APIConnectionError,
    retryAfterSeconds: status !== undefined &&
      ([408, 409, 429].includes(status) || (status >= 500 && status < 600))
      ? providerRetryAfterSeconds(error) : undefined,
  });
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
  beforeProviderCall?: () => Promise<void>;
  imageMaxRetries?: number;
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
  beforeProviderCall,
  imageMaxRetries,
}: CreateComicArgs): Promise<CreateComicResult> {
  if (!characterImageUrls.some((url) => typeof url === "string" && url.trim().length > 0)) {
    throw new ComicServiceError(
      "missing_reference",
      "Add at least one reference photo before generating your comic.",
      400,
    );
  }

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

  try {
    await beforeProviderCall?.();
  } catch (error) {
    await cleanupStoryAfterFailure();
    throw error;
  }

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
      imageMaxRetries,
    });
  } catch (error) {
    await cleanupStoryAfterFailure();
    if (beforeProviderCall) await titlePromise;
    throw comicImageError(error);
  }

  let imageUrl: string;
  try {
    imageUrl = await uploadBufferToBlob(imageBuffer, blobKey, "image/png");
    await updatePage(page.id, imageUrl);
  } catch (error) {
    await cleanupStoryAfterFailure();
    if (beforeProviderCall) await titlePromise;
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
  imageMaxRetries?: number;
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
  imageMaxRetries,
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
    previousPageImageIncluded: Boolean(lastImage),
    isAddPage: true,
    previousPages: previousPages.map((candidate) => ({ prompt: candidate.prompt })),
  });

  let imageBuffer: Buffer;
  try {
    imageBuffer = await generateComicImage({
      apiKey: openAIApiKey,
      prompt: fullPrompt,
      referenceImageUrls,
      imageMaxRetries,
    });
  } catch (error) {
    throw comicImageError(error);
  }

  const imageUrl = await uploadBufferToBlob(imageBuffer, imageKey, "image/png");
  await updatePage(page.id, imageUrl);
  return { story: storyResult, page: pageResult, imageUrl };
}
