import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  generateComicImage: vi.fn(),
  generateTitleAndDescription: vi.fn(),
  uploadBufferToBlob: vi.fn(),
  blobExists: vi.fn(),
  getBlobPublicUrl: vi.fn(),
  createStory: vi.fn(),
  createPage: vi.fn(),
  updateStory: vi.fn(),
  updatePage: vi.fn(),
  deleteStory: vi.fn(),
}));

vi.mock("@/lib/image-generation", () => ({ generateComicImage: h.generateComicImage }));
vi.mock("@/lib/title-generation", () => ({ generateTitleAndDescription: h.generateTitleAndDescription }));
vi.mock("@/lib/blob-storage", () => ({
  uploadBufferToBlob: h.uploadBufferToBlob,
  blobExists: h.blobExists,
  getBlobPublicUrl: h.getBlobPublicUrl,
}));
vi.mock("@/lib/db-actions", () => ({
  createStory: h.createStory,
  createPage: h.createPage,
  updateStory: h.updateStory,
  updatePage: h.updatePage,
  deleteStory: h.deleteStory,
}));

import { createComicStory } from "@/lib/comic-service";

beforeEach(() => {
  Object.values(h).forEach((f) => f.mockReset());
  process.env.OPENAI_API_KEY = "test-openai-key";
  h.createStory.mockResolvedValue({ id: "s1", slug: "hero-abcd", title: "temp", description: null });
  h.createPage.mockResolvedValue({ id: "p1", pageNumber: 1, generatedImageUrl: null });
  h.generateComicImage.mockResolvedValue(Buffer.from("png"));
  h.generateTitleAndDescription.mockResolvedValue({ title: "The Rooftop Hero", description: "A hero rises." });
  h.uploadBufferToBlob.mockResolvedValue("https://account.blob.core.windows.net/comics/s1/page-1.png");
  h.blobExists.mockResolvedValue(false);
  h.getBlobPublicUrl.mockReturnValue("https://account.blob.core.windows.net/comics/s1/page-1.png");
  h.updateStory.mockResolvedValue(undefined);
  h.updatePage.mockResolvedValue(undefined);
});

describe("createComicStory", () => {
  it("creates a story + page, generates and uploads image, and returns urls", async () => {
    const res = await createComicStory({
      userId: "+15551234567",
      prompt: "batman on a rooftop",
      source: "sms",
      generateTitle: false,
    });
    expect(h.createStory).toHaveBeenCalledOnce();
    expect(h.createStory.mock.calls[0][0]).toMatchObject({ userId: "+15551234567", source: "sms" });
    expect(h.generateComicImage).toHaveBeenCalledOnce();
    expect(h.uploadBufferToBlob).toHaveBeenCalledOnce();
    expect(h.updatePage).toHaveBeenCalledWith("p1", res.imageUrl);
    expect(res.imageUrl).toContain("page-1.png");
    expect(res.story.slug).toBe("hero-abcd");
  });

  it("passes character image urls to generation as references", async () => {
    await createComicStory({
      userId: "u1", prompt: "x", source: "web", generateTitle: false,
      characterImageUrls: ["https://s3/a.png"],
    });
    expect(h.generateComicImage.mock.calls[0][0].referenceImageUrls).toEqual(["https://s3/a.png"]);
  });

  it("uses a provided OpenAI key", async () => {
    await createComicStory({
      userId: "u1",
      prompt: "x",
      source: "web",
      generateTitle: false,
      apiKey: "user-openai-key",
    });

    expect(h.generateComicImage.mock.calls[0][0].apiKey).toBe("user-openai-key");
  });

  it("deletes the story and throws content_policy on a policy violation", async () => {
    h.generateComicImage.mockRejectedValue(new Error("Your request was rejected as a result of our safety system"));
    await expect(
      createComicStory({ userId: "u1", prompt: "x", source: "web", generateTitle: false }),
    ).rejects.toMatchObject({ type: "content_policy" });
    expect(h.deleteStory).toHaveBeenCalledWith("s1");
  });

  it("maps a 402 to credit_limit and cleans up", async () => {
    const err: any = new Error("insufficient_quota"); err.status = 402;
    h.generateComicImage.mockRejectedValue(err);
    await expect(
      createComicStory({ userId: "u1", prompt: "x", source: "web", generateTitle: false }),
    ).rejects.toMatchObject({ type: "credit_limit" });
    expect(h.deleteStory).toHaveBeenCalledWith("s1");
  });

  it("uses the prompt title and finishes the comic when title generation rejects", async () => {
    h.generateTitleAndDescription.mockRejectedValue(new Error("title service unavailable"));

    const result = await createComicStory({
      userId: "u1",
      prompt: "A hero protects the moon",
      source: "web",
    });

    expect(result.story.title).toBe("A hero protects the moon");
    expect(result.story.description).toBeUndefined();
    expect(result.imageUrl).toContain("page-1.png");
    expect(h.updatePage).toHaveBeenCalledWith("p1", result.imageUrl);
    expect(h.updateStory).toHaveBeenCalledWith("s1", {
      title: "A hero protects the moon",
      description: undefined,
    });
    expect(h.deleteStory).not.toHaveBeenCalled();
  });

  it("removes a blank web story if creating its first page fails", async () => {
    h.createPage.mockRejectedValue(new Error("page write failed"));

    await expect(
      createComicStory({ userId: "u1", prompt: "A moon hero", source: "web", generateTitle: false }),
    ).rejects.toThrow("page write failed");

    expect(h.deleteStory).toHaveBeenCalledWith("s1");
  });

  it("removes a blank web story if its generated image cannot be uploaded", async () => {
    h.uploadBufferToBlob.mockRejectedValue(new Error("blob write failed"));

    await expect(
      createComicStory({ userId: "u1", prompt: "A moon hero", source: "web", generateTitle: false }),
    ).rejects.toThrow("blob write failed");

    expect(h.deleteStory).toHaveBeenCalledWith("s1");
    expect(h.updatePage).not.toHaveBeenCalled();
  });

  it("removes a blank web story if its generated image URL cannot be saved", async () => {
    h.updatePage.mockRejectedValue(new Error("page update failed"));

    await expect(
      createComicStory({ userId: "u1", prompt: "A moon hero", source: "web", generateTitle: false }),
    ).rejects.toThrow("page update failed");

    expect(h.deleteStory).toHaveBeenCalledWith("s1");
  });

  it("keeps a channel story after a page update error so its image can be retried", async () => {
    h.updatePage.mockRejectedValue(new Error("page update failed"));

    await expect(
      createComicStory({
        userId: "u1",
        prompt: "A moon hero",
        source: "sms",
        storyId: "s1",
        pageId: "p1",
        imageKey: "stories/s1/page-1.png",
        preserveOnFailure: true,
        generateTitle: false,
      }),
    ).rejects.toThrow("page update failed");

    expect(h.deleteStory).not.toHaveBeenCalled();
  });
});
