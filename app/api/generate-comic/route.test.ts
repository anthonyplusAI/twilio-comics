import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { MAX_USER_PROMPT } from "@/lib/prompt";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  actor: vi.fn(),
  reserveStudioCapacity: vi.fn(),
  markPaidStarted: vi.fn(),
  createComicStory: vi.fn(),
  getStoryById: vi.fn(),
  getNextPageNumber: vi.fn(),
  createPage: vi.fn(),
  getLastPageImage: vi.fn(),
  deletePage: vi.fn(),
  updatePage: vi.fn(),
  reserveFreeTierQuota: vi.fn(),
  releaseFreeTierQuota: vi.fn(),
  consumeFreeTierQuota: vi.fn(),
  generateComicImage: vi.fn(),
  uploadBufferToBlob: vi.fn(),
  transaction: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/studio-guest-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/studio-guest-session")>()),
  getStudioActor: h.actor,
}));
vi.mock("@/lib/studio-guest-capacity", () => ({
  reserveStudioAppGenerationCapacity: h.reserveStudioCapacity,
  markStudioAppGenerationPaidStarted: h.markPaidStarted,
}));
vi.mock("@/lib/comic-service", () => ({
  createComicStory: h.createComicStory,
  ComicServiceError: class ComicServiceError extends Error {
    type: string;
    status?: number;
    constructor(type: string, message: string, status?: number) {
      super(message);
      this.type = type;
      this.status = status;
    }
  },
}));
vi.mock("@/lib/db-actions", () => ({
  getStoryById: h.getStoryById,
  getNextPageNumber: h.getNextPageNumber,
  createPage: h.createPage,
  getLastPageImage: h.getLastPageImage,
  deletePage: h.deletePage,
  updatePage: h.updatePage,
}));
vi.mock("@/lib/quota", () => ({
  reserveFreeTierQuota: h.reserveFreeTierQuota,
  releaseFreeTierQuota: h.releaseFreeTierQuota,
  consumeFreeTierQuota: h.consumeFreeTierQuota,
}));
vi.mock("@/lib/image-generation", () => ({ generateComicImage: h.generateComicImage }));
vi.mock("@/lib/blob-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/blob-storage")>()),
  uploadBufferToBlob: h.uploadBufferToBlob,
}));
vi.mock("@/lib/db", () => ({ db: { transaction: h.transaction, execute: h.execute } }));

import { POST } from "@/app/api/generate-comic/route";
import { getBlobPublicUrl } from "@/lib/blob-storage";
import { ComicServiceError } from "@/lib/comic-service";

const story = {
  id: "98e67699-ffec-4e68-a52d-e2c28fc21453",
  slug: "fox-on-mars",
  userId: "owner-1",
  style: "noir",
};
const page = {
  id: "c1f4e5c0-2e1a-48a6-a251-c104697f60bf",
  pageNumber: 2,
};
const validCharacterImage = "https://account.blob.core.windows.net/comics/fox.png";

