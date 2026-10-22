import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { MAX_USER_PROMPT } from "@/lib/prompt";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  getStoryWithPagesBySlug: vi.fn(),
  getNextPageNumber: vi.fn(),
  createPage: vi.fn(),
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
vi.mock("@/lib/db-actions", () => ({
  getStoryWithPagesBySlug: h.getStoryWithPagesBySlug,
  getNextPageNumber: h.getNextPageNumber,
  createPage: h.createPage,
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

import { POST } from "@/app/api/add-page/route";
import { getBlobPublicUrl } from "@/lib/blob-storage";

const dialect = new PgDialect();

const page = {
  id: "3fd2c1e5-723c-4582-b7da-39b6248d6243",
  pageNumber: 2,
  prompt: "A fox discovers a portal",
  generatedImageUrl: "https://example.com/old.png",
};
const story = {
  id: "79840e5d-60ad-4b68-9e6c-ed6c33253a45",
  slug: "fox-portal",
  userId: "owner-1",
  style: "noir",
};

function request(pageId: string, apiKey?: string): NextRequest {
  return requestBody({
    storyId: story.slug,
    ...(pageId ? { pageId } : {}),
    prompt: "A fox visits Mars",
  }, apiKey);
}

function requestBody(body: unknown, apiKey?: string): NextRequest {
  return new NextRequest("https://comics.example.com/api/add-page", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey !== undefined ? { "x-api-key": apiKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

function malformedJsonRequest(): NextRequest {
  return new NextRequest("https://comics.example.com/api/add-page", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not-json",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.reserveFreeTierQuota.mockReset();
  h.releaseFreeTierQuota.mockReset();
  h.consumeFreeTierQuota.mockReset();
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
  h.getStoryWithPagesBySlug.mockResolvedValue({ story, pages: [page] });
  h.reserveFreeTierQuota.mockResolvedValue({ allowed: true, remaining: 2, reset: null, status: "reserved" });
  h.generateComicImage.mockResolvedValue(Buffer.from("new image"));
  h.uploadBufferToBlob.mockResolvedValue("https://example.com/new.png");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/add-page redraw quota", () => {
  it("generates an existing page after reserving one quota claim", async () => {
    const response = await POST(request(page.id));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ pageId: page.id, pageNumber: 2 });
    expect(h.reserveFreeTierQuota).toHaveBeenCalledOnce();
    expect(h.generateComicImage).toHaveBeenCalledOnce();
    expect(h.updatePage).toHaveBeenCalledWith(page.id, "https://example.com/new.png");
    expect(h.consumeFreeTierQuota).toHaveBeenCalledOnce();
    expect(h.releaseFreeTierQuota).not.toHaveBeenCalled();
  });

  it("returns a saved redraw when consuming its quota claim fails", async () => {
    h.consumeFreeTierQuota.mockRejectedValue(new Error("Quota status write failed"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(request(page.id));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ pageId: page.id });
      expect(h.updatePage).toHaveBeenCalledWith(page.id, "https://example.com/new.png");
      expect(h.releaseFreeTierQuota).not.toHaveBeenCalled();
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("returns a saved new page when consuming its quota claim fails", async () => {
    const newPage = { ...page, id: "284cfccb-f45f-488f-b15e-c326133b2a80", pageNumber: 3 };
    h.getNextPageNumber.mockResolvedValue(3);
    h.createPage.mockResolvedValue(newPage);
    h.consumeFreeTierQuota.mockRejectedValue(new Error("Quota status write failed"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(request(""));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ pageId: newPage.id, pageNumber: 3 });
      expect(h.updatePage).toHaveBeenCalledWith(newPage.id, "https://example.com/new.png");
      expect(h.releaseFreeTierQuota).not.toHaveBeenCalled();
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("rejects an unknown page without spending quota", async () => {
    const response = await POST(request("3e9ed609-1a7e-410c-aa95-a54d23b33448"));

    expect(response.status).toBe(404);
    expect(h.reserveFreeTierQuota).not.toHaveBeenCalled();
    expect(h.generateComicImage).not.toHaveBeenCalled();
    expect(h.consumeFreeTierQuota).not.toHaveBeenCalled();
  });

  it("releases a claim if the redraw target disappears after reservation", async () => {
    h.getStoryWithPagesBySlug
      .mockResolvedValueOnce({ story, pages: [page] })
      .mockResolvedValueOnce(null);

    const response = await POST(request(page.id));

    expect(response.status).toBe(404);
    expect(h.reserveFreeTierQuota).toHaveBeenCalledOnce();
    expect(h.releaseFreeTierQuota).toHaveBeenCalledOnce();
    expect(h.generateComicImage).not.toHaveBeenCalled();
    expect(h.consumeFreeTierQuota).not.toHaveBeenCalled();
  });

  it("rejects another user's story before reserving quota", async () => {
    h.auth.mockResolvedValue({ user: { id: "different-user" } });

    const response = await POST(request(page.id));

    expect(response.status).toBe(403);
    expect(h.reserveFreeTierQuota).not.toHaveBeenCalled();
    expect(h.generateComicImage).not.toHaveBeenCalled();
  });

  it("rejects an app-funded redraw when the shared daily budget is exhausted", async () => {
    h.capacityUsed = 25;

    const response = await POST(request(page.id));

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ errorType: "daily_capacity", isRateLimited: true });
    expect(h.generateComicImage).not.toHaveBeenCalled();
    expect(h.releaseFreeTierQuota).toHaveBeenCalledOnce();
    expect(h.capacityUsed).toBe(25);
  });

  it("keeps daily admission after an app-funded image failure", async () => {
    h.generateComicImage.mockRejectedValueOnce(new Error("OpenAI unavailable"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(request(page.id));

      expect(response.status).toBe(500);
      expect(h.releaseFreeTierQuota).toHaveBeenCalledOnce();
      expect(h.capacityUsed).toBe(1);
    } finally {
      logged.mockRestore();
    }
  });

  it("uses a caller-owned key without spending the app-funded daily budget", async () => {
    h.capacityUsed = 25;
    const ownKey = `sk-${"a".repeat(32)}`;

    const response = await POST(request(page.id, ownKey));

    expect(response.status).toBe(200);
    expect(h.generateComicImage).toHaveBeenCalledWith(expect.objectContaining({ apiKey: ownKey }));
    expect(h.reserveFreeTierQuota).not.toHaveBeenCalled();
    expect(h.capacityUsed).toBe(25);
  });

  it("counts a supplied server key as app-funded", async () => {
    h.capacityUsed = 25;

    const response = await POST(request(page.id, "test-key"));

    expect(response.status).toBe(429);
    expect(h.generateComicImage).not.toHaveBeenCalled();
  });
});

describe("POST /api/add-page input validation", () => {
  it.each([
    ["non-object JSON", null],
    ["non-string prompt", { storyId: story.slug, prompt: 42 }],
    ["blank prompt", { storyId: story.slug, prompt: "   " }],
    ["oversized prompt", { storyId: story.slug, prompt: "x".repeat(MAX_USER_PROMPT + 1) }],
    ["non-string story slug", { storyId: { slug: story.slug }, prompt: "A fox visits Mars" }],
    ["malformed story slug", { storyId: "../admin", prompt: "A fox visits Mars" }],
    ["malformed page ID", { storyId: story.slug, pageId: "not-a-uuid", prompt: "A fox visits Mars" }],
    ["non-array references", { storyId: story.slug, prompt: "A fox visits Mars", characterImages: "https://account.blob.core.windows.net/comics/fox.png" }],
    ["malformed reference URL", { storyId: story.slug, prompt: "A fox visits Mars", characterImages: ["not a URL"] }],
    ["untrusted reference URL", { storyId: story.slug, prompt: "A fox visits Mars", characterImages: ["https://example.org/fox.png"] }],
    ["too many references", { storyId: story.slug, prompt: "A fox visits Mars", characterImages: Array(3).fill("https://account.blob.core.windows.net/comics/fox.png") }],
  ])("rejects %s before spending shared capacity", async (_description, body) => {
    const response = await POST(requestBody(body));

    expect(response.status).toBe(400);
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.getStoryWithPagesBySlug).not.toHaveBeenCalled();
    expect(h.generateComicImage).not.toHaveBeenCalled();
    expect(h.capacityUsed).toBe(0);
  });

  it("rejects malformed JSON before spending shared capacity", async () => {
    const response = await POST(malformedJsonRequest());

    expect(response.status).toBe(400);
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.capacityUsed).toBe(0);
  });

  it("keeps the missing-fields response for the editor", async () => {
    const response = await POST(requestBody({ prompt: "A fox visits Mars" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Missing required fields: storyId and prompt" });
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("accepts an Azure character reference for an editor redraw", async () => {
    const characterImage = "https://account.blob.core.windows.net/comics/fox.png";
    const response = await POST(requestBody({
      storyId: story.slug,
      pageId: page.id,
      prompt: "A fox visits Mars",
      characterImages: [characterImage],
    }));

    expect(response.status).toBe(200);
    expect(h.generateComicImage).toHaveBeenCalledWith(expect.objectContaining({
      referenceImageUrls: expect.arrayContaining([characterImage]),
    }));
    expect(h.capacityUsed).toBe(1);
  });

  it("accepts a signed media reference from an existing editor page", async () => {
    const characterImage = getBlobPublicUrl("uploads/owner-1/fox.png");
    const response = await POST(requestBody({
      storyId: story.slug,
      pageId: page.id,
      prompt: "A fox visits Mars",
      characterImages: [characterImage],
    }));

    expect(response.status).toBe(200);
    expect(h.generateComicImage).toHaveBeenCalledWith(expect.objectContaining({
      referenceImageUrls: expect.arrayContaining([characterImage]),
    }));
    expect(h.capacityUsed).toBe(1);
  });
});
