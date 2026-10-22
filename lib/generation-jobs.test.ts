import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  insert: vi.fn(),
  select: vi.fn(),
  update: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
  send: vi.fn(),
  reserve: vi.fn(),
  release: vi.fn(),
  recordActivityEvent: vi.fn(),
  beforeSelect: null as null | (() => Promise<void>),
  capacityUsed: 0,
  capacityClaims: new Map<string, string>(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    insert: h.insert,
    select: h.select,
    update: h.update,
    execute: h.execute,
    transaction: h.transaction,
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
  markGenerationJobSuppressed,
  reconcileTerminalGenerationConversations,
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
    status: values.status ?? "pending",
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
  h.capacityUsed = 0;
  h.capacityClaims.clear();
  h.send.mockReset().mockResolvedValue(undefined);
  h.reserve.mockReset().mockResolvedValue({
    allowed: true,
    remaining: 2,
    reset: null,
    status: "reserved",
  });
  h.release.mockReset().mockResolvedValue(undefined);
  h.recordActivityEvent.mockReset().mockResolvedValue(undefined);
  h.execute.mockReset().mockImplementation(async (statement: SQL) => {
    const query = dialect.sqlToQuery(statement);
    if (query.sql.includes("WITH budget_day AS")) {
      return { rows: [{ subject: "system:generation:daily:2026-10-01", used: h.capacityUsed }] };
    }
    if (query.sql.includes("SELECT subject, status FROM free_tier_quota_claims")) {
      const subject = h.capacityClaims.get(String(query.params[0]));
      return { rows: subject ? [{ subject, status: "reserved" }] : [] };
    }
    if (query.sql.includes("INSERT INTO free_tier_quota_claims") &&
        query.sql.includes("RETURNING claim_key")) {
      const claimKey = String(query.params[0]);
      const subject = String(query.params[1]);
      if (h.capacityClaims.has(claimKey)) return { rows: [] };
      h.capacityClaims.set(claimKey, subject);
      h.capacityUsed += 1;
      return { rows: [{ claim_key: claimKey }] };
    }
    return { rows: [] };
  });
  h.transaction.mockReset().mockImplementation(async (callback) => callback({
    execute: h.execute,
    update: h.update,
  }));

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

afterEach(() => vi.unstubAllEnvs());

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
    expect(h.capacityUsed).toBe(0);
    expect(h.release).not.toHaveBeenCalled();
  });

  it("admits a job through a transaction-scoped global UTC-day ledger", async () => {
    const submission = await submitGenerationJob(input);

    expect(submission.accepted).toBe(true);
    expect(h.transaction).toHaveBeenCalledOnce();
    const executor = expect.objectContaining({ execute: h.execute, update: h.update });
    expect(h.reserve).toHaveBeenCalledWith("user-1", submission.job.quotaClaimKey, executor);
    expect(h.capacityUsed).toBe(1);
    expect(h.capacityClaims.size).toBe(1);
    const queries = h.execute.mock.calls.map(([statement]) => dialect.sqlToQuery(statement).sql);
    expect(queries.join("\n")).toMatch(/pg_advisory_xact_lock/);
    expect(queries.join("\n")).toMatch(/transaction_timestamp\(\)/);
    expect(queries.join("\n")).toMatch(/claim\.status = 'reserved'/);
    expect(queries.join("\n")).toMatch(/INSERT INTO free_tier_quota_claims/);
  });

  it("rejects daily capacity without publishing or consuming a weekly slot", async () => {
    h.capacityUsed = 25;

    const submission = await submitGenerationJob(input);

    expect(submission).toMatchObject({ accepted: false, job: {
      status: "quota_rejected",
      lastError: "daily_generation_capacity",
    } });
    expect(h.release).toHaveBeenCalledWith(
      submission.job.quotaClaimKey,
      expect.objectContaining({ execute: h.execute, update: h.update }),
    );
    expect(h.capacityUsed).toBe(25);
    expect(h.capacityClaims.size).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
    expect(h.recordActivityEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: "generation.rejected",
      details: expect.objectContaining({ reason: "daily_generation_capacity" }),
    }));
  });

  it("reuses daily admission on a pending retry after an ambiguous queue send", async () => {
    vi.stubEnv("DAILY_GENERATION_JOB_LIMIT", "1");
    h.send.mockRejectedValueOnce(new Error("Queue response lost"));

    await expect(submitGenerationJob(input)).rejects.toThrow("Queue response lost");
    const retry = await submitGenerationJob(input);

    expect(retry.accepted).toBe(true);
    expect(h.capacityUsed).toBe(1);
    expect(h.capacityClaims.size).toBe(1);
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it("does not report an unadmitted duplicate as accepted", async () => {
    let duplicate: Awaited<ReturnType<typeof submitGenerationJob>> | undefined;
    h.reserve.mockImplementationOnce(async () => {
      duplicate = await submitGenerationJob(input);
      return { allowed: true, remaining: 2, reset: null, status: "reserved" };
    });

    const original = await submitGenerationJob(input);

    expect(duplicate).toMatchObject({ accepted: false, job: { status: "admitting" } });
    expect(original).toMatchObject({ accepted: true, job: { status: "queued" } });
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.capacityUsed).toBe(1);
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

    expect(results.map((result) => result.accepted).sort()).toEqual([false, true]);
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
    expect(duplicate.accepted).toBe(false);
    expect(duplicate.job.status).toBe("pending");
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

  it("recovers a stale unadmitted job before queueing it", async () => {
    h.row = jobRow({
      id: "00000000-0000-4000-8000-000000000001",
      ...input,
      status: "admitting",
      quotaClaimKey: "generation-job:abandoned",
    });
    h.row.leaseOwner = "dead-publisher";
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
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.capacityUsed).toBe(1);
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
    expect(query.sql).toMatch(/failed_job\.story_id IS NULL/);
    expect(query.sql).toMatch(/failed_job\.story_id IS NOT NULL/);
    expect(query.sql).toMatch(/status = 'consumed'/);
    expect(query.sql).toMatch(/status = 'processing'\s+AND .*lease_owner =/);
    expect(query.params).toContain(owner);
    expect(query.params).toContain(jobId);
  });

  it("atomically marks a saved comic suppressed without refunding its weekly credit", async () => {
    const savedStoryId = "00000000-0000-4000-8000-000000000010";
    h.execute.mockResolvedValue({ rows: [{ id: jobId }] });

    await markGenerationJobSuppressed(jobId, owner, "recipient_opted_out", savedStoryId);

    expect(h.execute).toHaveBeenCalledOnce();
    const query = dialect.sqlToQuery(h.execute.mock.calls[0][0] as SQL);
    expect(query.sql).toMatch(/story_id = COALESCE\(j\.story_id,/);
    expect(query.sql).toMatch(/AND \(j\.story_id IS NULL OR j\.story_id =/);
    expect(query.sql).toMatch(/status = 'consumed'/);
    expect(query.sql).toMatch(/failed_job\.story_id IS NULL/);
    expect(query.sql).toMatch(/failed_job\.story_id IS NOT NULL/);
    expect(query.params).toContain(savedStoryId);
    expect(query.params).toContain("recipient_opted_out");
  });

  it("does not change quota when suppression loses its processing lease", async () => {
    h.execute.mockResolvedValue({ rows: [] });

    await expect(markGenerationJobSuppressed(
      jobId, owner, "recipient_opted_out", "00000000-0000-4000-8000-000000000010",
    )).rejects.toBeInstanceOf(GenerationJobLeaseLostError);

    expect(h.execute).toHaveBeenCalledOnce();
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

describe("terminal conversation recovery", () => {
  it("restores a completed story link after any saved result delivery is suppressed", async () => {
    h.execute.mockResolvedValue({ rows: [{ id: "conversation-1" }] });

    const repaired = await reconcileTerminalGenerationConversations(10);

    expect(repaired).toBe(1);
    const query = dialect.sqlToQuery(h.execute.mock.calls[0][0] as SQL);
    expect(query.sql).toMatch(/ready\.status = 'failed' AND ready\.story_id IS NOT NULL/);
    expect(query.sql).not.toContain("ready.last_error = 'recipient_opted_out'");
  });
});