function request(body: unknown, origin?: string): NextRequest {
  return new NextRequest("https://comics.example.com/api/generate-comic", {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
}

function malformedJsonRequest(): NextRequest {
  return new NextRequest("https://comics.example.com/api/generate-comic", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not-json",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.consumeFreeTierQuota.mockReset();
  h.markPaidStarted.mockReset().mockResolvedValue(undefined);
  h.createComicStory.mockReset();
  h.reserveFreeTierQuota.mockReset();
  h.releaseFreeTierQuota.mockReset();
  process.env.OPENAI_API_KEY = "test-key";
  vi.stubEnv("AZURE_STORAGE_CONNECTION_STRING", "");
  vi.stubEnv("AZURE_STORAGE_BLOB_ENDPOINT", "https://account.blob.core.windows.net");
  vi.stubEnv("AZURE_STORAGE_CONTAINER_NAME", "comics");
  vi.stubEnv("PUBLIC_BASE_URL", "https://comics.example.com");
  vi.stubEnv("MEDIA_SIGNING_SECRET", "test-media-signing-secret");
  h.transaction.mockImplementation(async (callback) => callback({ execute: h.execute }));
  h.execute.mockReset().mockResolvedValue({ rows: [] });
  h.auth.mockResolvedValue({ user: {
    id: story.userId, role: "user", studioAuthorized: true,
  } });
  h.actor.mockImplementation(async () => {
    const user = (await h.auth())?.user;
    const userId = user?.id?.trim();
    return userId && user.studioAuthorized === true
      ? { userId, kind: "google" }
      : null;
  });
  h.reserveStudioCapacity.mockResolvedValue({
    reason: "accepted",
    quota: { allowed: true, remaining: "unlimited", reset: null, status: "reserved" },
  });
  h.reserveFreeTierQuota.mockResolvedValue({ allowed: true, remaining: 2, reset: null, status: "reserved" });
  h.createComicStory.mockImplementation(async (args) => {
    await args.beforeProviderCall?.();
    return {
      story: { ...story, title: "Fox on Mars" },
      page: { id: page.id, pageNumber: 1 },
      imageUrl: "https://example.com/first.png",
    };
  });
  h.getStoryById.mockResolvedValue(story);
  h.getNextPageNumber.mockResolvedValue(2);
  h.createPage.mockResolvedValue(page);
  h.getLastPageImage.mockResolvedValue(null);
  h.generateComicImage.mockResolvedValue(Buffer.from("new image"));
  h.uploadBufferToBlob.mockResolvedValue("https://example.com/second.png");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/generate-comic Studio capacity after saving", () => {
  it("returns a saved new story when consuming its quota claim fails", async () => {
    h.consumeFreeTierQuota.mockRejectedValue(new Error("Quota status write failed"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(request({ prompt: "A fox visits Mars", characterImages: [validCharacterImage] }));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ storyId: story.id, imageUrl: "https://example.com/first.png" });
      expect(h.createComicStory).toHaveBeenCalledOnce();
      expect(h.reserveStudioCapacity).toHaveBeenCalledOnce();
      expect(h.reserveFreeTierQuota).not.toHaveBeenCalled();
      expect(h.releaseFreeTierQuota).not.toHaveBeenCalled();
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("returns a saved continuation when consuming its quota claim fails", async () => {
    h.consumeFreeTierQuota.mockRejectedValue(new Error("Quota status write failed"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(request({ storyId: story.id, prompt: "The fox finds a rover" }));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ pageId: page.id, imageUrl: "https://example.com/second.png" });
      expect(h.updatePage).toHaveBeenCalledWith(page.id, "https://example.com/second.png");
      expect(h.releaseFreeTierQuota).not.toHaveBeenCalled();
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("releases an unused reservation when story setup fails before any provider call", async () => {
    h.createComicStory.mockRejectedValue(new Error("Page write failed"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(request({ prompt: "A fox visits Mars", characterImages: [validCharacterImage] }));

      expect(response.status).toBe(500);
      expect(h.releaseFreeTierQuota).toHaveBeenCalledOnce();
      expect(h.consumeFreeTierQuota).not.toHaveBeenCalled();
      expect(h.markPaidStarted).not.toHaveBeenCalled();
      expect(h.execute).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("charges a blocked Google generation after its provider call starts", async () => {
    h.createComicStory.mockImplementation(async (args) => {
      await args.beforeProviderCall?.();
      throw new ComicServiceError("content_policy", "Image request blocked", 400);
    });

    const response = await POST(request({ prompt: "A blocked scene", characterImages: [validCharacterImage] }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ errorType: "content_policy" });
    expect(h.markPaidStarted).toHaveBeenCalledOnce();
    expect(h.consumeFreeTierQuota).toHaveBeenCalledOnce();
    expect(h.releaseFreeTierQuota).not.toHaveBeenCalled();
  });

  it("charges a failed continuation after image generation starts", async () => {
    h.generateComicImage.mockRejectedValueOnce(new Error("Your request was rejected as a result of our safety system"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(request({ storyId: story.id, prompt: "A blocked scene" }));

      expect(response.status).toBe(400);
      expect(h.markPaidStarted).toHaveBeenCalledOnce();
      expect(h.consumeFreeTierQuota).toHaveBeenCalledOnce();
      expect(h.releaseFreeTierQuota).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("ignores an exhausted legacy weekly quota for app-funded Studio", async () => {
    h.reserveFreeTierQuota.mockResolvedValue({ allowed: false, remaining: 0, reset: null, status: "rejected" });

    const response = await POST(request({ prompt: "A fox visits Mars", characterImages: [validCharacterImage] }));

    expect(response.status).toBe(200);
    expect(h.reserveStudioCapacity).toHaveBeenCalledOnce();
    expect(h.reserveFreeTierQuota).not.toHaveBeenCalled();
    expect(h.createComicStory).toHaveBeenCalledOnce();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("applies the rolling Studio limit to an app-funded Google owner", async () => {
    h.reserveStudioCapacity.mockResolvedValue({
      reason: "rate_limit",
      scope: "user",
      window: "hour",
      message: "You've made many comic pages in the past hour. Please try again later.",
    });

    const response = await POST(request({ prompt: "A fox visits Mars", characterImages: [validCharacterImage] }));

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ errorType: "generation_rate_limit", isRateLimited: true });
    expect(h.createComicStory).not.toHaveBeenCalled();
    expect(h.reserveFreeTierQuota).not.toHaveBeenCalled();
  });

  it("ignores the obsolete daily limit setting for an app-funded story", async () => {
    vi.stubEnv("DAILY_GENERATION_JOB_LIMIT", "0");

    const response = await POST(request({ prompt: "A fox visits Mars", characterImages: [validCharacterImage] }));

    expect(response.status).toBe(200);
    expect(h.reserveStudioCapacity).toHaveBeenCalledOnce();
    expect(h.reserveFreeTierQuota).not.toHaveBeenCalled();
    expect(h.createComicStory).toHaveBeenCalledOnce();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("uses a caller-owned key without reserving the app-funded weekly quota", async () => {
    const ownKey = `sk-${"a".repeat(32)}`;

    const response = await POST(request({ prompt: "A fox visits Mars", apiKey: ownKey, characterImages: [validCharacterImage] }));

    expect(response.status).toBe(200);
    expect(h.createComicStory).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: ownKey,
      usesOwnApiKey: true,
    }));
    expect(h.reserveFreeTierQuota).not.toHaveBeenCalled();
    expect(h.reserveStudioCapacity).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("does not allow malformed caller-key input to bypass app-funded admission", async () => {
    const response = await POST(request({ prompt: "A fox visits Mars", apiKey: { value: "sk-abc" } }));

    expect(response.status).toBe(400);
    expect(h.createComicStory).not.toHaveBeenCalled();
    expect(h.reserveFreeTierQuota).not.toHaveBeenCalled();
  });

  it("counts a submitted copy of the server key as app-funded", async () => {
    const response = await POST(request({ prompt: "A fox visits Mars", apiKey: "test-key", characterImages: [validCharacterImage] }));

    expect(response.status).toBe(200);
    expect(h.reserveStudioCapacity).toHaveBeenCalledOnce();
    expect(h.reserveFreeTierQuota).not.toHaveBeenCalled();
    expect(h.createComicStory).toHaveBeenCalledOnce();
    expect(h.execute).not.toHaveBeenCalled();
  });
});

describe("POST /api/generate-comic input validation", () => {
  it("rejects an oversized JSON body before reserving generation capacity", async () => {
    const response = await POST(request({
      prompt: "A fox visits Mars",
      characterImages: [validCharacterImage],
      padding: "x".repeat(17_000),
    }));

    expect(response.status).toBe(413);
    expect(h.createComicStory).not.toHaveBeenCalled();
    expect(h.reserveFreeTierQuota).not.toHaveBeenCalled();
  });

  it.each([
    ["omitted", { prompt: "A fox visits Mars" }],
    ["empty", { prompt: "A fox visits Mars", characterImages: [] }],
  ])("requires a reference photo for a new story when references are %s", async (_label, body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Add at least one reference photo before generating your comic.",
    });
    expect(h.reserveFreeTierQuota).not.toHaveBeenCalled();
    expect(h.createComicStory).not.toHaveBeenCalled();
  });

  it("maps a service-level missing-photo error to a clear browser response", async () => {
    h.createComicStory.mockRejectedValue(new ComicServiceError("missing_reference", "Photo required", 400));

    const response = await POST(request({
      prompt: "A fox visits Mars",
      characterImages: [validCharacterImage],
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Add at least one reference photo before generating your comic.",
      errorType: "missing_reference",
    });
    expect(h.releaseFreeTierQuota).toHaveBeenCalledOnce();
  });

  it("allows an approved Google admin with a Studio identity", async () => {
    h.auth.mockResolvedValue({ user: {
      id: "google-admin-user", role: "admin", studioAuthorized: true,
    } });

    const response = await POST(request({
      prompt: "A fox visits Mars",
      characterImages: [validCharacterImage],
    }));

    expect(response.status).toBe(200);
    expect(h.createComicStory).toHaveBeenCalledWith(expect.objectContaining({
      userId: "google-admin-user",
    }));
  });

  it.each([
    ["a password admin", { id: "", role: "admin", studioAuthorized: false }],
    ["an unapproved Google account", { id: "google-user", role: "user", studioAuthorized: false }],
    ["a blank Studio identity", { id: "   ", role: "user", studioAuthorized: true }],
  ])("rejects %s before reserving generation quota", async (_label, user) => {
    h.auth.mockResolvedValue({ user });

    const response = await POST(request({
      prompt: "A fox visits Mars",
      characterImages: [validCharacterImage],
    }));

    expect(response.status).toBe(401);
    expect(h.reserveFreeTierQuota).not.toHaveBeenCalled();
    expect(h.createComicStory).not.toHaveBeenCalled();
  });

  it.each([
    ["non-object JSON", null],
    ["non-string prompt", { prompt: { text: "A fox visits Mars" } }],
    ["blank prompt", { prompt: "   " }],
    ["oversized prompt", { prompt: "x".repeat(MAX_USER_PROMPT + 1) }],
    ["invalid style", { prompt: "A fox visits Mars", style: "watercolor" }],
    ["non-array references", { prompt: "A fox visits Mars", characterImages: "https://account.blob.core.windows.net/comics/fox.png" }],
    ["malformed reference URL", { prompt: "A fox visits Mars", characterImages: ["not a URL"] }],
    ["untrusted reference URL", { prompt: "A fox visits Mars", characterImages: ["https://example.org/fox.png"] }],
    ["too many references", { prompt: "A fox visits Mars", characterImages: Array(3).fill("https://account.blob.core.windows.net/comics/fox.png") }],
    ["malformed continuation ID", { prompt: "A fox visits Mars", storyId: "not-a-uuid" }],
    ["non-boolean continuation flag", { prompt: "A fox visits Mars", isContinuation: "true" }],
    ["non-string context", { prompt: "A fox visits Mars", previousContext: { text: "previous" } }],
  ])("rejects %s before reserving quota", async (_description, body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.createComicStory).not.toHaveBeenCalled();
    expect(h.getStoryById).not.toHaveBeenCalled();
    expect(h.generateComicImage).not.toHaveBeenCalled();
    expect(h.reserveFreeTierQuota).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON before reserving quota", async () => {
    const response = await POST(malformedJsonRequest());

    expect(response.status).toBe(400);
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.reserveFreeTierQuota).not.toHaveBeenCalled();
  });

  it("keeps the missing-prompt response for the browser form", async () => {
    const response = await POST(request({}));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Missing required fields" });
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("accepts an Azure character reference for a new story", async () => {
    const characterImage = "https://account.blob.core.windows.net/comics/fox.png";
    const response = await POST(request({ prompt: "A fox visits Mars", characterImages: [characterImage] }));

    expect(response.status).toBe(200);
    expect(h.createComicStory).toHaveBeenCalledWith(expect.objectContaining({
      characterImageUrls: [characterImage],
    }));
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("accepts a signed media reference produced by the browser upload flow", async () => {
    const characterImage = getBlobPublicUrl("uploads/owner-1/fox.png");
    const response = await POST(request({ prompt: "A fox visits Mars", characterImages: [characterImage] }));

    expect(response.status).toBe(200);
    expect(h.createComicStory).toHaveBeenCalledWith(expect.objectContaining({
      characterImageUrls: [characterImage],
    }));
    expect(h.execute).not.toHaveBeenCalled();
  });
});

describe("POST /api/generate-comic public guest Studio", () => {
  const guestId = "693a8e78-5b98-49e6-9fc2-4b3352ac387a";
  const otherId = "bbf04d09-50c6-4384-bd75-af935129bc78";
  const photoKey = "a1111111-1111-4111-8111-111111111111";

  function guestRequest(images: string[], extra: Record<string, unknown> = {}, origin = "https://comics.example.com") {
    return request({ prompt: "A fox visits Mars", characterImages: images, ...extra }, origin);
  }

  beforeEach(() => {
    h.auth.mockResolvedValue(null);
    h.actor.mockResolvedValue({ userId: guestId, kind: "guest" });
  });

  it("generates from this guest's signed uploaded photo with the server key", async () => {
    const ownPhoto = getBlobPublicUrl(`uploads/${guestId}/${photoKey}.jpg`);

    const response = await POST(guestRequest([ownPhoto]));

    expect(response.status).toBe(200);
    expect(h.createComicStory).toHaveBeenCalledWith(expect.objectContaining({
      userId: guestId,
      apiKey: "test-key",
      characterImageUrls: [ownPhoto],
      usesOwnApiKey: false,
    }));
    expect(h.reserveStudioCapacity).toHaveBeenCalledOnce();
  });

  it("charges a blocked guest generation after its provider call starts", async () => {
    const ownPhoto = getBlobPublicUrl(`uploads/${guestId}/${photoKey}.jpg`);
    h.createComicStory.mockImplementation(async (args) => {
      await args.beforeProviderCall?.();
      throw new ComicServiceError("content_policy", "Image request blocked", 400);
    });

    const response = await POST(guestRequest([ownPhoto]));

    expect(response.status).toBe(400);
    expect(h.markPaidStarted).toHaveBeenCalledOnce();
    expect(h.consumeFreeTierQuota).toHaveBeenCalledOnce();
    expect(h.releaseFreeTierQuota).not.toHaveBeenCalled();
  });

  it("rejects another guest's uploaded photo before spending generation capacity", async () => {
    const otherPhoto = getBlobPublicUrl(`uploads/${otherId}/${photoKey}.jpg`);

    const response = await POST(guestRequest([otherPhoto]));

    expect(response.status).toBe(403);
    expect(h.reserveStudioCapacity).not.toHaveBeenCalled();
    expect(h.createComicStory).not.toHaveBeenCalled();
  });

  it("rejects a caller key so public Studio uses only the server key", async () => {
    const ownPhoto = getBlobPublicUrl(`uploads/${guestId}/${photoKey}.jpg`);

    const response = await POST(guestRequest([ownPhoto], { apiKey: `sk-${"a".repeat(32)}` }));

    expect(response.status).toBe(400);
    expect(h.reserveStudioCapacity).not.toHaveBeenCalled();
    expect(h.createComicStory).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin guest generation request", async () => {
    const ownPhoto = getBlobPublicUrl(`uploads/${guestId}/${photoKey}.jpg`);

    const response = await POST(guestRequest([ownPhoto], {}, "https://attacker.example"));

    expect(response.status).toBe(403);
    expect(h.reserveStudioCapacity).not.toHaveBeenCalled();
    expect(h.createComicStory).not.toHaveBeenCalled();
  });

  it("asks a guest to wait when one of their comics is already drawing", async () => {
    const ownPhoto = getBlobPublicUrl(`uploads/${guestId}/${photoKey}.jpg`);
    h.reserveStudioCapacity.mockResolvedValue({ reason: "busy" });

    const response = await POST(guestRequest([ownPhoto]));

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ isRateLimited: true });
    expect(h.createComicStory).not.toHaveBeenCalled();
  });

  it("returns a clear rolling-rate response before spending on another guest comic", async () => {
    const ownPhoto = getBlobPublicUrl(`uploads/${guestId}/${photoKey}.jpg`);
    h.reserveStudioCapacity.mockResolvedValue({
      reason: "rate_limit",
      scope: "user",
      window: "hour",
      message: "You've made many comic pages in the past hour. Please try again later.",
    });

    const response = await POST(guestRequest([ownPhoto]));

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: "You've made many comic pages in the past hour. Please try again later.",
      errorType: "generation_rate_limit",
      isRateLimited: true,
    });
    expect(h.createComicStory).not.toHaveBeenCalled();
  });
});
