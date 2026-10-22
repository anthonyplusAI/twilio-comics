import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
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
  capacityUsed: 0,
  capacityClaims: new Map<string, string>(),
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

const dialect = new PgDialect();

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
  h.capacityUsed = 0;
  h.capacityClaims.clear();
  h.transaction.mockImplementation(async (callback) => callback({ execute: h.execute }));
  h.execute.mockImplementation(async (statement: SQL) => {
    const query = dialect.sqlToQuery(statement);
    if (query.sql.includes("WITH budget_day AS")) {
      return { rows: [{ subject: "system:generation:daily:2026-10-01", used: h.capacityUsed }] };
    }
    if (query.sql.includes("SELECT subject, status FROM free_tier_quota_claims")) {
      const subject = h.capacityClaims.get(String(query.params[0]));
      return { rows: subject ? [{ subject, status: "reserved" }] : [] };
    }
    if (query.sql.includes("INSERT INTO free_tier_quota_claims") &&
        query.sql.includes("RETURNING claim_key")) {
      const claimKey = String(query.params[0]);
      const subject = String(query.params[1]);
      if (h.capacityClaims.has(claimKey)) return { rows: [] };
      h.capacityClaims.set(claimKey, subject);
      h.capacityUsed += 1;
      return { rows: [{ claim_key: claimKey }] };
    }
    return { rows: [] };
  });
  h.auth.mockResolvedValue({ user: { id: story.userId } });
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
      const response = await POST(request({ prompt: "A fox visits Mars" }));

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
      const response = await POST(request({ prompt: "A fox visits Mars" }));

      expect(response.status).toBe(500);
      expect(h.releaseFreeTierQuota).toHaveBeenCalledOnce();
      expect(h.consumeFreeTierQuota).not.toHaveBeenCalled();
      expect(h.capacityUsed).toBe(1);
    } finally {
      logged.mockRestore();
    }
  });

  it("rejects a generation request before creating a comic when quota is exhausted", async () => {
    h.reserveFreeTierQuota.mockResolvedValue({ allowed: false, remaining: 0, reset: null, status: "rejected" });

    const response = await POST(request({ prompt: "A fox visits Mars" }));

    expect(response.status).toBe(429);
    expect(h.createComicStory).not.toHaveBeenCalled();
    expect(h.consumeFreeTierQuota).not.toHaveBeenCalled();
    expect(h.capacityUsed).toBe(0);
  });

  it("rejects an app-funded story when the shared daily budget is exhausted", async () => {
    h.capacityUsed = 25;

    const response = await POST(request({ prompt: "A fox visits Mars" }));

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ errorType: "daily_capacity", isRateLimited: true });
    expect(h.createComicStory).not.toHaveBeenCalled();
    expect(h.releaseFreeTierQuota).toHaveBeenCalledOnce();
    expect(h.capacityUsed).toBe(25);
  });

  it("uses a caller-owned key without spending the app-funded daily budget", async () => {
    h.capacityUsed = 25;
    const ownKey = `sk-${"a".repeat(32)}`;

    const response = await POST(request({ prompt: "A fox visits Mars", apiKey: ownKey }));

    expect(response.status).toBe(200);
    expect(h.createComicStory).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: ownKey,
      usesOwnApiKey: true,
    }));
    expect(h.reserveFreeTierQuota).not.toHaveBeenCalled();
    expect(h.capacityUsed).toBe(25);
  });

  it("does not allow malformed caller-key input to bypass app-funded admission", async () => {
    const response = await POST(request({ prompt: "A fox visits Mars", apiKey: { value: "sk-abc" } }));

    expect(response.status).toBe(400);
    expect(h.createComicStory).not.toHaveBeenCalled();
    expect(h.reserveFreeTierQuota).not.toHaveBeenCalled();
  });

  it("counts a submitted copy of the server key as app-funded", async () => {
    h.capacityUsed = 25;

    const response = await POST(request({ prompt: "A fox visits Mars", apiKey: "test-key" }));

    expect(response.status).toBe(429);
    expect(h.createComicStory).not.toHaveBeenCalled();
  });
});

describe("POST /api/generate-comic input validation", () => {
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
  ])("rejects %s before spending shared capacity", async (_description, body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.createComicStory).not.toHaveBeenCalled();
    expect(h.getStoryById).not.toHaveBeenCalled();
    expect(h.generateComicImage).not.toHaveBeenCalled();
    expect(h.capacityUsed).toBe(0);
  });

  it("rejects malformed JSON before spending shared capacity", async () => {
    const response = await POST(malformedJsonRequest());

    expect(response.status).toBe(400);
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.capacityUsed).toBe(0);
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
    expect(h.capacityUsed).toBe(1);
  });

  it("accepts a signed media reference produced by the browser upload flow", async () => {
    const characterImage = getBlobPublicUrl("uploads/owner-1/fox.png");
    const response = await POST(request({ prompt: "A fox visits Mars", characterImages: [characterImage] }));

    expect(response.status).toBe(200);
    expect(h.createComicStory).toHaveBeenCalledWith(expect.objectContaining({
      characterImageUrls: [characterImage],
    }));
    expect(h.capacityUsed).toBe(1);
  });
});
