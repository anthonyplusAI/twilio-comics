import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const execute = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({ db: { execute } }));

import {
  getFreeTierQuota,
  releaseFreeTierQuota,
  reserveFreeTierQuota,
} from "@/lib/quota";

beforeEach(() => {
  execute.mockReset();
});

const dialect = new PgDialect();

function queryAt(index: number): string {
  return dialect.sqlToQuery(execute.mock.calls[index][0]).sql;
}

describe("Postgres generation quota", () => {
  it("returns the default allowance when a player has no usage or override", async () => {
    execute.mockResolvedValue({
      rows: [{ used: null, window_started_at: null, generation_limit: 3 }],
    });
    await expect(getFreeTierQuota("user-1")).resolves.toEqual({
      remaining: 3,
      reset: null,
    });
    expect(queryAt(0)).toMatch(/generation_quota_limit/);
  });

  it("applies a changed custom limit to usage already in the current window", async () => {
    const start = new Date();
    execute
      .mockResolvedValueOnce({ rows: [{ used: 4, window_started_at: start, generation_limit: 2 }] })
      .mockResolvedValueOnce({ rows: [{ used: 4, window_started_at: start, generation_limit: 8 }] });

    const lowered = await getFreeTierQuota("user-1");
    const raised = await getFreeTierQuota("user-1");

    expect(lowered).toEqual({ remaining: 0, reset: start.getTime() + 7 * 86_400_000 });
    expect(raised).toEqual({ remaining: 4, reset: start.getTime() + 7 * 86_400_000 });
  });

  it("shows unlimited even when a player already used credits this week", async () => {
    execute.mockResolvedValue({
      rows: [{ used: 12, window_started_at: new Date(), generation_limit: -1 }],
    });

    const quota = await getFreeTierQuota("user-1");

    expect(quota.remaining).toBe("unlimited");
  });

  it("shows zero before any generation when a player's limit is zero", async () => {
    execute.mockResolvedValue({
      rows: [{ used: null, window_started_at: null, generation_limit: 0 }],
    });

    await expect(getFreeTierQuota("user-1")).resolves.toEqual({
      remaining: 0,
      reset: null,
    });
  });

  it("uses a player's custom limit for a new reservation", async () => {
    execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [{
        subject: "user-1",
        status: "reserved",
        used: 1,
        window_started_at: new Date(),
        generation_limit: 10,
      }],
    });

    const result = await reserveFreeTierQuota("user-1", "custom-claim");

    expect(result).toMatchObject({ allowed: true, remaining: 9, status: "reserved" });
  });

  it("rejects the first reservation when the player's limit is zero", async () => {
    execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        subject: "user-1",
        status: "rejected",
        used: null,
        window_started_at: null,
        generation_limit: 0,
      }] })
      .mockResolvedValueOnce({
        rows: [{ used: null, window_started_at: null, generation_limit: 0 }],
      });

    const result = await reserveFreeTierQuota("user-1", "paused-claim");

    expect(result).toMatchObject({ allowed: false, remaining: 0, status: "rejected" });
    expect(execute).toHaveBeenCalledTimes(3);
    expect(queryAt(1)).toMatch(/effective_limit\.generation_limit = -1 OR effective_limit\.generation_limit > 0/);
  });

  it("tracks unlimited reservations and reads current usage on idempotent retries", async () => {
    const start = new Date();
    execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        subject: "user-1",
        status: "reserved",
        used: 4,
        window_started_at: start,
        generation_limit: -1,
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        subject: "user-1",
        status: "reserved",
        used: null,
        window_started_at: start,
        generation_limit: -1,
      }] })
      .mockResolvedValueOnce({
        rows: [{ used: 4, window_started_at: start, generation_limit: -1 }],
      });

    const first = await reserveFreeTierQuota("user-1", "unlimited-claim");
    const retry = await reserveFreeTierQuota("user-1", "unlimited-claim");

    expect(first).toMatchObject({ allowed: true, remaining: "unlimited", status: "reserved" });
    expect(retry).toMatchObject({ allowed: true, remaining: "unlimited", status: "reserved" });
    expect(execute).toHaveBeenCalledTimes(5);
    expect(queryAt(1)).toMatch(/INSERT INTO free_tier_quotas/);
    expect(queryAt(1)).toMatch(/WHERE locked_claim.status = 'pending'/);
    expect(queryAt(1)).toMatch(/OR \(SELECT generation_limit FROM effective_limit\) = -1/);
    expect(queryAt(3)).toMatch(/WHERE locked_claim.status = 'pending'/);
  });

  it("finalizes a newly inserted claim in a separate statement", async () => {
    const start = new Date();
    execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [
        { subject: "user-1", status: "reserved", used: 1, window_started_at: start, generation_limit: 3 },
      ],
    });
    const result = await reserveFreeTierQuota("user-1", "claim-1");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
    expect(result.reset).toBe(start.getTime() + 7 * 86_400_000);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(queryAt(0)).toMatch(/INSERT INTO free_tier_quota_claims/);
    expect(queryAt(0)).toMatch(/ON CONFLICT \(claim_key\) DO NOTHING/);
    expect(queryAt(0)).not.toMatch(/UPDATE free_tier_quota_claims/);
    expect(queryAt(1)).toMatch(/FROM users[\s\S]*FOR SHARE/);
    expect(queryAt(1)).toMatch(/FROM free_tier_quota_claims[\s\S]*FOR UPDATE/);
    expect(queryAt(1)).toMatch(/FROM locked_claim[\s\S]*status = 'pending'/);
    expect(queryAt(1)).toMatch(/RETURNING[\s\S]*status/);
  });

  it("returns a rejected reservation without spending", async () => {
    const start = new Date();
    execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [
        {
          subject: "user-1",
          status: "rejected",
          used: null,
          window_started_at: start,
          generation_limit: 3,
        },
      ],
    }).mockResolvedValueOnce({ rows: [{ used: 3, window_started_at: start, generation_limit: 3 }] });
    const result = await reserveFreeTierQuota("user-1", "claim-4");
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("reuses a consumed claim without another quota increment", async () => {
    const start = new Date();
    execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [{ subject: "user-1", status: "consumed", used: null, window_started_at: start, generation_limit: 3 }],
    }).mockResolvedValueOnce({ rows: [{ used: 1, window_started_at: start, generation_limit: 3 }] });

    const result = await reserveFreeTierQuota("user-1", "claim-1");

    expect(result).toMatchObject({ allowed: true, remaining: 2, status: "consumed" });
    expect(queryAt(1)).toMatch(/status = 'pending'/);
    expect(queryAt(1)).toMatch(/NOT EXISTS \(SELECT 1 FROM finalized_claim\)/);
  });

  it("handles concurrent duplicate calls using the claim lock and one quota result", async () => {
    const start = new Date();
    let finalized = 0;
    execute.mockImplementation(async (statement) => {
      const query = dialect.sqlToQuery(statement).sql;
      if (query.includes("INSERT INTO free_tier_quota_claims")) {
        return { rows: [] };
      }
      if (query.includes("locked_claim AS MATERIALIZED")) {
        finalized += 1;
        return {
          rows: [{
            subject: "user-1",
            status: "reserved",
            used: finalized === 1 ? 1 : null,
            window_started_at: start,
            generation_limit: 3,
          }],
        };
      }
      return { rows: [{ used: 1, window_started_at: start, generation_limit: 3 }] };
    });

    const [first, retry] = await Promise.all([
      reserveFreeTierQuota("user-1", "claim-1"),
      reserveFreeTierQuota("user-1", "claim-1"),
    ]);

    expect(first).toMatchObject({ allowed: true, remaining: 2, status: "reserved" });
    expect(retry).toMatchObject({ allowed: true, remaining: 2, status: "reserved" });
    expect(finalized).toBe(2);
    const reservationSql = queryAt(2);
    expect(reservationSql).toMatch(/FOR UPDATE/);
    expect(reservationSql).toMatch(/ON CONFLICT \(subject\) DO UPDATE/);
    expect(reservationSql).toMatch(/WHERE locked_claim.status = 'pending'/);
    expect(reservationSql).toMatch(/free_tier_quotas\.used < \(SELECT generation_limit FROM effective_limit\)/);
  });

  it("rejects reuse of a claim key for another subject", async () => {
    execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [{ subject: "user-1", status: "reserved", used: null, window_started_at: new Date(), generation_limit: 3 }],
    });

    await expect(reserveFreeTierQuota("user-2", "claim-1")).rejects.toThrow(
      "Quota claim key belongs to another subject",
    );
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("uses a caller's transaction for reservation and release", async () => {
    const transactionExecute = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        subject: "user-1",
        status: "reserved",
        used: 1,
        window_started_at: new Date(),
        generation_limit: 3,
      }] })
      .mockResolvedValueOnce({ rows: [] });
    const transaction = { execute: transactionExecute } as unknown as Parameters<typeof reserveFreeTierQuota>[2];

    const result = await reserveFreeTierQuota("user-1", "claim-1", transaction);
    await releaseFreeTierQuota("claim-1", transaction);

    expect(result.allowed).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(transactionExecute).toHaveBeenCalledTimes(3);
    expect(dialect.sqlToQuery(transactionExecute.mock.calls[2][0]).sql)
      .toMatch(/UPDATE free_tier_quota_claims[\s\S]*UPDATE free_tier_quotas/);
  });
});
