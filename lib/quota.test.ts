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
  it("returns the full allowance when no quota row exists", async () => {
    execute.mockResolvedValue({ rows: [] });
    await expect(getFreeTierQuota("user-1")).resolves.toEqual({
      remaining: 3,
      reset: null,
    });
  });

  it("finalizes a newly inserted claim in a separate statement", async () => {
    const start = new Date();
    execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [
        { subject: "user-1", status: "reserved", used: 1, window_started_at: start },
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
        },
      ],
    }).mockResolvedValueOnce({ rows: [{ used: 3, window_started_at: start }] });
    const result = await reserveFreeTierQuota("user-1", "claim-4");
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("reuses a consumed claim without another quota increment", async () => {
    const start = new Date();
    execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [{ subject: "user-1", status: "consumed", used: null, window_started_at: start }],
    }).mockResolvedValueOnce({ rows: [{ used: 1, window_started_at: start }] });

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
      if (query.includes("WITH locked_claim AS MATERIALIZED")) {
        finalized += 1;
        return {
          rows: [{
            subject: "user-1",
            status: "reserved",
            used: finalized === 1 ? 1 : null,
            window_started_at: start,
          }],
        };
      }
      return { rows: [{ used: 1, window_started_at: start }] };
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
    expect(reservationSql).toMatch(/OR free_tier_quotas.used < \$\d+/);
  });

  it("rejects reuse of a claim key for another subject", async () => {
    execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({
      rows: [{ subject: "user-1", status: "reserved", used: null, window_started_at: new Date() }],
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
