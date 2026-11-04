import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const h = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { transaction: h.transaction } }));

import { getStudioGuestSourceId, issueStudioGuestSession, reserveStudioGuestUpload } from "@/lib/studio-guest-budget";

const dialect = new PgDialect();
const userId = "693a8e78-5b98-49e6-9fc2-4b3352ac387a";
const sourceId = "a".repeat(32);

function transactionWithUsage(overrides: Record<string, number> = {}) {
  const values = vi.fn().mockResolvedValue(undefined);
  const usage = {
    source_hour: 0,
    source_day: 0,
    global_hour: 0,
    global_day: 0,
    ...overrides,
  };
  const tx = {
    execute: vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [usage] }),
    insert: vi.fn().mockReturnValue({ values }),
  };
  h.transaction.mockImplementation(async (run: (client: typeof tx) => Promise<unknown>) => {
    if (typeof run !== "function") throw new Error(`Unexpected transaction input: ${String(run)}`);
    return run(tx);
  });
  return { tx, values };
}

beforeEach(() => {
  h.transaction.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("trusted Studio guest source", () => {
  it("uses only ACA's last forwarding hop and fails closed if it is absent", () => {
    vi.stubEnv("AUTH_SECRET", "test-guest-secret");
    vi.stubEnv("CONTAINER_APP_NAME", "comics");
    const source = (forwarded: string) => getStudioGuestSourceId(new Request(
      "https://comics.example.com/api/studio/session",
      { headers: { "x-forwarded-for": forwarded } },
    ));

    expect(source("attacker.invalid, 192.0.2.42")).toMatch(/^[0-9a-f]{32}$/);
    expect(source("198.51.100.99, 192.0.2.42")).toBe(source("attacker.invalid, 192.0.2.42"));
    expect(source("192.0.2.42, 198.51.100.99")).not.toBe(source("attacker.invalid, 192.0.2.42"));
    expect(source("192.0.2.42, attacker.invalid")).toBeNull();
    expect(getStudioGuestSourceId(new Request("https://comics.example.com/api/studio/session"))).toBeNull();
  });
});

describe("atomic Studio guest session issuance", () => {
  it("records a new user and source budget in one locked transaction", async () => {
    const { tx, values } = transactionWithUsage();

    expect(await issueStudioGuestSession(userId, sourceId)).toEqual({ reason: "accepted" });
    expect(h.transaction).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      id: userId,
      kind: "browser_guest",
      generationQuotaLimit: -1,
    }));
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      userId,
      kind: "studio.guest.session.issued",
      details: { sourceId },
    }));
    const lock = dialect.sqlToQuery(tx.execute.mock.calls[0][0] as SQL);
    const counts = dialect.sqlToQuery(tx.execute.mock.calls[1][0] as SQL);
    expect(lock.sql).toContain("pg_advisory_xact_lock");
    expect(counts.sql).toContain("details ->> 'sourceId'");
    expect(counts.params).toContain(sourceId);
  });

  it.each([
    ["source_hour", 300],
    ["source_day", 2400],
    ["global_hour", 3000],
    ["global_day", 24000],
  ])("denies a new session at the %s ceiling", async (field, limit) => {
    const { values } = transactionWithUsage({ [field]: limit });
    expect(await issueStudioGuestSession(userId, sourceId))
      .toEqual({ reason: "rate_limit" });
    expect(values).not.toHaveBeenCalled();
  });

  it("fails closed if the ledger cannot be read", async () => {
    h.transaction.mockRejectedValue(new Error("database unavailable"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await issueStudioGuestSession(userId, sourceId))
        .toEqual({ reason: "unavailable" });
    } finally {
      logged.mockRestore();
    }
  });
});

describe("atomic Studio guest photo upload budget", () => {
  it("records an upload attempt against both source and global limits", async () => {
    vi.stubEnv("AUTH_SECRET", "test-guest-secret");
    const { tx, values } = transactionWithUsage();

    const result = await reserveStudioGuestUpload(userId,
      new Request("https://comics.example.com/api/blob-upload"));

    expect(result).toEqual({ allowed: true });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      userId,
      kind: "studio.guest.photo_upload.requested",
      details: { sourceId: expect.stringMatching(/^[0-9a-f]{32}$/) },
    }));
    const counts = dialect.sqlToQuery(tx.execute.mock.calls[1][0] as SQL);
    expect(counts.sql).toContain("details ->> 'sourceId'");
    expect(counts.sql).toContain("INTERVAL '1 hour'");
  });

  it.each([
    ["source_hour", 600],
    ["source_day", 4800],
    ["global_hour", 6000],
    ["global_day", 48000],
  ])("denies uploads at the %s ceiling", async (field, limit) => {
    vi.stubEnv("AUTH_SECRET", "test-guest-secret");
    const { values } = transactionWithUsage({ [field]: limit });

    expect(await reserveStudioGuestUpload(userId,
      new Request("https://comics.example.com/api/blob-upload")))
      .toEqual({ allowed: false, reason: "rate_limit" });
    expect(values).not.toHaveBeenCalled();
  });

  it("fails closed without a trusted source", async () => {
    vi.stubEnv("AUTH_SECRET", "");
    expect(await reserveStudioGuestUpload(userId,
      new Request("https://comics.example.com/api/blob-upload")))
      .toEqual({ allowed: false, reason: "unavailable" });
    expect(h.transaction).not.toHaveBeenCalled();
  });
});
