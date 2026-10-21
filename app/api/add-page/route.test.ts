import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

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
vi.mock("@/lib/blob-storage", () => ({ uploadBufferToBlob: h.uploadBufferToBlob }));

import { POST } from "@/app/api/add-page/route";

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

function request(pageId: string): NextRequest {
  return new NextRequest("https://comics.example.com/api/add-page", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ storyId: story.slug, pageId, prompt: "A fox visits Mars" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OPENAI_API_KEY = "test-key";
  h.auth.mockResolvedValue({ user: { id: story.userId } });
  h.getStoryWithPagesBySlug.mockResolvedValue({ story, pages: [page] });
  h.reserveFreeTierQuota.mockResolvedValue({ allowed: true, remaining: 2, reset: null });
  h.generateComicImage.mockResolvedValue(Buffer.from("new image"));
  h.uploadBufferToBlob.mockResolvedValue("https://example.com/new.png");
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
});
