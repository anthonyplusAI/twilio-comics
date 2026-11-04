import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  receiveGenerationJob: vi.fn(),
  renewGenerationJob: vi.fn(),
  deleteGenerationJob: vi.fn(),
  receiveInboundMessage: vi.fn(),
  renewInboundMessage: vi.fn(),
  deleteInboundMessage: vi.fn(),
  verifyInboundQueueAccess: vi.fn(),
  dbExecute: vi.fn(),
  generationModuleImported: vi.fn(),
  processGenerationJob: vi.fn(),
  processInboundMessage: vi.fn(),
  recoverPendingInboundMessages: vi.fn(),
  recoverStalledAgentReplies: vi.fn(),
  recoverUnpublishedGenerationJobs: vi.fn(),
  recoverFailedComicTextFallbacks: vi.fn(),
  Busy: class ConversationLeaseBusyError extends Error {},
  Backlog: class EarlierInboundTurnsPendingError extends Error {},
}));

vi.mock("@/lib/generation-queue", () => ({
  receiveGenerationJob: h.receiveGenerationJob,
  renewGenerationJob: h.renewGenerationJob,
  deleteGenerationJob: h.deleteGenerationJob,
  receiveInboundMessage: h.receiveInboundMessage,
  renewInboundMessage: h.renewInboundMessage,
  deleteInboundMessage: h.deleteInboundMessage,
  verifyInboundQueueAccess: h.verifyInboundQueueAccess,
}));
vi.mock("@/lib/db", () => ({
  db: { execute: h.dbExecute },
}));
vi.mock("@/lib/process-generation-job", () => {
  h.generationModuleImported();
  return { processGenerationJob: h.processGenerationJob };
});
vi.mock("@/lib/process-inbound-message", () => ({
  processInboundMessage: h.processInboundMessage,
  ConversationLeaseBusyError: h.Busy,
  EarlierInboundTurnsPendingError: h.Backlog,
}));
vi.mock("@/lib/twilio-events", () => ({
  recoverPendingInboundMessages: h.recoverPendingInboundMessages,
  recoverStalledAgentReplies: h.recoverStalledAgentReplies,
}));
vi.mock("@/lib/generation-jobs", () => ({
  recoverUnpublishedGenerationJobs: h.recoverUnpublishedGenerationJobs,
}));
vi.mock("@/lib/twilio-delivery", () => ({
  recoverFailedComicTextFallbacks: h.recoverFailedComicTextFallbacks,
}));

