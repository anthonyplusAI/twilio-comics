import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

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
vi.mock("@/lib/blob-storage", () => ({ uploadBufferToBlob: h.uploadBufferToBlob }));

import { POST } from "@/app/api/generate-comic/route";

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

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest("https://comics.example.com/api/generate-comic", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OPENAI_API_KEY = "test-key";
  h.auth.mockResolvedValue({ user: { id: story.userId } });
  h.reserveFreeTierQuota.mockResolvedValue({ allowed: true, remaining: 2, reset: null });
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
    } finally {
      logged.mockRestore();
    }
  });

  it("rejects a generation request before creating a comic when quota is exhausted", async () => {
    h.reserveFreeTierQuota.mockResolvedValue({ allowed: false, remaining: 0, reset: null });

    const response = await POST(request({ prompt: "A fox visits Mars" }));

    expect(response.status).toBe(429);
    expect(h.createComicStory).not.toHaveBeenCalled();
    expect(h.consumeFreeTierQuota).not.toHaveBeenCalled();
  });
});
