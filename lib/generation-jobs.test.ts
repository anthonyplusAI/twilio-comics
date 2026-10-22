import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  insert: vi.fn(),
  select: vi.fn(),
  update: vi.fn(),
  execute: vi.fn(),
  send: vi.fn(),
  reserve: vi.fn(),
  release: vi.fn(),
  recordActivityEvent: vi.fn(),
  beforeSelect: null as null | (() => Promise<void>),
}));

vi.mock("@/lib/db", () => ({
  db: {
    insert: h.insert,
    select: h.select,
    update: h.update,
    execute: h.execute,
  },
}));
vi.mock("@/lib/generation-queue", () => ({ sendGenerationJob: h.send }));
vi.mock("@/lib/quota", () => ({
  reserveFreeTierQuota: h.reserve,
  releaseFreeTierQuota: h.release,
}));
vi.mock("@/lib/activity-events", () => ({ recordActivityEvent: h.recordActivityEvent }));

import {
  GenerationJobLeaseLostError,
  checkpointGenerationDelivery,
  checkpointGenerationOutput,
  markGenerationJobFailed,
  markGenerationJobSucceeded,
  recoverUnpublishedGenerationJobs,
  returnGenerationJobToQueue,
  submitGenerationJob,
} from "@/lib/generation-jobs";

const dialect = new PgDialect();
const input = {
  idempotencyKey: "twilio-message:SM123",
  userId: "user-1",
  source: "sms" as const,
  recipientAddress: "+15555550123",
  senderAddress: "+15555559876",
  prompt: "Rabbits fly to the moon",
};