const originalRecoveryMode = process.env.RECOVERY_MODE;
const originalWorkerMode = process.env.WORKER_MODE;
const originalInboundWorkerConcurrency = process.env.INBOUND_WORKER_CONCURRENCY;
const requiredInboundEnvironment = [
  "OPENAI_API_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
] as const;
const originalInboundEnvironment = Object.fromEntries(
  requiredInboundEnvironment.map((name) => [name, process.env[name]]),
);

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  h.receiveGenerationJob.mockResolvedValue(null);
  h.receiveInboundMessage.mockResolvedValue(null);
  h.renewGenerationJob.mockResolvedValue({ popReceipt: "new-receipt" });
  h.renewInboundMessage.mockImplementation(async (message: { popReceipt: string }) => ({
    ...message,
    popReceipt: "new-inbound-receipt",
  }));
  h.deleteGenerationJob.mockResolvedValue(undefined);
  h.deleteInboundMessage.mockResolvedValue(undefined);
  h.verifyInboundQueueAccess.mockResolvedValue(undefined);
  h.dbExecute.mockResolvedValue({ rows: [{ one: 1 }] });
  h.processGenerationJob.mockResolvedValue(undefined);
  h.processInboundMessage.mockResolvedValue(undefined);
  h.recoverPendingInboundMessages.mockResolvedValue(0);
  h.recoverStalledAgentReplies.mockResolvedValue({ checked: 0, alerted: 0 });
  h.recoverUnpublishedGenerationJobs.mockResolvedValue(0);
  h.recoverFailedComicTextFallbacks.mockResolvedValue(0);
  delete process.env.RECOVERY_MODE;
  delete process.env.WORKER_MODE;
  delete process.env.INBOUND_WORKER_CONCURRENCY;
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.TWILIO_ACCOUNT_SID = `AC${"a".repeat(32)}`;
  process.env.TWILIO_AUTH_TOKEN = "test-auth-token";
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalRecoveryMode === undefined) delete process.env.RECOVERY_MODE;
  else process.env.RECOVERY_MODE = originalRecoveryMode;
  if (originalWorkerMode === undefined) delete process.env.WORKER_MODE;
  else process.env.WORKER_MODE = originalWorkerMode;
  if (originalInboundWorkerConcurrency === undefined) delete process.env.INBOUND_WORKER_CONCURRENCY;
  else process.env.INBOUND_WORKER_CONCURRENCY = originalInboundWorkerConcurrency;
  for (const name of requiredInboundEnvironment) {
    const value = originalInboundEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("Azure Queue worker dispatch", () => {
  it("does not consume a queue message or load generation code when imported", async () => {
    await import("@/worker/index");

    expect(h.receiveGenerationJob).not.toHaveBeenCalled();
    expect(h.generationModuleImported).not.toHaveBeenCalled();
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

  it("retries a legacy message promptly after draining an earlier-turn batch", async () => {
    const worker = await import("@/worker/index");
    const message = {
      version: 2,
      kind: "inbound",
      messageSid: "SM123",
      messageId: "queue-2",
      popReceipt: "receipt-2",
    };
    h.receiveGenerationJob.mockResolvedValue(message);
    h.processInboundMessage.mockRejectedValue(new h.Backlog("earlier turns remain"));

    await expect(worker.processNextGenerationJob()).resolves.toBe(true);

    expect(h.renewGenerationJob).toHaveBeenCalledWith(message, 1);
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

  it("processes an inbound turn from its dedicated queue without touching generation work", async () => {
    const worker = await import("@/worker/index");
    const message = {
      version: 2,
      kind: "inbound",
      messageSid: "SM123",
      messageId: "inbound-1",
      popReceipt: "receipt-1",
    };
    h.receiveInboundMessage.mockResolvedValue(message);

    await expect(worker.processNextInboundMessage()).resolves.toBe(true);

    expect(h.receiveInboundMessage).toHaveBeenCalledWith(45);
    expect(h.processInboundMessage).toHaveBeenCalledWith("SM123");
    expect(h.deleteInboundMessage).toHaveBeenCalledWith(message);
    expect(h.receiveGenerationJob).not.toHaveBeenCalled();
    expect(h.processGenerationJob).not.toHaveBeenCalled();
  });

  it("records queue wait at worker start without logging the MessageSid", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-04T08:00:00.000Z"));
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const worker = await import("@/worker/index");
    h.receiveInboundMessage.mockResolvedValue({
      version: 2,
      kind: "inbound",
      messageSid: "SM-private",
      messageId: "inbound-1",
      popReceipt: "receipt-1",
      insertedOn: new Date("2026-11-04T07:59:57.500Z"),
    });
    h.processInboundMessage.mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-11-04T08:00:04.000Z"));
    });

    await worker.processNextInboundMessage();

    const logs = info.mock.calls.map(([line]) => JSON.parse(line as string));
    expect(logs).toContainEqual({ event: "inbound_worker_start", queueWaitMs: 2500 });
    expect(logs).toContainEqual({ event: "inbound_worker_processed", processingMs: 4000, outcome: "processed" });
    expect(JSON.stringify(logs)).not.toContain("SM-private");
    info.mockRestore();
  });

  it("renews an active inbound turn and deletes with the latest queue receipt", async () => {
    vi.useFakeTimers();
    const worker = await import("@/worker/index");
    const message = {
      version: 2,
      kind: "inbound",
      messageSid: "SM123",
      messageId: "inbound-1",
      popReceipt: "receipt-1",
    };
    h.receiveInboundMessage.mockResolvedValue(message);
    let finish!: () => void;
    h.processInboundMessage.mockImplementation(() => new Promise<void>((resolve) => {
      finish = resolve;
    }));

    const processing = worker.processNextInboundMessage();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.processInboundMessage).toHaveBeenCalledWith("SM123");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.renewInboundMessage).toHaveBeenCalledWith(message, 45);
    finish();
    await processing;

    expect(h.deleteInboundMessage).toHaveBeenCalledWith({
      ...message,
      popReceipt: "new-inbound-receipt",
    });
  });

  it("releases a busy inbound conversation soon without deleting its receipt", async () => {
    const worker = await import("@/worker/index");
    const message = {
      version: 2,
      kind: "inbound",
      messageSid: "SM123",
      messageId: "inbound-1",
      popReceipt: "receipt-1",
    };
    h.receiveInboundMessage.mockResolvedValue(message);
    h.processInboundMessage.mockRejectedValue(new h.Busy("lease busy"));

    await expect(worker.processNextInboundMessage()).resolves.toBe(true);

    expect(h.renewInboundMessage).toHaveBeenCalledWith(message, 3);
    expect(h.deleteInboundMessage).not.toHaveBeenCalled();
  });

  it("retries the target promptly after draining twelve earlier turns", async () => {
    const worker = await import("@/worker/index");
    const message = {
      version: 2,
      kind: "inbound",
      messageSid: "SM123",
      messageId: "inbound-1",
      popReceipt: "receipt-1",
    };
    h.receiveInboundMessage.mockResolvedValue(message);
    h.processInboundMessage.mockRejectedValue(new h.Backlog("earlier turns remain"));

    await expect(worker.processNextInboundMessage()).resolves.toBe(true);

    expect(h.renewInboundMessage).toHaveBeenCalledWith(message, 1);
    expect(h.deleteInboundMessage).not.toHaveBeenCalled();
  });

  it("retries a failed inbound turn without deleting its receipt", async () => {
    const worker = await import("@/worker/index");
    const message = {
      version: 2,
      kind: "inbound",
      messageSid: "SM123",
      messageId: "inbound-1",
      popReceipt: "receipt-1",
    };
    h.receiveInboundMessage.mockResolvedValue(message);
    h.processInboundMessage.mockRejectedValue(new Error("Twilio unavailable"));

    await expect(worker.processNextInboundMessage()).rejects.toThrow("Twilio unavailable");

    expect(h.renewInboundMessage).toHaveBeenCalledWith(message, 60);
    expect(h.deleteInboundMessage).not.toHaveBeenCalled();
  });

  it("polls the idle inbound queue every five seconds and stops on shutdown", async () => {
    vi.useFakeTimers();
    process.env.WORKER_MODE = "inbound";
    process.env.INBOUND_WORKER_CONCURRENCY = "1";
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const worker = await import("@/worker/index");
    const controller = new AbortController();

    const running = worker.runWorker(controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.receiveInboundMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.receiveInboundMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.receiveInboundMessage).toHaveBeenCalledTimes(2);
    controller.abort();
    await running;

    expect(h.receiveGenerationJob).not.toHaveBeenCalled();
    expect(h.dbExecute).toHaveBeenCalledOnce();
    const query = h.dbExecute.mock.calls[0][0] as { queryChunks: [{ value: string[] }] };
    expect(query.queryChunks[0].value).toEqual(["SELECT 1"]);
    expect(h.verifyInboundQueueAccess.mock.invocationCallOrder[0])
      .toBeLessThan(h.dbExecute.mock.invocationCallOrder[0]);
    expect(h.dbExecute.mock.invocationCallOrder[0])
      .toBeLessThan(info.mock.invocationCallOrder[0]);
    expect(info).toHaveBeenCalledWith(JSON.stringify({ event: "inbound_worker_ready" }));
    info.mockRestore();
  });

  it.each([
    ["default", undefined, 4],
    ["configured", "2", 2],
  ] as const)(
    "runs a bounded number of %s inbound poll loops",
    async (_label, configured, expected) => {
      process.env.WORKER_MODE = "inbound";
      if (configured) process.env.INBOUND_WORKER_CONCURRENCY = configured;
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const worker = await import("@/worker/index");
      const controller = new AbortController();
      const finish: Array<() => void> = [];
      let next = 0;
      h.receiveInboundMessage.mockImplementation(async () => {
        next += 1;
        return {
          version: 2,
          kind: "inbound",
          messageSid: `SM${next}`,
          messageId: `inbound-${next}`,
          popReceipt: `receipt-${next}`,
        };
      });
      h.processInboundMessage.mockImplementation(() => new Promise<void>((resolve) => {
        finish.push(resolve);
      }));

      const running = worker.runWorker(controller.signal);
      try {
        await vi.waitFor(() => expect(h.processInboundMessage).toHaveBeenCalledTimes(expected));
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(h.receiveInboundMessage).toHaveBeenCalledTimes(expected);
        expect(h.processInboundMessage).toHaveBeenCalledTimes(expected);
        expect(h.verifyInboundQueueAccess).toHaveBeenCalledOnce();
        expect(h.dbExecute).toHaveBeenCalledOnce();
        expect(info.mock.calls.filter(([line]) =>
          String(line).includes('"event":"inbound_worker_ready"'))).toHaveLength(1);
      } finally {
        controller.abort();
        for (const release of finish) release();
        await running;
        info.mockRestore();
      }
    },
  );

  it.each(["0", "5", "1.5", "many"])(
    "rejects invalid inbound concurrency %s before polling",
    async (configured) => {
      process.env.WORKER_MODE = "inbound";
      process.env.INBOUND_WORKER_CONCURRENCY = configured;
      const worker = await import("@/worker/index");
      const controller = new AbortController();
      h.receiveInboundMessage.mockImplementation(async () => {
        controller.abort();
        return null;
      });

      await expect(worker.runWorker(controller.signal)).rejects.toThrow(
        "INBOUND_WORKER_CONCURRENCY must be an integer from 1 to 4",
      );
      expect(h.verifyInboundQueueAccess).not.toHaveBeenCalled();
      expect(h.dbExecute).not.toHaveBeenCalled();
      expect(h.receiveInboundMessage).not.toHaveBeenCalled();
    },
  );

  it("finishes an in-flight inbound turn before stopping on shutdown", async () => {
    process.env.WORKER_MODE = "inbound";
    process.env.INBOUND_WORKER_CONCURRENCY = "1";
    const worker = await import("@/worker/index");
    const controller = new AbortController();
    const message = {
      version: 2,
      kind: "inbound",
      messageSid: "SM123",
      messageId: "inbound-1",
      popReceipt: "receipt-1",
    };
    h.receiveInboundMessage.mockResolvedValue(message);
    let finish!: () => void;
    h.processInboundMessage.mockImplementation(() => new Promise<void>((resolve) => {
      finish = resolve;
    }));

    const running = worker.runWorker(controller.signal);
    await vi.waitFor(() => expect(h.processInboundMessage).toHaveBeenCalledWith("SM123"));
    controller.abort();
    expect(h.deleteInboundMessage).not.toHaveBeenCalled();
    finish();
    await running;

    expect(h.deleteInboundMessage).toHaveBeenCalledWith(message);
    expect(h.receiveInboundMessage).toHaveBeenCalledTimes(1);
  });

  it("waits for every active inbound turn before stopping on shutdown", async () => {
    process.env.WORKER_MODE = "inbound";
    process.env.INBOUND_WORKER_CONCURRENCY = "2";
    const worker = await import("@/worker/index");
    const controller = new AbortController();
    const finish: Array<() => void> = [];
    let next = 0;
    h.receiveInboundMessage.mockImplementation(async () => {
      next += 1;
      return {
        version: 2,
        kind: "inbound",
        messageSid: `SM${next}`,
        messageId: `inbound-${next}`,
        popReceipt: `receipt-${next}`,
      };
    });
    h.processInboundMessage.mockImplementation(() => new Promise<void>((resolve) => {
      finish.push(resolve);
    }));

    const running = worker.runWorker(controller.signal);
    let stopped = false;
    void running.then(() => { stopped = true; }, () => { stopped = true; });
    try {
      await vi.waitFor(() => expect(h.processInboundMessage).toHaveBeenCalledTimes(2));
      controller.abort();
      finish[0]();
      await vi.waitFor(() => expect(h.deleteInboundMessage).toHaveBeenCalledTimes(1));
      expect(stopped).toBe(false);
      expect(h.receiveInboundMessage).toHaveBeenCalledTimes(2);

      finish[1]();
      await running;
      expect(stopped).toBe(true);
      expect(h.deleteInboundMessage).toHaveBeenCalledTimes(2);
      expect(h.receiveInboundMessage).toHaveBeenCalledTimes(2);
    } finally {
      controller.abort();
      for (const release of finish) release();
      await running;
    }
  });

  it("fails startup before polling when the inbound queue is unavailable", async () => {
    process.env.WORKER_MODE = "inbound";
    const worker = await import("@/worker/index");
    const controller = new AbortController();
    h.verifyInboundQueueAccess.mockRejectedValue(new Error("Queue access denied"));
    h.receiveInboundMessage.mockImplementation(async () => {
      controller.abort();
      return null;
    });

    await expect(worker.runWorker(controller.signal)).rejects.toThrow("Queue access denied");
    expect(h.receiveInboundMessage).not.toHaveBeenCalled();
    expect(h.dbExecute).not.toHaveBeenCalled();
  });

  it.each(requiredInboundEnvironment)(
    "fails inbound startup before ready when %s is missing",
    async (name) => {
      process.env.WORKER_MODE = "inbound";
      delete process.env[name];
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const worker = await import("@/worker/index");

      await expect(worker.runWorker()).rejects.toThrow(
        `Missing required inbound worker environment variable: ${name}`,
      );

      expect(h.verifyInboundQueueAccess).not.toHaveBeenCalled();
      expect(h.dbExecute).not.toHaveBeenCalled();
      expect(h.receiveInboundMessage).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
    },
  );

  it("fails inbound startup before ready when the database cannot be queried", async () => {
    process.env.WORKER_MODE = "inbound";
    h.dbExecute.mockRejectedValue(new Error("database URL contains secret-value"));
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const worker = await import("@/worker/index");

    await expect(worker.runWorker()).rejects.toThrow("Inbound worker database preflight failed");

    expect(h.verifyInboundQueueAccess).toHaveBeenCalledOnce();
    expect(h.dbExecute).toHaveBeenCalledOnce();
    expect(h.receiveInboundMessage).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("keeps inbound startup checks out of one-shot and recovery modes", async () => {
    for (const name of requiredInboundEnvironment) delete process.env[name];
    process.env.INBOUND_WORKER_CONCURRENCY = "invalid-for-inbound-only";
    h.dbExecute.mockRejectedValue(new Error("database unavailable"));
    const worker = await import("@/worker/index");

    await expect(worker.runWorker()).resolves.toBeUndefined();
    process.env.RECOVERY_MODE = "1";
    await expect(worker.runWorker()).resolves.toBeUndefined();

    expect(h.verifyInboundQueueAccess).not.toHaveBeenCalled();
    expect(h.dbExecute).not.toHaveBeenCalled();
  });

  it("runs the scheduled receipt recovery sweep without consuming a queue item", async () => {
    process.env.RECOVERY_MODE = "1";
    h.recoverPendingInboundMessages.mockResolvedValue(2);
    const worker = await import("@/worker/index");

    await worker.runWorker();

    expect(h.recoverPendingInboundMessages).toHaveBeenCalledOnce();
    expect(h.recoverStalledAgentReplies).toHaveBeenCalledOnce();
    expect(h.recoverUnpublishedGenerationJobs).toHaveBeenCalledOnce();
    expect(h.recoverFailedComicTextFallbacks).toHaveBeenCalledOnce();
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
    expect(h.recoverFailedComicTextFallbacks).toHaveBeenCalledOnce();
  });
});
