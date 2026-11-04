import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const h = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { transaction: h.transaction } }));

import { reserveStudioTextBudget } from "@/lib/studio-comic-text-budget";

const dialect = new PgDialect();
const input = {
  kind: "verify_start" as const,
  userId: "00000000-0000-4000-8000-000000000001",
  storyId: "00000000-0000-4000-8000-000000000002",
  phone: "+14155552671",
  sourceId: "a".repeat(32),
};

function transactionWithUsage(overrides: Record<string, number> = {}) {
  const values = vi.fn().mockResolvedValue(undefined);
  const usage = {
    phone_hour: 0,
    phone_day: 0,
    actor_hour: 0,
    actor_day: 0,
    source_day: 0,
    global_day: 0,
    ...overrides,
  };
  const tx = {
    execute: vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [usage] }),
    insert: vi.fn().mockReturnValue({ values }),
  };
  h.transaction.mockImplementation(async (run: (client: typeof tx) => Promise<unknown>) => run(tx));
  return { tx, values };
}

beforeEach(() => {
  h.transaction.mockReset();
});

describe("optional comic text budget", () => {
  it("serializes reservations and records a bounded Verify attempt", async () => {
    const { tx, values } = transactionWithUsage();
    const result = await reserveStudioTextBudget(input);

    expect(result).toMatchObject({ allowed: true, eventKey: expect.stringMatching(/^studio-text:verify_start:[0-9a-f-]{36}$/) });
    expect(values).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      userId: input.userId,
      storyId: input.storyId,
      address: input.phone,
      kind: "studio.comic_text.verify_start.requested",
      details: { sourceId: input.sourceId },
      status: "reserved",
    }));
    const lock = dialect.sqlToQuery(tx.execute.mock.calls[0][0] as SQL);
    const count = dialect.sqlToQuery(tx.execute.mock.calls[1][0] as SQL);
    expect(lock.sql).toContain("pg_advisory_xact_lock");
    expect(count.sql).toContain("INTERVAL '24 hours'");
    expect(count.sql).toContain("details ->> 'sourceId'");
    expect(count.params).toEqual(expect.arrayContaining([input.phone, input.userId, input.sourceId]));
  });

  it.each([
    ["phone_hour", 3],
    ["phone_day", 6],
    ["actor_hour", 5],
    ["actor_day", 12],
    ["source_day", 100],
    ["global_day", 1000],
  ])("denies a Verify start at the %s limit", async (field, limit) => {
    const { values } = transactionWithUsage({ [field]: limit });
    expect(await reserveStudioTextBudget(input)).toEqual({ allowed: false, reason: "rate_limit" });
    expect(values).not.toHaveBeenCalled();
  });

  it("fails closed if the budget ledger is unavailable", async () => {
    h.transaction.mockRejectedValue(new Error("database unavailable"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await reserveStudioTextBudget(input)).toEqual({ allowed: false, reason: "unavailable" });
    } finally {
      logged.mockRestore();
    }
  });
});