function jobRow(values: Record<string, unknown>): Record<string, unknown> {
  const now = new Date("2026-10-01T12:00:00Z");
  return {
    id: values.id,
    idempotencyKey: values.idempotencyKey,
    userId: values.userId,
    source: values.source,
    recipientAddress: values.recipientAddress,
    senderAddress: values.senderAddress,
    prompt: values.prompt,
    style: values.style ?? "noir",
    characterImageUrls: values.characterImageUrls ?? [],
    quotaClaimKey: values.quotaClaimKey,
    status: "pending",
    storyId: null,
    targetStoryId: values.targetStoryId ?? null,
    imageUrl: null,
    deliverySid: null,
    attemptCount: 0,
    leaseOwner: values.leaseOwner ?? null,
    leaseExpiresAt: values.leaseExpiresAt
      ? new Date(Date.now() + 120_000)
      : null,
    lastError: null,
    queuedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function matches(where: SQL | null): boolean {
  if (!h.row || !where) return false;
  const query = dialect.sqlToQuery(where);
  const columnNames: Record<string, string> = {
    id: "id",
    idempotency_key: "idempotencyKey",
    status: "status",
    lease_owner: "leaseOwner",
  };
  for (const match of query.sql.matchAll(/"generation_jobs"\."([a-z_]+)" = \$(\d+)/g)) {
    const [, column, position] = match;
    const key = columnNames[column];
    if (!key || h.row[key] !== query.params[Number(position) - 1]) return false;
  }
  if (
    query.sql.includes('"generation_jobs"."lease_expires_at" is null') &&
    query.sql.includes('"generation_jobs"."lease_expires_at" <')
  ) {
    const lease = h.row.leaseExpiresAt;
    if (lease instanceof Date && lease.getTime() >= Date.now()) return false;
  }
  return true;
}

beforeEach(() => {
  h.row = null;
  h.beforeSelect = null;
  h.send.mockReset().mockResolvedValue(undefined);
  h.reserve.mockReset().mockResolvedValue({
    allowed: true,
    remaining: 2,
    reset: null,
    status: "reserved",
  });
  h.release.mockReset().mockResolvedValue(undefined);
  h.recordActivityEvent.mockReset().mockResolvedValue(undefined);
  h.execute.mockReset().mockResolvedValue({ rows: [] });

  h.insert.mockReset().mockImplementation(() => {
    let values: Record<string, unknown> = {};
    const query = {
      values(inputValues: Record<string, unknown>) {
        values = inputValues;
        return query;
      },
      onConflictDoNothing() {
        return query;
      },
      async returning() {
        if (h.row) return [];
        h.row = jobRow(values);
        return [{ ...h.row }];
      },
    };
    return query;
  });

  h.select.mockReset().mockImplementation(() => {
    let where: SQL | null = null;
    const query = {
      from() {
        return query;
      },
      where(condition: SQL) {
        where = condition;
        return query;
      },
      async limit() {
        const snapshot = matches(where) ? { ...h.row } : null;
        await h.beforeSelect?.();
        return snapshot ? [snapshot] : [];
      },
    };
    return query;
  });

  h.update.mockReset().mockImplementation(() => {
    let values: Record<string, unknown> = {};
    let where: SQL | null = null;
    let executed: Promise<Record<string, unknown>[]> | undefined;
    const run = () => {
      executed ??= Promise.resolve().then(() => {
        if (!matches(where) || !h.row) return [];
        Object.assign(h.row, values);
        return [{ ...h.row }];
      });
      return executed;
    };
    const query = {
      set(inputValues: Record<string, unknown>) {
        values = inputValues;
        return query;
      },
      where(condition: SQL) {
        where = condition;
        return query;
      },
      returning: run,
      then(
        onFulfilled: (rows: Record<string, unknown>[]) => unknown,
        onRejected?: (error: unknown) => unknown,
      ) {
        return run().then(onFulfilled, onRejected);
      },
    };
    return query;
  });
});

describe("submitGenerationJob", () => {
  it("records the request and queue acceptance with the user's prompt and job ID", async () => {
    const submission = await submitGenerationJob(input);

    expect(submission.accepted).toBe(true);
    expect(h.recordActivityEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: `job:${submission.job.id}:requested`,
      kind: "generation.requested",
      userId: "user-1",
      channel: "sms",
      address: "+15555550123",
      content: "Rabbits fly to the moon",
      details: expect.objectContaining({ referenceCount: 0, continuation: false }),
    }));
    expect(h.recordActivityEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: `job:${submission.job.id}:queued`,
      kind: "generation.queued",
      status: "queued",
    }));
  });

  it("records a quota rejection without publishing generation work", async () => {
    h.reserve.mockResolvedValue({ allowed: false, remaining: 0, reset: null, status: "rejected" });

    const submission = await submitGenerationJob(input);

    expect(submission.accepted).toBe(false);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.recordActivityEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: `job:${submission.job.id}:rejected`,
      kind: "generation.rejected",
      status: "quota_rejected",
    }));
  });

  it("still queues generation if the optional activity insert fails", async () => {
    h.recordActivityEvent.mockRejectedValue(new Error("analytics unavailable"));

    const submission = await submitGenerationJob(input);

    expect(submission.accepted).toBe(true);
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.recordActivityEvent).toHaveBeenCalled();
  });

  it("preserves worker processing when the queue delivers before publish returns", async () => {
    h.send.mockImplementation(async (jobId: string) => {
      expect(h.row?.id).toBe(jobId);
      if (!h.row) throw new Error("Missing job");
      h.row.status = "processing";
      h.row.leaseOwner = "worker-1";
    });

    const submission = await submitGenerationJob(input);

    expect(submission.accepted).toBe(true);
    expect(submission.job.status).toBe("processing");
    expect(h.row?.status).toBe("processing");
    expect(h.row?.leaseOwner).toBe("worker-1");
  });

  it("publishes one queue message for simultaneous retries of a failed enqueue", async () => {
    h.row = jobRow({
      id: "00000000-0000-4000-8000-000000000001",
      ...input,
      quotaClaimKey: "generation-job:old-attempt",
    });
    h.row.status = "enqueue_failed";
    h.row.lastError = "Azure Queue was unavailable";

    let releaseReads = () => {};
    const bothRead = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    let reads = 0;
    h.beforeSelect = async () => {
      reads += 1;
      if (reads === 2) releaseReads();
      await bothRead;
    };

    const results = await Promise.all([
      submitGenerationJob(input),
      submitGenerationJob(input),
    ]);

    expect(results.map((result) => result.accepted)).toEqual([true, true]);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.row?.status).toBe("queued");
  });

  it("does not republish a pending job when the same request is repeated", async () => {
    let firstPublishStarted = () => {};
    const started = new Promise<void>((resolve) => {
      firstPublishStarted = resolve;
    });
    let finishFirstPublish = () => {};
    const finish = new Promise<void>((resolve) => {
      finishFirstPublish = resolve;
    });
    h.send
      .mockImplementationOnce(async () => {
        firstPublishStarted();
        await finish;
      })
      .mockResolvedValue(undefined);

    const first = submitGenerationJob(input);
    await started;
    const duplicate = await submitGenerationJob(input);
    finishFirstPublish();
    const original = await first;

    expect(original.accepted).toBe(true);
    expect(duplicate.accepted).toBe(true);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.row?.status).toBe("queued");
  });

  it("persists the target story for a confirmed continuation", async () => {
    await submitGenerationJob({ ...input, targetStoryId: "story-1" });
    expect(h.row?.targetStoryId).toBe("story-1");
  });

  it("retries a pending job whose publisher died before sending", async () => {
    h.row = jobRow({
      id: "00000000-0000-4000-8000-000000000001",
      ...input,
      quotaClaimKey: "generation-job:old-attempt",
    });
    h.row.leaseOwner = "dead-publisher";
    h.row.leaseExpiresAt = new Date(Date.now() - 1_000);

    await submitGenerationJob(input);

    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.row?.status).toBe("queued");
  });

  it("keeps a claimable pending job and quota on ambiguous queue failure", async () => {
    h.send.mockRejectedValue(new Error("Queue response lost"));

    await expect(submitGenerationJob(input)).rejects.toThrow("Queue response lost");

    expect(h.row?.status).toBe("pending");
    expect(h.row?.leaseOwner).toBeNull();
    expect(h.release).not.toHaveBeenCalled();
  });

  it("recovers a pending job abandoned before publication", async () => {
    h.row = jobRow({
      id: "00000000-0000-4000-8000-000000000001",
      ...input,
      quotaClaimKey: "generation-job:old-attempt",
    });
    h.row.leaseExpiresAt = new Date(Date.now() - 60_000);
    h.select.mockImplementationOnce(() => {
      const query = {
        from: () => query,
        where: () => query,
        orderBy: () => query,
        limit: async () => [{ ...h.row }],
      };
      return query;
    });

    const recovered = await recoverUnpublishedGenerationJobs(10);

    expect(recovered).toBe(1);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.row?.status).toBe("queued");
  });
});

