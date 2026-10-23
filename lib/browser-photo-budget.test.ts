import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  transaction: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { transaction: h.transaction, update: h.update } }));

import { finishCameraBudget, reserveCameraBudget } from "@/lib/browser-photo-budget";

const PHONE = "+14155552671";

function transactionWithUsage(usage: {
  phone_hour: number;
  phone_day: number;
  global_hour: number;
  global_day: number;
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

beforeEach(() => {
  h.transaction.mockReset();
  h.update.mockReset();
});

afterEach(() => vi.unstubAllEnvs());

describe("browser camera admission budgets", () => {
  it("reserves a Verify start under the hourly and daily phone/global caps", async () => {
    const { tx, values } = transactionWithUsage({
      phone_hour: 2,
      phone_day: 4,
      global_hour: 7,
      global_day: 7,
    });

    const result = await reserveCameraBudget("verification_start", PHONE);

    expect(result).toMatchObject({ allowed: true });
    expect(tx.execute).toHaveBeenCalledTimes(2);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      channel: "camera",
      kind: "camera.verification_start.requested",
      address: PHONE,
      status: "reserved",
    }));
  });

  it.each([
    [{ phone_hour: 3, phone_day: 3, global_hour: 3, global_day: 3 }, "phone hour"],
    [{ phone_hour: 2, phone_day: 5, global_hour: 3, global_day: 3 }, "phone day"],
    [{ phone_hour: 2, phone_day: 3, global_hour: 30, global_day: 7 }, "global hour"],
    [{ phone_hour: 2, phone_day: 3, global_hour: 7, global_day: 50 }, "global day"],
  ])("rejects Verify starts at the %s cap (%s)", async (usage) => {
    const { values } = transactionWithUsage(usage);

    expect(await reserveCameraBudget("verification_start", PHONE)).toEqual({
      allowed: false,
      reason: "rate_limit",
    });
    expect(values).not.toHaveBeenCalled();
  });

  it("uses a configured rolling hourly Verify start cap without changing phone limits", async () => {
    vi.stubEnv("CAMERA_VERIFY_GLOBAL_HOURLY_LIMIT", "12");
    const belowCap = transactionWithUsage({
      phone_hour: 2,
      phone_day: 4,
      global_hour: 11,
      global_day: 11,
    });
    expect(await reserveCameraBudget("verification_start", PHONE)).toMatchObject({ allowed: true });
    expect(belowCap.values).toHaveBeenCalledOnce();

    const atCap = transactionWithUsage({
      phone_hour: 2,
      phone_day: 4,
      global_hour: 12,
      global_day: 11,
    });
    expect(await reserveCameraBudget("verification_start", PHONE)).toEqual({
      allowed: false,
      reason: "rate_limit",
    });
    expect(atCap.values).not.toHaveBeenCalled();

    const phoneAtCap = transactionWithUsage({
      phone_hour: 3,
      phone_day: 4,
      global_hour: 0,
      global_day: 0,
    });
    expect(await reserveCameraBudget("verification_start", PHONE)).toEqual({
      allowed: false,
      reason: "rate_limit",
    });
    expect(phoneAtCap.values).not.toHaveBeenCalled();
  });

  it("bounds an oversized hourly Verify start cap and falls back on invalid values", async () => {
    vi.stubEnv("CAMERA_VERIFY_GLOBAL_HOURLY_LIMIT", "999");
    const maxed = transactionWithUsage({
      phone_hour: 0,
      phone_day: 0,
      global_hour: 100,
      global_day: 0,
    });
    expect(await reserveCameraBudget("verification_start", PHONE)).toEqual({
      allowed: false,
      reason: "rate_limit",
    });
    expect(maxed.values).not.toHaveBeenCalled();

    vi.stubEnv("CAMERA_VERIFY_GLOBAL_HOURLY_LIMIT", "0");
    const invalid = transactionWithUsage({
      phone_hour: 0,
      phone_day: 0,
      global_hour: 30,
      global_day: 0,
    });
    expect(await reserveCameraBudget("verification_start", PHONE)).toEqual({
      allowed: false,
      reason: "rate_limit",
    });
    expect(invalid.values).not.toHaveBeenCalled();
  });

  it("uses a configured rolling 24-hour Verify start cap without changing phone limits", async () => {
    vi.stubEnv("CAMERA_VERIFY_GLOBAL_DAILY_LIMIT", "12");
    const { values } = transactionWithUsage({
      phone_hour: 2,
      phone_day: 4,
      global_hour: 7,
      global_day: 11,
    });
    expect(await reserveCameraBudget("verification_start", PHONE)).toMatchObject({ allowed: true });
    expect(values).toHaveBeenCalledOnce();

    const atCap = transactionWithUsage({
      phone_hour: 2,
      phone_day: 4,
      global_hour: 7,
      global_day: 12,
    });
    expect(await reserveCameraBudget("verification_start", PHONE)).toEqual({
      allowed: false,
      reason: "rate_limit",
    });
    expect(atCap.values).not.toHaveBeenCalled();

    const phoneAtCap = transactionWithUsage({
      phone_hour: 3,
      phone_day: 4,
      global_hour: 7,
      global_day: 0,
    });
    expect(await reserveCameraBudget("verification_start", PHONE)).toEqual({
      allowed: false,
      reason: "rate_limit",
    });
    expect(phoneAtCap.values).not.toHaveBeenCalled();
  });

  it("bounds an oversized Verify start cap and falls back safely on invalid values", async () => {
    vi.stubEnv("CAMERA_VERIFY_GLOBAL_DAILY_LIMIT", "999");
    const maxed = transactionWithUsage({
      phone_hour: 0,
      phone_day: 0,
      global_hour: 0,
      global_day: 500,
    });
    expect(await reserveCameraBudget("verification_start", PHONE)).toEqual({
      allowed: false,
      reason: "rate_limit",
    });
    expect(maxed.values).not.toHaveBeenCalled();

    vi.stubEnv("CAMERA_VERIFY_GLOBAL_DAILY_LIMIT", "0");
    const invalid = transactionWithUsage({
      phone_hour: 0,
      phone_day: 0,
      global_hour: 0,
      global_day: 50,
    });
    expect(await reserveCameraBudget("verification_start", PHONE)).toEqual({
      allowed: false,
      reason: "rate_limit",
    });
    expect(invalid.values).not.toHaveBeenCalled();
  });

  it("allows the distinct upload budget and refuses malformed phone input", async () => {
    const { values } = transactionWithUsage({
      phone_hour: 5,
      phone_day: 11,
      global_hour: 39,
      global_day: 99,
    });
    expect(await reserveCameraBudget("upload", PHONE)).toMatchObject({ allowed: true });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      kind: "camera.upload.requested",
    }));

    h.transaction.mockClear();
    expect(await reserveCameraBudget("upload", "4155552671")).toEqual({
      allowed: false,
      reason: "unavailable",
    });
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("fails closed if PostgreSQL cannot serialize the budget reservation", async () => {
    h.transaction.mockRejectedValue(new Error("db unavailable"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
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
