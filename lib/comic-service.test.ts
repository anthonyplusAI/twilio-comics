import { describe, it, expect, vi, beforeEach } from "vitest";
import { APIConnectionError, APIConnectionTimeoutError } from "openai";

const h = vi.hoisted(() => ({
  generateComicImage: vi.fn(),
  generateTitleAndDescription: vi.fn(),
  uploadBufferToBlob: vi.fn(),
  blobExists: vi.fn(),
  getBlobPublicUrl: vi.fn(),
  createStory: vi.fn(),
  createPage: vi.fn(),
  getStoryWithPages: vi.fn(),
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
  getStoryWithPages: h.getStoryWithPages,
  updateStory: h.updateStory,
  updatePage: h.updatePage,
  deleteStory: h.deleteStory,
}));

import { createComicContinuationPage, createComicStory } from "@/lib/comic-service";

const REFERENCE_PHOTO = "https://account.blob.core.windows.net/comics/reference.jpg";

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
  it("awaits the Studio charge marker before starting either provider request", async () => {
    const calls: string[] = [];
    h.generateTitleAndDescription.mockImplementation(async () => {
      calls.push("title");
      return { title: "The Rooftop Hero", description: "A hero rises." };
    });
    h.generateComicImage.mockImplementation(async () => {
      calls.push("image");
      return Buffer.from("png");
    });

    await createComicStory({
      userId: "u1",
      prompt: "A moon hero",
      source: "web",
      characterImageUrls: [REFERENCE_PHOTO],
      beforeProviderCall: async () => { calls.push("charge"); },
    });

    expect(calls).toEqual(["charge", "title", "image"]);
  });

  it("does not call a provider when the Studio charge marker fails", async () => {
    await expect(createComicStory({
      userId: "u1",
      prompt: "A moon hero",
      source: "web",
      characterImageUrls: [REFERENCE_PHOTO],
      beforeProviderCall: async () => { throw new Error("Budget write failed"); },
    })).rejects.toThrow("Budget write failed");

    expect(h.generateTitleAndDescription).not.toHaveBeenCalled();
    expect(h.generateComicImage).not.toHaveBeenCalled();
    expect(h.deleteStory).toHaveBeenCalledWith("s1");
  });

  it.each(["image", "upload"] as const)(
    "keeps the Studio generation active until a parallel title request finishes after %s failure",
    async (failureStage) => {
      let finishTitle!: (value: { title: string; description: string }) => void;
      const pendingTitle = new Promise<{ title: string; description: string }>((resolve) => {
        finishTitle = resolve;
      });
      h.generateTitleAndDescription.mockReturnValue(pendingTitle);
      if (failureStage === "image") {
        h.generateComicImage.mockRejectedValue(new Error("Image request blocked"));
      } else {
        h.uploadBufferToBlob.mockRejectedValue(new Error("Blob write failed"));
      }

      const outcome = createComicStory({
        userId: "u1",
        prompt: "A moon hero",
        source: "web",
        characterImageUrls: [REFERENCE_PHOTO],
        beforeProviderCall: async () => {},
      }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      let settled = false;
      void outcome.then(() => { settled = true; });

      try {
        await vi.waitFor(() => {
          expect(h.deleteStory).toHaveBeenCalledWith("s1");
        });
        await Promise.resolve();
        expect(settled).toBe(false);
      } finally {
        finishTitle({ title: "The Rooftop Hero", description: "A hero rises." });
      }
      expect(await outcome).toMatchObject({ ok: false });
    },
  );

  it.each([[undefined], [[]], [["  "]]])(
    "rejects a new story without a usable reference photo (%j)",
    async (characterImageUrls) => {
      await expect(createComicStory({
        userId: "u1",
        prompt: "A moon hero",
        source: "web",
        characterImageUrls,
      })).rejects.toMatchObject({ type: "missing_reference", status: 400 });
      expect(h.createStory).not.toHaveBeenCalled();
      expect(h.createPage).not.toHaveBeenCalled();
      expect(h.generateComicImage).not.toHaveBeenCalled();
    },
  );

  it("creates a story + page, generates and uploads image, and returns urls", async () => {
    const res = await createComicStory({
      userId: "+15551234567",
      prompt: "batman on a rooftop",
      source: "sms",
      generateTitle: false,
      characterImageUrls: [REFERENCE_PHOTO],
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
    expect(h.generateComicImage.mock.calls[0][0].imageMaxRetries).toBeUndefined();
  });

  it("forwards a phone job's zero-retry image override", async () => {
    await createComicStory({
      userId: "u1", prompt: "x", source: "sms", generateTitle: false,
      characterImageUrls: [REFERENCE_PHOTO], imageMaxRetries: 0,
    });

    expect(h.generateComicImage.mock.calls[0][0].imageMaxRetries).toBe(0);
  });

  it("uses a provided OpenAI key", async () => {
    await createComicStory({
      userId: "u1",
      prompt: "x",
      source: "web",
      generateTitle: false,
      apiKey: "user-openai-key",
      characterImageUrls: [REFERENCE_PHOTO],
    });

    expect(h.generateComicImage.mock.calls[0][0].apiKey).toBe("user-openai-key");
  });

  it("deletes the story and throws content_policy on a policy violation", async () => {
    h.generateComicImage.mockRejectedValue(new Error("Your request was rejected as a result of our safety system"));
    await expect(
      createComicStory({ userId: "u1", prompt: "x", source: "web", generateTitle: false, characterImageUrls: [REFERENCE_PHOTO] }),
    ).rejects.toMatchObject({ type: "content_policy" });
    expect(h.deleteStory).toHaveBeenCalledWith("s1");
  });

  it("treats a generic NO_IMAGE response as an image service error", async () => {
    h.generateComicImage.mockRejectedValue(new Error("NO_IMAGE: no image data returned"));

    await expect(
      createComicStory({ userId: "u1", prompt: "A moon hero", source: "sms", generateTitle: false, characterImageUrls: [REFERENCE_PHOTO] }),
    ).rejects.toMatchObject({ type: "api_error" });
    expect(h.deleteStory).toHaveBeenCalledWith("s1");
  });

  it("preserves only documented moderation details when the image provider blocks a new comic", async () => {
    const error = Object.assign(new Error("Image request blocked"), {
      status: 400,
      code: "moderation_blocked",
      error: {
        type: "image_generation_user_error",
        code: "moderation_blocked",
        moderation_details: {
          moderation_stage: "input",
          categories: ["harassment", "invented_category", "violence"],
        },
      },
    });
    h.generateComicImage.mockRejectedValue(error);

    await expect(
      createComicStory({ userId: "u1", prompt: "x", source: "sms", generateTitle: false, characterImageUrls: [REFERENCE_PHOTO] }),
    ).rejects.toMatchObject({
      type: "content_policy",
      code: "moderation_blocked",
      status: 400,
      moderationDetails: { stage: "input", categories: ["harassment", "violence"] },
    });
  });

  it("does not preserve untrusted moderation labels when provider details are malformed", async () => {
    const error = Object.assign(new Error("Image request blocked"), {
      status: 400,
      code: "moderation_blocked",
      error: {
        moderation_details: {
          moderation_stage: "not-a-stage",
          categories: ["copyright", { secret: "do-not-expose" }],
        },
      },
    });
    h.generateComicImage.mockRejectedValue(error);

    try {
      await createComicStory({ userId: "u1", prompt: "x", source: "sms", generateTitle: false, characterImageUrls: [REFERENCE_PHOTO] });
      throw new Error("Expected generation to fail");
    } catch (caught) {
      expect(caught).toMatchObject({ type: "content_policy", code: "moderation_blocked" });
      expect((caught as { moderationDetails?: unknown }).moderationDetails).toBeUndefined();
    }
  });

  it("maps a 402 to credit_limit and cleans up", async () => {
    const err: any = new Error("insufficient_quota"); err.status = 402;
    h.generateComicImage.mockRejectedValue(err);
    await expect(
      createComicStory({ userId: "u1", prompt: "x", source: "web", generateTitle: false, characterImageUrls: [REFERENCE_PHOTO] }),
    ).rejects.toMatchObject({ type: "credit_limit" });
    expect(h.deleteStory).toHaveBeenCalledWith("s1");
  });

  it.each([
    { name: "generic rate limit", code: undefined, type: undefined },
    { name: "request rate limit", code: "rate_limit_exceeded", type: "rate_limit_error" },
    { name: "slow down", code: "slow_down", type: "rate_limit_error" },
    { name: "specific rate limit with a broad quota type", code: "rate_limit_exceeded", type: "insufficient_quota" },
  ])("keeps a $name 429 retryable", async ({ code, type }) => {
    h.generateComicImage.mockRejectedValue(Object.assign(new Error("Provider busy"), {
      status: 429,
      code,
      type,
    }));

    await expect(createComicStory({
      userId: "u1", prompt: "A moon hero", source: "sms", generateTitle: false,
      characterImageUrls: [REFERENCE_PHOTO],
    })).rejects.toMatchObject({ type: "api_error", status: 429, imageGenerationError: true });
    expect(h.deleteStory).toHaveBeenCalledWith("s1");
  });

  it.each([
    "credit_balance_exhausted",
    "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
    "insufficient_quota",
  ])("keeps hard 429 code %s terminal", async (code) => {
    h.generateComicImage.mockRejectedValue(Object.assign(new Error("Billing limit"), {
      status: 429,
      code,
      type: "insufficient_quota",
    }));

    await expect(createComicStory({
      userId: "u1", prompt: "A moon hero", source: "sms", generateTitle: false,
      characterImageUrls: [REFERENCE_PHOTO],
    })).rejects.toMatchObject({ type: "credit_limit", status: 429 });
  });

  it("recognizes a legacy quota type when a 429 has no specific code", async () => {
    h.generateComicImage.mockRejectedValue(Object.assign(new Error("Billing limit"), {
      status: 429,
      type: "insufficient_quota",
    }));

    await expect(createComicStory({
      userId: "u1", prompt: "A moon hero", source: "sms", generateTitle: false,
      characterImageUrls: [REFERENCE_PHOTO],
    })).rejects.toMatchObject({ type: "credit_limit", status: 429 });
  });

  it("recognizes a hard billing code in an unwrapped provider response", async () => {
    h.generateComicImage.mockRejectedValue(Object.assign(new Error("Billing limit"), {
      status: 429,
      error: { code: "credit_balance_exhausted", type: "insufficient_quota" },
    }));

    await expect(createComicStory({
      userId: "u1", prompt: "A moon hero", source: "sms", generateTitle: false,
      characterImageUrls: [REFERENCE_PHOTO],
    })).rejects.toMatchObject({ type: "credit_limit", status: 429 });
  });

  it("carries a numeric Retry-After hint from a temporary image 429", async () => {
    h.generateComicImage.mockRejectedValue(Object.assign(new Error("Provider busy"), {
      status: 429,
      code: "rate_limit_exceeded",
      headers: new Headers({ "retry-after": "42" }),
    }));

    await expect(createComicStory({
      userId: "u1", prompt: "A moon hero", source: "sms", generateTitle: false,
      characterImageUrls: [REFERENCE_PHOTO],
    })).rejects.toMatchObject({ type: "api_error", status: 429, retryAfterSeconds: 42 });
  });

  it("honors the image API's millisecond retry hint when both headers are present", async () => {
    h.generateComicImage.mockRejectedValue(Object.assign(new Error("Provider busy"), {
      status: 429,
      headers: new Headers({ "retry-after-ms": "45500", "retry-after": "30" }),
    }));

    await expect(createComicStory({
      userId: "u1", prompt: "A moon hero", source: "sms", generateTitle: false,
      characterImageUrls: [REFERENCE_PHOTO],
    })).rejects.toMatchObject({ type: "api_error", status: 429, retryAfterSeconds: 46 });
  });

  it.each([503, 529])("carries Retry-After from an overloaded image %i", async (status) => {
    h.generateComicImage.mockRejectedValue(Object.assign(new Error("Provider busy"), {
      status,
      headers: new Headers({ "retry-after": "35" }),
    }));

    await expect(createComicStory({
      userId: "u1", prompt: "A moon hero", source: "sms", generateTitle: false,
      characterImageUrls: [REFERENCE_PHOTO],
    })).rejects.toMatchObject({
      type: "api_error", status, retryAfterSeconds: 35, imageGenerationError: true,
    });
  });

  it.each([
    ["connection failure", new APIConnectionError({ message: "Connection dropped" })],
    ["connection timeout", new APIConnectionTimeoutError()],
  ])("marks an OpenAI image %s for bounded job retry", async (_label, providerError) => {
    h.generateComicImage.mockRejectedValue(providerError);

    await expect(createComicStory({
      userId: "u1", prompt: "A moon hero", source: "sms", generateTitle: false,
      characterImageUrls: [REFERENCE_PHOTO],
    })).rejects.toMatchObject({
      type: "api_error", imageGenerationError: true, retryableConnection: true,
    });
  });

  it("does not mark a local invalid reference as an OpenAI connection failure", async () => {
    h.generateComicImage.mockRejectedValue(new Error(
      "Reference image must be a configured Azure Blob or signed media URL",
    ));

    await expect(createComicStory({
      userId: "u1", prompt: "A moon hero", source: "sms", generateTitle: false,
      characterImageUrls: [REFERENCE_PHOTO],
    })).rejects.toMatchObject({
      type: "api_error", imageGenerationError: true, retryableConnection: false,
    });
  });

  it("marks an image API conflict separately from a story ownership conflict", async () => {
    h.generateComicImage.mockRejectedValue(Object.assign(new Error("Image API conflict"), {
      status: 409,
    }));

    await expect(createComicStory({
      userId: "u1", prompt: "A moon hero", source: "sms", generateTitle: false,
      characterImageUrls: [REFERENCE_PHOTO],
    })).rejects.toMatchObject({
      type: "api_error", status: 409, imageGenerationError: true,
    });
  });

  it("accepts an HTTP-date Retry-After hint for temporary image 429s", async () => {
    const retryAt = new Date(Date.now() + 90_000).toUTCString();
    h.generateComicImage.mockRejectedValue(Object.assign(new Error("Provider busy"), {
      status: 429,
      code: "rate_limit_exceeded",
      headers: new Headers({ "retry-after": retryAt }),
    }));

    const failure = await createComicStory({
      userId: "u1", prompt: "A moon hero", source: "sms", generateTitle: false,
      characterImageUrls: [REFERENCE_PHOTO],
    }).then(() => null, (error: unknown) => error);
    expect(failure).toMatchObject({ type: "api_error", status: 429 });
    expect((failure as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThanOrEqual(88);
    expect((failure as { retryAfterSeconds: number }).retryAfterSeconds).toBeLessThanOrEqual(90);
  });

  it("uses the prompt title and finishes the comic when title generation rejects", async () => {
    h.generateTitleAndDescription.mockRejectedValue(new Error("title service unavailable"));

    const result = await createComicStory({
      userId: "u1",
      prompt: "A hero protects the moon",
      source: "web",
      characterImageUrls: [REFERENCE_PHOTO],
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
      createComicStory({ userId: "u1", prompt: "A moon hero", source: "web", generateTitle: false, characterImageUrls: [REFERENCE_PHOTO] }),
    ).rejects.toThrow("page write failed");

    expect(h.deleteStory).toHaveBeenCalledWith("s1");
  });

  it("removes a blank web story if its generated image cannot be uploaded", async () => {
    h.uploadBufferToBlob.mockRejectedValue(new Error("blob write failed"));

    await expect(
      createComicStory({ userId: "u1", prompt: "A moon hero", source: "web", generateTitle: false, characterImageUrls: [REFERENCE_PHOTO] }),
    ).rejects.toThrow("blob write failed");

    expect(h.deleteStory).toHaveBeenCalledWith("s1");
    expect(h.updatePage).not.toHaveBeenCalled();
  });

  it("removes a blank web story if its generated image URL cannot be saved", async () => {
    h.updatePage.mockRejectedValue(new Error("page update failed"));

    await expect(
      createComicStory({ userId: "u1", prompt: "A moon hero", source: "web", generateTitle: false, characterImageUrls: [REFERENCE_PHOTO] }),
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
        characterImageUrls: [REFERENCE_PHOTO],
      }),
    ).rejects.toThrow("page update failed");

    expect(h.deleteStory).not.toHaveBeenCalled();
  });
});

describe("createComicContinuationPage", () => {
  it("preserves provider moderation details for a blocked additional page", async () => {
    h.getStoryWithPages.mockResolvedValue({
      story: {
        id: "s1",
        slug: "hero-abcd",
        title: "The Rooftop Hero",
        description: null,
        style: "noir",
        userId: "u1",
      },
      pages: [{
        id: "p1",
        storyId: "s1",
        pageNumber: 1,
        prompt: "A hero appears",
        generatedImageUrl: "https://account.blob.core.windows.net/comics/s1/page-1.png",
      }],
    });
    h.createPage.mockResolvedValue({
      id: "p2",
      storyId: "s1",
      pageNumber: 2,
      prompt: "A second page",
      generatedImageUrl: null,
    });
    h.generateComicImage.mockRejectedValue(Object.assign(new Error("Image request blocked"), {
      status: 400,
      code: "moderation_blocked",
      error: {
        moderation_details: { moderation_stage: "output", categories: ["sexual"] },
      },
    }));

    await expect(createComicContinuationPage({
      userId: "u1",
      storyId: "s1",
      pageId: "p2",
      prompt: "A second page",
      imageMaxRetries: 0,
    })).rejects.toMatchObject({
      type: "content_policy",
      code: "moderation_blocked",
      moderationDetails: { stage: "output", categories: ["sexual"] },
    });
    expect(h.generateComicImage.mock.calls[0][0].imageMaxRetries).toBe(0);
  });
});
