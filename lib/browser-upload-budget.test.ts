import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const h = vi.hoisted(() => ({
  transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { transaction: h.transaction } }));

import { reserveBrowserUpload } from "@/lib/browser-upload-budget";

const dialect = new PgDialect();
const USER_ID = "owner-1";

function transactionWithUsage(minuteCount: number | string, dayCount: number | string) {
  const values = vi.fn().mockResolvedValue(undefined);
  const tx = {
    execute: vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ minute_count: minuteCount, day_count: dayCount }] }),
    insert: vi.fn().mockReturnValue({ values }),
  };
  h.transaction.mockImplementation(async (run: (client: typeof tx) => Promise<unknown>) => run(tx));
  return { tx, values };
}

beforeEach(() => {
  h.transaction.mockReset();
});

describe("browser upload admission budget", () => {
  it("reserves a user upload below both rolling limits", async () => {
    const { tx, values } = transactionWithUsage(19, "119");

    const result = await reserveBrowserUpload(USER_ID);

    expect(result).toEqual({ allowed: true });
    expect(values).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      userId: USER_ID,
      channel: "web",
      kind: "web.blob_upload.requested",
      status: "requested",
    }));
    expect(values.mock.calls[0][0].eventKey).toMatch(/^web-upload:[0-9a-f-]{36}$/);

    const lock = dialect.sqlToQuery(tx.execute.mock.calls[0][0] as SQL);
    const count = dialect.sqlToQuery(tx.execute.mock.calls[1][0] as SQL);
    expect(lock.sql).toContain("pg_advisory_xact_lock");
    expect(lock.params).toContain(USER_ID);
    expect(count.sql).toContain("INTERVAL '1 minute'");
    expect(count.sql).toContain("INTERVAL '24 hours'");
    expect(count.sql).toContain("user_id =");
    expect(count.params).toContain(USER_ID);
    expect(count.params).toContain("web.blob_upload.requested");
  });

  it("timestamps the attempt when the reservation is written", async () => {
    const { values } = transactionWithUsage(0, 0);

    expect(await reserveBrowserUpload(USER_ID)).toEqual({ allowed: true });

    const occurredAt = values.mock.calls[0][0].occurredAt as SQL | undefined;
    expect(occurredAt).toBeDefined();
    expect(dialect.sqlToQuery(occurredAt as SQL).sql).toBe("statement_timestamp()");
  });

  it.each([
    [20, 20, "minute"],
    [19, 120, "day"],
  ])("rejects at the %s minute / %s day count (%s limit)", async (minute, day) => {
    const { values } = transactionWithUsage(minute, day);

    expect(await reserveBrowserUpload(USER_ID)).toEqual({
      allowed: false,
      reason: "rate_limit",
    });
    expect(values).not.toHaveBeenCalled();
  });

  it("fails closed when the budget ledger is unavailable", async () => {
    h.transaction.mockRejectedValue(new Error("database unavailable"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await reserveBrowserUpload(USER_ID)).toEqual({
        allowed: false,
        reason: "unavailable",
      });
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});
