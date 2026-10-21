import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  blobExists: vi.fn(),
  getBlobPublicUrl: vi.fn(),
  uploadBufferToBlob: vi.fn(),
  createComicStory: vi.fn(),
  createComicContinuationPage: vi.fn(),
  cleanupFailedContinuationPage: vi.fn(),
  checkpointGenerationDelivery: vi.fn(),
  checkpointGenerationOutput: vi.fn(),
  claimGenerationJob: vi.fn(),
  getGenerationJob: vi.fn(),
  markGenerationJobFailed: vi.fn(),
  markGenerationJobSucceeded: vi.fn(),
  returnGenerationJobToQueue: vi.fn(),
  consumeFreeTierQuota: vi.fn(),
  releaseFreeTierQuota: vi.fn(),
  downloadTwilioMedia: vi.fn(),
  isTwilioMediaUrl: vi.fn(),
  sendChannelMessage: vi.fn(),
  completeConversationForGeneration: vi.fn(),
  failConversationForGeneration: vi.fn(),
  createMmsPreview: vi.fn(),
}));

vi.mock("@/lib/blob-storage", () => ({
  blobExists: h.blobExists,
  getBlobPublicUrl: h.getBlobPublicUrl,
  uploadBufferToBlob: h.uploadBufferToBlob,
}));
vi.mock("@/lib/comic-service", () => ({
  ComicServiceError: class ComicServiceError extends Error {
    type: string;
    status?: number;
    constructor(type: string, message: string, status?: number) {
      super(message);
      this.type = type;
      this.status = status;
    }
  },
  createComicStory: h.createComicStory,
  createComicContinuationPage: h.createComicContinuationPage,
  cleanupFailedContinuationPage: h.cleanupFailedContinuationPage,
}));
vi.mock("@/lib/generation-jobs", () => ({
  GenerationJobLeaseLostError: class GenerationJobLeaseLostError extends Error {
    constructor(jobId: string) {
      super(`Generation job lease lost: ${jobId}`);
      this.name = "GenerationJobLeaseLostError";
    }
  },
  checkpointGenerationDelivery: h.checkpointGenerationDelivery,
  checkpointGenerationOutput: h.checkpointGenerationOutput,
  claimGenerationJob: h.claimGenerationJob,
  getGenerationJob: h.getGenerationJob,
  markGenerationJobFailed: h.markGenerationJobFailed,
  markGenerationJobSucceeded: h.markGenerationJobSucceeded,
  returnGenerationJobToQueue: h.returnGenerationJobToQueue,
}));
vi.mock("@/lib/quota", () => ({
  consumeFreeTierQuota: h.consumeFreeTierQuota,
  releaseFreeTierQuota: h.releaseFreeTierQuota,
}));
vi.mock("@/lib/twilio", () => ({
  downloadTwilioMedia: h.downloadTwilioMedia,
  isTwilioMediaUrl: h.isTwilioMediaUrl,
  sendChannelMessage: h.sendChannelMessage,
}));
vi.mock("@/lib/db-actions", () => ({
  completeConversationForGeneration: h.completeConversationForGeneration,
  failConversationForGeneration: h.failConversationForGeneration,
}));
vi.mock("@/lib/mms-preview", () => ({ createMmsPreview: h.createMmsPreview }));

import { ComicServiceError } from "@/lib/comic-service";
import { GenerationJobLeaseLostError } from "@/lib/generation-jobs";
import { processGenerationJob } from "@/lib/process-generation-job";

const job = {
  id: "00000000-0000-4000-8000-000000000002",
  idempotencyKey: "twilio-message:SM123",
  userId: "user-1",
  source: "sms",
  recipientAddress: "+15551230000",
  senderAddress: "+15550000000",
  prompt: "A dragon visits Mars",
  style: "manga",
  characterImageUrls: [],
  targetStoryId: null,
  quotaClaimKey: "generation-job:one",
  deliverySid: null,
  attemptCount: 1,
};

beforeEach(() => {
  Object.values(h).forEach((mock) => mock.mockReset());
  process.env.PUBLIC_BASE_URL = "https://comics.example.com";
  h.claimGenerationJob.mockResolvedValue(job);
  h.getGenerationJob.mockResolvedValue(job);
  h.createComicStory.mockResolvedValue({
    story: { id: "story-1", slug: "mars-dragon", title: "Mars Dragon" },
    page: { id: job.id, pageNumber: 1 },
    imageUrl: "https://comics.example.com/api/media?key=page1",
  });
  h.createComicContinuationPage.mockResolvedValue({
    story: { id: "story-1", slug: "mars-dragon", title: "Mars Dragon" },
    page: { id: job.id, pageNumber: 2 },
    imageUrl: "https://comics.example.com/api/media?key=page2",
  });
  h.createMmsPreview.mockResolvedValue("https://comics.example.com/api/media?key=preview");
  h.sendChannelMessage.mockResolvedValue("SMresult");
  h.completeConversationForGeneration.mockResolvedValue(true);
  h.failConversationForGeneration.mockResolvedValue(true);
  h.blobExists.mockResolvedValue(false);
  h.getBlobPublicUrl.mockReturnValue("https://comics.example.com/api/media?key=ref");
});

