import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { MAX_USER_PROMPT } from "@/lib/prompt";

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  actor: vi.fn(),
  reserveStudioCapacity: vi.fn(),
  markPaidStarted: vi.fn(),
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
  h.markPaidStarted.mockReset().mockResolvedValue(undefined);
  process.env.OPENAI_API_KEY = "test-key";
  vi.stubEnv("AZURE_STORAGE_CONNECTION_STRING", "");
  vi.stubEnv("AZURE_STORAGE_BLOB_ENDPOINT", "https://account.blob.core.windows.net");
  vi.stubEnv("AZURE_STORAGE_CONTAINER_NAME", "comics");
  vi.stubEnv("PUBLIC_BASE_URL", "https://comics.example.com");
  vi.stubEnv("MEDIA_SIGNING_SECRET", "test-media-signing-secret");
  h.transaction.mockImplementation(async (callback) => callback({ execute: h.execute }));
  h.execute.mockReset().mockResolvedValue({ rows: [] });
  h.auth.mockResolvedValue({ user: { id: story.userId } });
  h.actor.mockImplementation(async () => {
    const userId = (await h.auth())?.user?.id?.trim();
    return userId ? { userId, kind: "google" } : null;
  });
  h.reserveStudioCapacity.mockResolvedValue({
    reason: "accepted",
    quota: { allowed: true, remaining: "unlimited", reset: null, status: "reserved" },
  });
  h.getStoryWithPagesBySlug.mockResolvedValue({ story, pages: [page] });
  h.reserveFreeTierQuota.mockResolvedValue({ allowed: true, remaining: 2, reset: null, status: "reserved" });
  h.generateComicImage.mockResolvedValue(Buffer.from("new image"));
  h.uploadBufferToBlob.mockResolvedValue("https://example.com/new.png");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/add-page Studio capacity", () => {
  it("generates an existing page after reserving one quota claim", async () => {
    const response = await POST(request(page.id));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ pageId: page.id, pageNumber: 2 });
    expect(h.reserveStudioCapacity).toHaveBeenCalledOnce();
    expect(h.reserveFreeTierQuota).not.toHaveBeenCalled();
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
    expect(h.reserveStudioCapacity).not.toHaveBeenCalled();
    expect(h.generateComicImage).not.toHaveBeenCalled();
    expect(h.consumeFreeTierQuota).not.toHaveBeenCalled();
  });

  it("releases a claim if the redraw target disappears after reservation", async () => {
    h.getStoryWithPagesBySlug
      .mockResolvedValueOnce({ story, pages: [page] })
      .mockResolvedValueOnce(null);

    const response = await POST(request(page.id));

    expect(response.status).toBe(404);
    expect(h.reserveStudioCapacity).toHaveBeenCalledOnce();
    expect(h.reserveFreeTierQuota).not.toHaveBeenCalled();
    expect(h.releaseFreeTierQuota).toHaveBeenCalledOnce();
    expect(h.generateComicImage).not.toHaveBeenCalled();
    expect(h.consumeFreeTierQuota).not.toHaveBeenCalled();
  });

  it("rejects another user's story before reserving quota", async () => {
    h.auth.mockResolvedValue({ user: { id: "different-user" } });

    const response = await POST(request(page.id));

    expect(response.status).toBe(403);
    expect(h.reserveStudioCapacity).not.toHaveBeenCalled();
    expect(h.generateComicImage).not.toHaveBeenCalled();
  });

  it("ignores the obsolete daily limit setting for an app-funded redraw", async () => {
    vi.stubEnv("DAILY_GENERATION_JOB_LIMIT", "0");

    const response = await POST(request(page.id));

    expect(response.status).toBe(200);
    expect(h.reserveStudioCapacity).toHaveBeenCalledOnce();
    expect(h.reserveFreeTierQuota).not.toHaveBeenCalled();
    expect(h.generateComicImage).toHaveBeenCalledOnce();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("charges an app-funded redraw after an image-policy failure", async () => {
    h.generateComicImage.mockRejectedValueOnce(new Error("Your request was rejected as a result of our safety system"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(request(page.id));

      expect(response.status).toBe(400);
      expect(h.markPaidStarted).toHaveBeenCalledOnce();
      expect(h.consumeFreeTierQuota).toHaveBeenCalledOnce();
      expect(h.releaseFreeTierQuota).not.toHaveBeenCalled();
      expect(h.execute).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("releases the reservation and skips the provider if the paid-start marker fails", async () => {
    h.markPaidStarted.mockRejectedValue(new Error("Budget write failed"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(request(page.id));

      expect(response.status).toBe(500);
      expect(h.generateComicImage).not.toHaveBeenCalled();
      expect(h.releaseFreeTierQuota).toHaveBeenCalledOnce();
      expect(h.consumeFreeTierQuota).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("uses a caller-owned key without reserving the app-funded weekly quota", async () => {
    const ownKey = `sk-${"a".repeat(32)}`;

    const response = await POST(request(page.id, ownKey));

    expect(response.status).toBe(200);
    expect(h.generateComicImage).toHaveBeenCalledWith(expect.objectContaining({ apiKey: ownKey }));
    expect(h.reserveFreeTierQuota).not.toHaveBeenCalled();
    expect(h.reserveStudioCapacity).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("counts a supplied server key as app-funded", async () => {
    const response = await POST(request(page.id, "test-key"));

    expect(response.status).toBe(200);
    expect(h.reserveStudioCapacity).toHaveBeenCalledOnce();
    expect(h.reserveFreeTierQuota).not.toHaveBeenCalled();
    expect(h.generateComicImage).toHaveBeenCalledOnce();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("ignores a Google owner's exhausted legacy weekly quota", async () => {
    h.reserveFreeTierQuota.mockResolvedValue({ allowed: false, remaining: 0, reset: null, status: "rejected" });

    const response = await POST(request(page.id));

    expect(response.status).toBe(200);
    expect(h.reserveStudioCapacity).toHaveBeenCalledOnce();
    expect(h.reserveFreeTierQuota).not.toHaveBeenCalled();
    expect(h.generateComicImage).toHaveBeenCalledOnce();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("applies the rolling Studio limit to an app-funded Google redraw", async () => {
    h.reserveStudioCapacity.mockResolvedValue({
      reason: "rate_limit",
      scope: "user",
      window: "hour",
      message: "You've made many comic pages in the past hour. Please try again later.",
    });

    const response = await POST(request(page.id));

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ errorType: "generation_rate_limit", isRateLimited: true });
    expect(h.generateComicImage).not.toHaveBeenCalled();
    expect(h.reserveFreeTierQuota).not.toHaveBeenCalled();
  });
});

describe("POST /api/add-page input validation", () => {
  it("rejects an oversized JSON body before loading the story", async () => {
    const response = await POST(requestBody({
      storyId: story.slug,
      pageId: page.id,
      prompt: "A fox visits Mars",
      padding: "x".repeat(17_000),
    }));

    expect(response.status).toBe(413);
    expect(h.getStoryWithPagesBySlug).not.toHaveBeenCalled();
    expect(h.reserveFreeTierQuota).not.toHaveBeenCalled();
  });

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
  ])("rejects %s before reserving quota", async (_description, body) => {
    const response = await POST(requestBody(body));

    expect(response.status).toBe(400);
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.getStoryWithPagesBySlug).not.toHaveBeenCalled();
    expect(h.generateComicImage).not.toHaveBeenCalled();
    expect(h.reserveFreeTierQuota).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON before reserving quota", async () => {
    const response = await POST(malformedJsonRequest());

    expect(response.status).toBe(400);
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.reserveFreeTierQuota).not.toHaveBeenCalled();
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
    expect(h.execute).not.toHaveBeenCalled();
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
    expect(h.execute).not.toHaveBeenCalled();
  });
});

describe("POST /api/add-page for a public Studio guest", () => {
  const guestId = "693a8e78-5b98-49e6-9fc2-4b3352ac387a";
  const otherId = "bbf04d09-50c6-4384-bd75-af935129bc78";
  const firstPage = { ...page, id: "e59f63e3-8820-4728-8795-e0538dd06f17", pageNumber: 1 };
  const originalPhoto = () => getBlobPublicUrl(`uploads/${guestId}/a1111111-1111-4111-8111-111111111111.jpg`);

  beforeEach(() => {
    h.auth.mockResolvedValue(null);
    h.actor.mockResolvedValue({ userId: guestId, kind: "guest" });
    h.getStoryWithPagesBySlug.mockResolvedValue({ story: { ...story, userId: guestId }, pages: [page] });
  });

  it("redraws the guest's own page with the server OpenAI key", async () => {
    const input = request(page.id);
    input.headers.set("origin", "https://comics.example.com");

    const response = await POST(input);

    expect(response.status).toBe(200);
    expect(h.reserveStudioCapacity).toHaveBeenCalledOnce();
    expect(h.generateComicImage).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "test-key" }));
  });

  it("returns a clear rolling-rate response before redrawing another guest page", async () => {
    h.reserveStudioCapacity.mockResolvedValue({
      reason: "rate_limit",
      scope: "source",
      window: "day",
      message: "This network has made many comic pages in the past day. Please try again later.",
    });
    const input = request(page.id);
    input.headers.set("origin", "https://comics.example.com");

    const response = await POST(input);

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: "This network has made many comic pages in the past day. Please try again later.",
      errorType: "generation_rate_limit",
      isRateLimited: true,
    });
    expect(h.generateComicImage).not.toHaveBeenCalled();
  });

  it("includes the authorized original portrait when redrawing page one", async () => {
    h.getStoryWithPagesBySlug.mockResolvedValue({
      story: { ...story, userId: guestId },
      pages: [{ ...firstPage, characterImageUrls: [originalPhoto()] }],
    });
    const input = request(firstPage.id);
    input.headers.set("origin", "https://comics.example.com");

    const response = await POST(input);

    expect(response.status).toBe(200);
    expect(h.generateComicImage).toHaveBeenCalledWith(expect.objectContaining({
      referenceImageUrls: expect.arrayContaining([originalPhoto()]),
    }));
  });

  it("rejects a page-one redraw with no stored original photo before spending capacity", async () => {
    h.getStoryWithPagesBySlug.mockResolvedValue({
      story: { ...story, userId: guestId },
      pages: [{ ...firstPage, characterImageUrls: [] }],
    });
    const input = requestBody({
      storyId: story.slug,
      pageId: firstPage.id,
      prompt: "A fox visits Mars",
      characterImages: [originalPhoto()],
    });
    input.headers.set("origin", "https://comics.example.com");

    const response = await POST(input);

    expect(response.status).toBe(400);
    expect(h.reserveStudioCapacity).not.toHaveBeenCalled();
    expect(h.generateComicImage).not.toHaveBeenCalled();
  });

  it("rejects another guest's stored page-one portrait", async () => {
    const foreignPhoto = getBlobPublicUrl(`uploads/${otherId}/a1111111-1111-4111-8111-111111111111.jpg`);
    h.getStoryWithPagesBySlug.mockResolvedValue({
      story: { ...story, userId: guestId },
      pages: [{ ...firstPage, characterImageUrls: [foreignPhoto] }],
    });
    const input = request(firstPage.id);
    input.headers.set("origin", "https://comics.example.com");

    const response = await POST(input);

    expect(response.status).toBe(400);
    expect(h.reserveStudioCapacity).not.toHaveBeenCalled();
  });

  it("releases capacity if the original portrait disappears during the redraw", async () => {
    h.getStoryWithPagesBySlug
      .mockResolvedValueOnce({ story: { ...story, userId: guestId }, pages: [{ ...firstPage, characterImageUrls: [originalPhoto()] }] })
      .mockResolvedValueOnce({ story: { ...story, userId: guestId }, pages: [{ ...firstPage, characterImageUrls: [] }] });
    const input = request(firstPage.id);
    input.headers.set("origin", "https://comics.example.com");

    const response = await POST(input);

    expect(response.status).toBe(400);
    expect(h.releaseFreeTierQuota).toHaveBeenCalledOnce();
    expect(h.generateComicImage).not.toHaveBeenCalled();
  });

  it("rejects another origin before generating a guest page", async () => {
    const input = request(page.id);
    input.headers.set("origin", "https://attacker.example");

    const response = await POST(input);

    expect(response.status).toBe(403);
    expect(h.reserveStudioCapacity).not.toHaveBeenCalled();
    expect(h.generateComicImage).not.toHaveBeenCalled();
  });

  it("rejects a supplied API key for a guest page", async () => {
    const input = request(page.id, `sk-${"a".repeat(32)}`);
    input.headers.set("origin", "https://comics.example.com");

    const response = await POST(input);

    expect(response.status).toBe(400);
    expect(h.reserveStudioCapacity).not.toHaveBeenCalled();
  });

  it("rejects another guest's reference photo", async () => {
    const otherPhoto = getBlobPublicUrl(`uploads/${otherId}/a1111111-1111-4111-8111-111111111111.jpg`);
    const input = requestBody({
      storyId: story.slug,
      pageId: page.id,
      prompt: "A fox visits Mars",
      characterImages: [otherPhoto],
    });
    input.headers.set("origin", "https://comics.example.com");

    const response = await POST(input);

    expect(response.status).toBe(403);
    expect(h.reserveStudioCapacity).not.toHaveBeenCalled();
  });
});
