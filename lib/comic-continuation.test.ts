import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getStoryWithPages: vi.fn(),
  createPage: vi.fn(),
  updatePage: vi.fn(),
  generateComicImage: vi.fn(),
  blobExists: vi.fn(),
  getBlobPublicUrl: vi.fn(),
  uploadBufferToBlob: vi.fn(),
}));

vi.mock("@/lib/db-actions", () => ({
  getStoryWithPages: h.getStoryWithPages,
  createPage: h.createPage,
  updatePage: h.updatePage,
}));
vi.mock("@/lib/image-generation", () => ({ generateComicImage: h.generateComicImage }));
vi.mock("@/lib/blob-storage", () => ({
  blobExists: h.blobExists,
  getBlobPublicUrl: h.getBlobPublicUrl,
  uploadBufferToBlob: h.uploadBufferToBlob,
}));

import { createComicContinuationPage } from "@/lib/comic-service";

const story = {
  id: "story-1",
  userId: "user-1",
  slug: "moon-dragon",
  title: "Moon Dragon",
  description: "An adventure",
  style: "manga",
};
const firstPage = {
  id: "page-1",
  storyId: story.id,
  pageNumber: 1,
  prompt: "An astronaut finds a dragon on the moon",
  generatedImageUrl: "https://example.com/first-page.png",
  characterImageUrls: [],
};

beforeEach(() => {
  Object.values(h).forEach((mock) => mock.mockReset());
  process.env.OPENAI_API_KEY = "test-key";
  h.getStoryWithPages.mockResolvedValue({ story, pages: [firstPage] });
  h.createPage.mockResolvedValue({
    id: "job-2",
    storyId: story.id,
    pageNumber: 2,
    prompt: "The dragon finds an alien city",
    generatedImageUrl: null,
  });
  h.blobExists.mockResolvedValue(false);
  h.getBlobPublicUrl.mockReturnValue("https://example.com/second-page.png");
  h.generateComicImage.mockResolvedValue(Buffer.from("image"));
  h.uploadBufferToBlob.mockResolvedValue("https://example.com/second-page.png");
  h.updatePage.mockResolvedValue(undefined);
});

describe("createComicContinuationPage", () => {
  it("adds a page to the owned story with prior-page context and references", async () => {
    const result = await createComicContinuationPage({
      userId: "user-1",
      storyId: story.id,
      pageId: "job-2",
      prompt: "The dragon finds an alien city",
      characterImageUrls: ["https://example.com/hero.jpg"],
    });

    expect(h.createPage).toHaveBeenCalledWith(
      expect.objectContaining({ storyId: story.id, id: "job-2", pageNumber: 2 }),
    );
    const imageArgs = h.generateComicImage.mock.calls[0][0];
    expect(imageArgs.referenceImageUrls).toEqual([
      firstPage.generatedImageUrl,
      "https://example.com/hero.jpg",
    ]);
    expect(imageArgs.prompt).toContain(firstPage.prompt);
    expect(imageArgs.prompt).toContain("The dragon finds an alien city");
    expect(result).toMatchObject({
      story: { id: story.id, slug: story.slug },
      page: { id: "job-2", pageNumber: 2 },
      imageUrl: "https://example.com/second-page.png",
    });
  });

  it("returns an already generated page without spending another image call", async () => {
    h.getStoryWithPages.mockResolvedValue({
      story,
      pages: [
        firstPage,
        {
          id: "job-2",
          storyId: story.id,
          pageNumber: 2,
          prompt: "The dragon finds an alien city",
          generatedImageUrl: "https://example.com/second-page.png",
        },
      ],
    });

    const result = await createComicContinuationPage({
      userId: "user-1",
      storyId: story.id,
      pageId: "job-2",
      prompt: "The dragon finds an alien city",
    });
    expect(result.page.pageNumber).toBe(2);
    expect(h.createPage).not.toHaveBeenCalled();
    expect(h.generateComicImage).not.toHaveBeenCalled();
  });

  it("does not include an unfinished retry page in its own history", async () => {
    h.getStoryWithPages.mockResolvedValue({
      story,
      pages: [
        firstPage,
        {
          id: "job-2",
          storyId: story.id,
          pageNumber: 2,
          prompt: "The dragon finds an alien city",
          generatedImageUrl: null,
        },
      ],
    });
    await createComicContinuationPage({
      userId: "user-1",
      storyId: story.id,
      pageId: "job-2",
      prompt: "The dragon finds an alien city",
    });
    const imageArgs = h.generateComicImage.mock.calls[0][0];
    expect(imageArgs.prompt).toContain("Page 1: " + firstPage.prompt);
    expect(imageArgs.prompt).not.toContain("Page 2: The dragon finds an alien city");
    expect(h.createPage).not.toHaveBeenCalled();
  });

  it("rejects a different owner's story before writing or generating", async () => {
    await expect(
      createComicContinuationPage({
        userId: "another-user",
        storyId: story.id,
        pageId: "job-2",
        prompt: "A new page",
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(h.createPage).not.toHaveBeenCalled();
    expect(h.generateComicImage).not.toHaveBeenCalled();
  });
});