describe("processGenerationJob", () => {
  it("creates and delivers the first page with a tracked MMS preview", async () => {
    await processGenerationJob(job.id);

    expect(h.createComicStory).toHaveBeenCalledWith(
      expect.objectContaining({ userId: job.userId, prompt: job.prompt, style: job.style }),
    );
    expect(h.createMmsPreview).toHaveBeenCalledOnce();
    expect(h.checkpointGenerationOutput).toHaveBeenCalledWith(job.id, expect.any(String), {
      storyId: "story-1",
      imageUrl: "https://comics.example.com/api/media?key=page1",
      deliveryHadMedia: true,
    });
    expect(h.sendChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaUrl: "https://comics.example.com/api/media?key=preview",
        statusCallback: `https://comics.example.com/api/twilio/status?jobId=${job.id}#rc=3&rp=5xx,ct,rt`,
      }),
    );
    expect(h.completeConversationForGeneration).toHaveBeenCalledWith(job, "story-1");
    expect(h.markGenerationJobSucceeded).toHaveBeenCalledOnce();
  });

  it("continues the owned story and announces the new page number", async () => {
    h.claimGenerationJob.mockResolvedValue({ ...job, targetStoryId: "story-1" });
    await processGenerationJob(job.id);

    expect(h.createComicContinuationPage).toHaveBeenCalledWith(
      expect.objectContaining({
        storyId: "story-1",
        pageId: job.id,
        userId: job.userId,
      }),
    );
    expect(h.createComicStory).not.toHaveBeenCalled();
    expect(h.sendChannelMessage.mock.calls[0][0].body).toContain("Page 2");
  });

  it("marks a completed voice conversation without touching a newer draft", async () => {
    h.claimGenerationJob.mockResolvedValue({ ...job, source: "voice" });
    await processGenerationJob(job.id);
    expect(h.completeConversationForGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ source: "voice" }),
      "story-1",
    );
  });

  it("treats a duplicate queue message during active processing as handled", async () => {
    h.claimGenerationJob.mockResolvedValue(null);
    h.getGenerationJob.mockResolvedValue({ ...job, status: "processing" });
    await expect(processGenerationJob(job.id)).resolves.toBeUndefined();
    expect(h.sendChannelMessage).not.toHaveBeenCalled();
  });

  it("finishes a checkpointed delivery without regenerating its comic or sending again", async () => {
    const delivered = {
      ...job,
      attemptCount: 3,
      storyId: "story-1",
      imageUrl: "https://comics.example.com/api/media?key=page1",
      deliverySid: "SMalreadyaccepted",
    };
    h.claimGenerationJob.mockResolvedValue(delivered);
    h.createComicStory.mockRejectedValue(new Error("OpenAI is unavailable"));
    h.blobExists.mockRejectedValue(new Error("Blob storage is unavailable"));

    await processGenerationJob(job.id);

    expect(h.blobExists).not.toHaveBeenCalled();
    expect(h.createComicStory).not.toHaveBeenCalled();
    expect(h.createComicContinuationPage).not.toHaveBeenCalled();
    expect(h.sendChannelMessage).not.toHaveBeenCalled();
    expect(h.consumeFreeTierQuota).toHaveBeenCalledExactlyOnceWith(job.quotaClaimKey);
    expect(h.markGenerationJobSucceeded).toHaveBeenCalledWith(
      job.id,
      expect.any(String),
      { storyId: delivered.storyId, imageUrl: delivered.imageUrl, deliverySid: delivered.deliverySid },
    );
    expect(h.completeConversationForGeneration).toHaveBeenCalledWith(delivered, delivered.storyId);
    expect(h.markGenerationJobFailed).not.toHaveBeenCalled();
  });

  it("requeues a checkpointed delivery if the quota checkpoint fails", async () => {
    h.claimGenerationJob.mockResolvedValue({
      ...job,
      attemptCount: 3,
      storyId: "story-1",
      imageUrl: "https://comics.example.com/api/media?key=page1",
      deliverySid: "SMalreadyaccepted",
    });
    h.consumeFreeTierQuota.mockRejectedValue(new Error("DB temporarily unavailable"));

    await expect(processGenerationJob(job.id)).rejects.toThrow("DB temporarily unavailable");

    expect(h.returnGenerationJobToQueue).toHaveBeenCalledOnce();
    expect(h.sendChannelMessage).not.toHaveBeenCalled();
    expect(h.markGenerationJobFailed).not.toHaveBeenCalled();
    expect(h.failConversationForGeneration).not.toHaveBeenCalled();
  });

  it("sends the story link when a preview cannot be produced", async () => {
    h.createMmsPreview.mockRejectedValue(new Error("JPEG conversion failed"));
    await processGenerationJob(job.id);
    expect(h.sendChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({ mediaUrl: undefined, body: expect.stringContaining("https://comics.example.com/story/") }),
    );
    expect(h.markGenerationJobSucceeded).toHaveBeenCalledOnce();
  });

  it("sends a text link if Twilio rejects the media at submission", async () => {
    h.sendChannelMessage
      .mockRejectedValueOnce(Object.assign(new Error("Invalid media URL"), { code: 21620 }))
      .mockResolvedValueOnce("SMtext");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await processGenerationJob(job.id);
    } finally {
      warn.mockRestore();
    }
    expect(h.sendChannelMessage).toHaveBeenCalledTimes(2);
    expect(h.sendChannelMessage.mock.calls[0][0].mediaUrl).toContain("preview");
    expect(h.sendChannelMessage.mock.calls[1][0].mediaUrl).toBeUndefined();
    expect(h.checkpointGenerationOutput).toHaveBeenLastCalledWith(job.id, expect.any(String), {
      storyId: "story-1",
      imageUrl: "https://comics.example.com/api/media?key=page1",
      deliveryHadMedia: false,
    });
    expect(h.markGenerationJobSucceeded).toHaveBeenCalledOnce();
  });

  it("does not report generation failure after Twilio accepted the result", async () => {
    h.checkpointGenerationDelivery.mockRejectedValue(new Error("DB temporarily unavailable"));
    h.claimGenerationJob.mockResolvedValue({ ...job, attemptCount: 3 });
    await expect(processGenerationJob(job.id)).rejects.toThrow("DB temporarily unavailable");
    expect(h.returnGenerationJobToQueue).toHaveBeenCalledOnce();
    expect(h.markGenerationJobFailed).not.toHaveBeenCalled();
    expect(h.releaseFreeTierQuota).not.toHaveBeenCalled();
    expect(h.sendChannelMessage).toHaveBeenCalledOnce();
    expect(h.failConversationForGeneration).not.toHaveBeenCalled();
  });

  it("stops before sending when a newer worker owns the output checkpoint", async () => {
    h.checkpointGenerationOutput.mockRejectedValue(new GenerationJobLeaseLostError(job.id));

    await expect(processGenerationJob(job.id)).resolves.toBeUndefined();

    expect(h.sendChannelMessage).not.toHaveBeenCalled();
    expect(h.returnGenerationJobToQueue).not.toHaveBeenCalled();
    expect(h.markGenerationJobFailed).not.toHaveBeenCalled();
    expect(h.failConversationForGeneration).not.toHaveBeenCalled();
  });

  it("treats the third OpenAI API error as terminal", async () => {
    h.claimGenerationJob.mockResolvedValue({ ...job, attemptCount: 3 });
    h.createComicStory.mockRejectedValue(new ComicServiceError("api_error", "OpenAI unavailable", 503));

    await processGenerationJob(job.id);

    expect(h.markGenerationJobFailed).toHaveBeenCalledWith(
      job.id,
      expect.any(String),
      "OpenAI unavailable",
    );
    expect(h.returnGenerationJobToQueue).not.toHaveBeenCalled();
  });

  it("does not notify or reset a draft if the terminal update lost its lease", async () => {
    h.claimGenerationJob.mockResolvedValue({ ...job, attemptCount: 3 });
    h.createComicStory.mockRejectedValue(new Error("Image service failed"));
    h.markGenerationJobFailed.mockRejectedValue(new GenerationJobLeaseLostError(job.id));

    await expect(processGenerationJob(job.id)).resolves.toBeUndefined();

    expect(h.sendChannelMessage).not.toHaveBeenCalled();
    expect(h.cleanupFailedContinuationPage).not.toHaveBeenCalled();
    expect(h.failConversationForGeneration).not.toHaveBeenCalled();
  });

  it("removes only the blank continuation page after terminal generation failure", async () => {
    h.claimGenerationJob.mockResolvedValue({ ...job, targetStoryId: "story-1", attemptCount: 3 });
    h.createComicContinuationPage.mockRejectedValue(new Error("Image service failed"));
    await processGenerationJob(job.id);
    expect(h.markGenerationJobFailed).toHaveBeenCalledWith(
      job.id,
      expect.any(String),
      "Image service failed",
    );
    expect(h.cleanupFailedContinuationPage).toHaveBeenCalledWith({
      userId: job.userId,
      storyId: "story-1",
      pageId: job.id,
    });
    expect(h.releaseFreeTierQuota).not.toHaveBeenCalled();
  });
});
