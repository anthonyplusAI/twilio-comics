import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  receiveGenerationJob: vi.fn(),
  renewGenerationJob: vi.fn(),
  deleteGenerationJob: vi.fn(),
  processGenerationJob: vi.fn(),
  processInboundMessage: vi.fn(),
  recoverPendingInboundMessages: vi.fn(),
  recoverUnpublishedGenerationJobs: vi.fn(),
  recoverFailedMmsTextFallbacks: vi.fn(),
  Busy: class ConversationLeaseBusyError extends Error {},
}));

vi.mock("@/lib/generation-queue", () => ({
  receiveGenerationJob: h.receiveGenerationJob,
  renewGenerationJob: h.renewGenerationJob,
  deleteGenerationJob: h.deleteGenerationJob,
}));
vi.mock("@/lib/process-generation-job", () => ({
  processGenerationJob: h.processGenerationJob,
}));
vi.mock("@/lib/process-inbound-message", () => ({
  processInboundMessage: h.processInboundMessage,
  ConversationLeaseBusyError: h.Busy,
}));
vi.mock("@/lib/twilio-events", () => ({
  recoverPendingInboundMessages: h.recoverPendingInboundMessages,
}));
vi.mock("@/lib/generation-jobs", () => ({
  recoverUnpublishedGenerationJobs: h.recoverUnpublishedGenerationJobs,
}));
vi.mock("@/lib/twilio-delivery", () => ({
  recoverFailedMmsTextFallbacks: h.recoverFailedMmsTextFallbacks,
}));

const originalRecoveryMode = process.env.RECOVERY_MODE;

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  h.receiveGenerationJob.mockResolvedValue(null);
  h.renewGenerationJob.mockResolvedValue({ popReceipt: "new-receipt" });
  h.deleteGenerationJob.mockResolvedValue(undefined);
  h.processGenerationJob.mockResolvedValue(undefined);
  h.processInboundMessage.mockResolvedValue(undefined);
  h.recoverPendingInboundMessages.mockResolvedValue(0);
  h.recoverUnpublishedGenerationJobs.mockResolvedValue(0);
  h.recoverFailedMmsTextFallbacks.mockResolvedValue(0);
  delete process.env.RECOVERY_MODE;
});

afterEach(() => {
  if (originalRecoveryMode === undefined) delete process.env.RECOVERY_MODE;
  else process.env.RECOVERY_MODE = originalRecoveryMode;
});

describe("Azure Queue worker dispatch", () => {
  it("does not consume a queue message when imported by tests or tooling", async () => {
    await import("@/worker/index");

    expect(h.receiveGenerationJob).not.toHaveBeenCalled();
  });

  it("continues to process and delete legacy generation messages", async () => {
    const worker = await import("@/worker/index");
    const message = {
      version: 1,
      jobId: "job-1",
      messageId: "queue-1",
      popReceipt: "receipt-1",
    };
    h.receiveGenerationJob.mockResolvedValue(message);

    await expect(worker.processNextGenerationJob()).resolves.toBe(true);

    expect(h.processGenerationJob).toHaveBeenCalledWith("job-1");
    expect(h.processInboundMessage).not.toHaveBeenCalled();
    expect(h.deleteGenerationJob).toHaveBeenCalledWith(message);
  });

  it("routes inbound work to the agent and deletes only after completion", async () => {
    const worker = await import("@/worker/index");
    const message = {
      version: 2,
      kind: "inbound",
      messageSid: "SM123",
      messageId: "queue-2",
      popReceipt: "receipt-2",
    };
    h.receiveGenerationJob.mockResolvedValue(message);

    await expect(worker.processNextGenerationJob()).resolves.toBe(true);

    expect(h.processInboundMessage).toHaveBeenCalledWith("SM123");
    expect(h.processGenerationJob).not.toHaveBeenCalled();
    expect(h.deleteGenerationJob).toHaveBeenCalledWith(message);
  });

  it("makes a leased conversation retry soon without deleting its queue item", async () => {
    const worker = await import("@/worker/index");
    const message = {
      version: 2,
      kind: "inbound",
      messageSid: "SM123",
      messageId: "queue-2",
      popReceipt: "receipt-2",
    };
    h.receiveGenerationJob.mockResolvedValue(message);
    h.processInboundMessage.mockRejectedValue(new h.Busy("lease busy"));

    await expect(worker.processNextGenerationJob()).resolves.toBe(true);

    expect(h.renewGenerationJob).toHaveBeenCalledWith(message, 15);
    expect(h.deleteGenerationJob).not.toHaveBeenCalled();
  });

  it("leaves a failed inbound turn available for another queue attempt", async () => {
    const worker = await import("@/worker/index");
    const message = {
      version: 2,
      kind: "inbound",
      messageSid: "SM123",
      messageId: "queue-2",
      popReceipt: "receipt-2",
    };
    h.receiveGenerationJob.mockResolvedValue(message);
    h.processInboundMessage.mockRejectedValue(new Error("Twilio unavailable"));

    await expect(worker.processNextGenerationJob()).rejects.toThrow("Twilio unavailable");

    expect(h.renewGenerationJob).toHaveBeenCalledWith(message, 60);
    expect(h.deleteGenerationJob).not.toHaveBeenCalled();
  });

  it("runs the scheduled receipt recovery sweep without consuming a queue item", async () => {
    process.env.RECOVERY_MODE = "1";
    h.recoverPendingInboundMessages.mockResolvedValue(2);
    const worker = await import("@/worker/index");

    await worker.runWorker();

    expect(h.recoverPendingInboundMessages).toHaveBeenCalledOnce();
    expect(h.recoverUnpublishedGenerationJobs).toHaveBeenCalledOnce();
    expect(h.recoverFailedMmsTextFallbacks).toHaveBeenCalledOnce();
    expect(h.receiveGenerationJob).not.toHaveBeenCalled();
  });

  it("also runs generation recovery when inbound receipt recovery fails", async () => {
    process.env.RECOVERY_MODE = "1";
    h.recoverPendingInboundMessages.mockRejectedValue(new Error("inbound queue unavailable"));
    const worker = await import("@/worker/index");

    await expect(worker.runWorker()).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: "inbound queue unavailable" })],
    });

    expect(h.recoverUnpublishedGenerationJobs).toHaveBeenCalledOnce();
    expect(h.recoverFailedMmsTextFallbacks).toHaveBeenCalledOnce();
  });
});
