import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const h = vi.hoisted(() => ({
  transaction: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { transaction: h.transaction, update: h.update } }));

import {
  finishCameraBudget,
  reserveCameraBudget,
} from "@/lib/browser-photo-budget";

const PHONE = "+14155552671";
const dialect = new PgDialect();

function transactionWithUsage(usage: {
  phone_hour: number | null;
  phone_day: number | null;
}) {
  const values = vi.fn().mockResolvedValue(undefined);
  const tx = {
    execute: vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([usage]),
    insert: vi.fn().mockReturnValue({ values }),
  };
  h.transaction.mockImplementation(async (run: (client: typeof tx) => Promise<unknown>) => run(tx));
  return { tx, values };
}

function queryOf(statement: SQL): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery(statement);
}

beforeEach(() => {
  h.transaction.mockReset();
  h.update.mockReset();
});

afterEach(() => vi.unstubAllEnvs());

describe("browser camera per-phone budgets", () => {
  it("reserves a Verify start under the phone hourly and daily caps", async () => {
    const { tx, values } = transactionWithUsage({ phone_hour: 2, phone_day: 4 });

    const result = await reserveCameraBudget("verification_start", PHONE);

    expect(result).toMatchObject({ allowed: true });
    expect(tx.execute).toHaveBeenCalledTimes(2);
    const lock = queryOf(tx.execute.mock.calls[0][0] as SQL);
    const usage = queryOf(tx.execute.mock.calls[1][0] as SQL);
    expect(lock.sql).toContain("pg_advisory_xact_lock");
    expect(lock.params).toEqual(["camera.verification_start.requested", PHONE]);
    expect(usage.sql).toContain("address =");
    expect(usage.params).toEqual(["camera.verification_start.requested", PHONE]);
    expect(usage.sql).not.toContain("global_hour");
    expect(usage.sql).not.toContain("global_day");
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      channel: "camera",
      kind: "camera.verification_start.requested",
      address: PHONE,
      status: "reserved",
    }));
  });

  it.each([
    ["verification_start", 3, 3],
    ["verification_start", 2, 5],
    ["verification_check", 8, 8],
    ["verification_check", 7, 16],
    ["upload", 6, 6],
    ["upload", 5, 12],
  ] as const)("rejects %s at a per-phone cap", async (kind, phoneHour, phoneDay) => {
    const { values } = transactionWithUsage({
      phone_hour: phoneHour,
      phone_day: phoneDay,
    });

    expect(await reserveCameraBudget(kind, PHONE)).toEqual({
      allowed: false,
      reason: "rate_limit",
    });
    expect(values).not.toHaveBeenCalled();
  });

  it.each([
    ["verification_check", 7, 15],
    ["upload", 5, 11],
  ] as const)("allows %s under its own per-phone caps", async (kind, hour, day) => {
    const { values } = transactionWithUsage({ phone_hour: hour, phone_day: day });

    expect(await reserveCameraBudget(kind, PHONE)).toMatchObject({ allowed: true });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      kind: "camera." + kind + ".requested",
    }));
  });

  it("does not apply obsolete global Verify limits to another phone", async () => {
    vi.stubEnv("CAMERA_VERIFY_GLOBAL_HOURLY_LIMIT", "0");
    vi.stubEnv("CAMERA_VERIFY_GLOBAL_DAILY_LIMIT", "0");
    const first = transactionWithUsage({ phone_hour: 0, phone_day: 0 });
    expect(await reserveCameraBudget("verification_start", PHONE)).toMatchObject({ allowed: true });
    const secondPhone = "+14155552672";
    const second = transactionWithUsage({ phone_hour: 0, phone_day: 0 });
    expect(await reserveCameraBudget("verification_start", secondPhone))
      .toMatchObject({ allowed: true });

    expect(first.values).toHaveBeenCalledOnce();
    expect(second.values).toHaveBeenCalledOnce();
    const firstLock = queryOf(first.tx.execute.mock.calls[0][0] as SQL);
    const secondLock = queryOf(second.tx.execute.mock.calls[0][0] as SQL);
    expect(firstLock.params[1]).toBe(PHONE);
    expect(secondLock.params[1]).toBe(secondPhone);
  });

  it("rejects malformed phone input before accessing the database", async () => {
    expect(await reserveCameraBudget("upload", "4155552671")).toEqual({
      allowed: false,
      reason: "unavailable",
    });
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("fails closed if PostgreSQL cannot reserve or returns invalid counts", async () => {
    h.transaction.mockRejectedValueOnce(new Error("db unavailable"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await reserveCameraBudget("verification_check", PHONE)).toEqual({
        allowed: false,
        reason: "unavailable",
      });
      transactionWithUsage({ phone_hour: null, phone_day: 0 });
      expect(await reserveCameraBudget("verification_check", PHONE)).toEqual({
        allowed: false,
        reason: "unavailable",
      });
      expect(errorLog).toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  it("updates only a budget event with a valid generated key", async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn().mockReturnValue({ where });
    h.update.mockReturnValue({ set });
    const eventKey = "camera:upload:00000000-0000-4000-8000-000000000001";

    await finishCameraBudget(eventKey, "stored");
    expect(set).toHaveBeenCalledWith({ status: "stored" });
    expect(where).toHaveBeenCalledOnce();

    await expect(finishCameraBudget("invalid", "stored")).rejects.toThrow("Invalid camera event key");
    expect(h.update).toHaveBeenCalledOnce();
  });
});
