import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({
  transaction: vi.fn(),
  execute: vi.fn(),
  insert: vi.fn(),
  values: vi.fn(),
  returning: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { transaction: h.transaction } }));

import { submitTesterFeedback } from "@/lib/feedback";

const dialect = new PgDialect();

beforeEach(() => {
  vi.resetAllMocks();
  h.transaction.mockImplementation(async (run) => run({ execute: h.execute, insert: h.insert }));
  h.insert.mockReturnValue({ values: h.values });
  h.values.mockReturnValue({ returning: h.returning });
  h.returning.mockResolvedValue([{ id: 1 }]);
  h.execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ count: 4 }] });
});

describe("signed-in tester feedback allowance", () => {
  it("checks a rolling 24-hour count under a per-user advisory lock before inserting", async () => {
    await expect(submitTesterFeedback("tester-1", "An idea")).resolves.toBe(true);

    const queries = h.execute.mock.calls.map((call: unknown[]) => dialect.sqlToQuery(call[0] as SQL));
    expect(queries[0].sql).toContain("pg_advisory_xact_lock");
    expect(queries[0].params).toContain("tester-1");
    expect(queries[1].sql).toContain("INTERVAL '24 hours'");
    expect(queries[1].params).toContain("tester-1");
    expect(h.values).toHaveBeenCalledWith({ userId: "tester-1", message: "An idea" });
  });

  it("denies a sixth submission without inserting", async () => {
    h.execute.mockReset().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ count: 5 }] });

    await expect(submitTesterFeedback("tester-1", "An idea")).resolves.toBe(false);

    expect(h.insert).not.toHaveBeenCalled();
  });

  it("rejects invalid data before opening a transaction", async () => {
    await expect(submitTesterFeedback("", "An idea")).rejects.toThrow("Invalid feedback");
    await expect(submitTesterFeedback("tester-1", " ")).rejects.toThrow("Invalid feedback");
    await expect(submitTesterFeedback("tester-1", "x".repeat(2_001))).rejects.toThrow("Invalid feedback");
    expect(h.transaction).not.toHaveBeenCalled();
  });
});