describe("processing lease fences", () => {
  const jobId = "00000000-0000-4000-8000-000000000009";
  const owner = "worker-9";
  const data = { storyId: jobId, imageUrl: "https://example.com/page.png", deliverySid: "SMresult" };
  const operations = [
    {
      name: "output checkpoint",
      run: () => checkpointGenerationOutput(jobId, owner, {
        storyId: data.storyId,
        imageUrl: data.imageUrl,
        deliveryHadMedia: true,
      }),
    },
    { name: "delivery checkpoint", run: () => checkpointGenerationDelivery(jobId, owner, data) },
    { name: "success transition", run: () => markGenerationJobSucceeded(jobId, owner, data) },
    { name: "requeue transition", run: () => returnGenerationJobToQueue(jobId, owner, "retry") },
  ];

  it.each(operations)("rejects a stale owner on $name", async ({ run }) => {
    h.row = jobRow({ id: jobId, ...input, quotaClaimKey: "claim-9" });
    h.row.status = "processing";
    h.row.leaseOwner = "newer-worker";

    await expect(run()).rejects.toBeInstanceOf(GenerationJobLeaseLostError);

    expect(h.row.status).toBe("processing");
    expect(h.row.leaseOwner).toBe("newer-worker");
  });

  it.each(operations)("rejects a completed job on $name", async ({ run }) => {
    h.row = jobRow({ id: jobId, ...input, quotaClaimKey: "claim-9" });
    h.row.status = "succeeded";
    h.row.leaseOwner = owner;

    await expect(run()).rejects.toBeInstanceOf(GenerationJobLeaseLostError);

    expect(h.row.status).toBe("succeeded");
  });

  it.each(operations)("accepts the current processing owner on $name", async ({ run }) => {
    h.row = jobRow({ id: jobId, ...input, quotaClaimKey: "claim-9" });
    h.row.status = "processing";
    h.row.leaseOwner = owner;

    await expect(run()).resolves.toBeUndefined();

    expect(h.update).toHaveBeenCalledOnce();
  });

  it("atomically fails an owned job and releases a reserved free quota claim", async () => {
    h.execute.mockResolvedValue({ rows: [{ id: jobId }] });

    await markGenerationJobFailed(jobId, owner, "Permanent image error");

    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.update).not.toHaveBeenCalled();
    expect(h.release).not.toHaveBeenCalled();
    const query = dialect.sqlToQuery(h.execute.mock.calls[0][0] as SQL);
    expect(query.sql).toContain("UPDATE generation_jobs");
    expect(query.sql).toContain("UPDATE free_tier_quota_claims");
    expect(query.sql).toContain("UPDATE free_tier_quotas");
    expect(query.sql).toMatch(/status = 'processing'\s+AND .*lease_owner =/);
    expect(query.params).toContain(owner);
    expect(query.params).toContain(jobId);
  });

  it("does not release quota when the terminal failure loses its lease", async () => {
    h.execute.mockResolvedValue({ rows: [] });

    await expect(markGenerationJobFailed(jobId, owner, "Stale failure"))
      .rejects.toBeInstanceOf(GenerationJobLeaseLostError);

    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.release).not.toHaveBeenCalled();
  });

  it("refuses terminal failure if a delivery callback saved its Message SID", async () => {
    // A status callback can checkpoint the SID after this worker claimed the
    // job. PostgreSQL then returns no failed row and releases no quota.
    h.execute.mockResolvedValue({ rows: [] });

    await expect(markGenerationJobFailed(jobId, owner, "Image service failed"))
      .rejects.toBeInstanceOf(GenerationJobLeaseLostError);

    const query = dialect.sqlToQuery(h.execute.mock.calls[0][0] as SQL);
    expect(query.sql).toMatch(/AND j\.delivery_sid IS NULL/);
    expect(h.release).not.toHaveBeenCalled();
  });
});
