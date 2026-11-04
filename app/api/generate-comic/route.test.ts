import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { MAX_USER_PROMPT } from "@/lib/prompt";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
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

function request(body: unknown): NextRequest {
  return new NextRequest("https://comics.example.com/api/generate-comic", {
    method: "POST",
    headers: { "content-type": "application/json" },
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
  h.reserveFreeTierQuota.mockResolvedValue({ allowed: true, remaining: 2, reset: null, status: "reserved" });
  h.createComicStory.mockResolvedValue({
    story: { ...story, title: "Fox on Mars" },
    page: { id: page.id, pageNumber: 1 },
    imageUrl: "https://example.com/first.png",
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

describe("POST /api/generate-comic quota after saving", () => {
  it("returns a saved new story when consuming its quota claim fails", async () => {
    h.consumeFreeTierQuota.mockRejectedValue(new Error("Quota status write failed"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(request({ prompt: "A fox visits Mars", characterImages: [validCharacterImage] }));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ storyId: story.id, imageUrl: "https://example.com/first.png" });
      expect(h.createComicStory).toHaveBeenCalledOnce();
      expect(h.reserveFreeTierQuota).toHaveBeenCalledOnce();
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

  it("releases an unused reservation when image generation fails", async () => {
    h.createComicStory.mockRejectedValue(new Error("OpenAI unavailable"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(request({ prompt: "A fox visits Mars", characterImages: [validCharacterImage] }));

      expect(response.status).toBe(500);
      expect(h.releaseFreeTierQuota).toHaveBeenCalledOnce();
      expect(h.consumeFreeTierQuota).not.toHaveBeenCalled();
      expect(h.execute).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("rejects a generation request before creating a comic when quota is exhausted", async () => {
    h.reserveFreeTierQuota.mockResolvedValue({ allowed: false, remaining: 0, reset: null, status: "rejected" });

    const response = await POST(request({ prompt: "A fox visits Mars", characterImages: [validCharacterImage] }));

    expect(response.status).toBe(429);
    expect(h.createComicStory).not.toHaveBeenCalled();
    expect(h.consumeFreeTierQuota).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("ignores the obsolete daily limit setting for an app-funded story", async () => {
    vi.stubEnv("DAILY_GENERATION_JOB_LIMIT", "0");

    const response = await POST(request({ prompt: "A fox visits Mars", characterImages: [validCharacterImage] }));

    expect(response.status).toBe(200);
    expect(h.reserveFreeTierQuota).toHaveBeenCalledOnce();
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
    expect(h.reserveFreeTierQuota).toHaveBeenCalledOnce();
    expect(h.createComicStory).toHaveBeenCalledOnce();
    expect(h.execute).not.toHaveBeenCalled();
  });
});

describe("POST /api/generate-comic input validation", () => {
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
