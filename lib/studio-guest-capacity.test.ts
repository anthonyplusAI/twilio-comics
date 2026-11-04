import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const h = vi.hoisted(() => ({
  transaction: vi.fn(),
  execute: vi.fn(),
  directExecute: vi.fn(),
  insert: vi.fn(),
  values: vi.fn(),
  sourceId: vi.fn(),
  budgetId: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { transaction: h.transaction, execute: h.directExecute } }));
vi.mock("@/lib/studio-guest-budget", () => ({ getStudioGuestSourceId: h.sourceId }));
vi.mock("@/lib/studio-guest-session", () => ({ getStudioBudgetId: h.budgetId }));

import { markStudioAppGenerationPaidStarted, reserveStudioAppGenerationCapacity } from "@/lib/studio-guest-capacity";

const dialect = new PgDialect();
const userId = "693a8e78-5b98-49e6-9fc2-4b3352ac387a";
const sourceId = "a".repeat(32);
const budgetId = "bbf04d09-50c6-4384-bd75-af935129bc78";
const claimKey = `web-generation:${userId}:e3e31e8f-1a27-4c11-bd64-92829c0a889a`;
const request = () => new Request("https://comics.example.com/api/generate-comic");
const actor = { userId, kind: "guest" as const };

function usage(overrides: Record<string, unknown> = {}) {
  h.execute.mockReset()
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{
      user_active: false,
      source_active: 0,
      global_active: 0,
      user_hour: 0,
      user_day: 0,
      source_hour: 0,
      source_day: 0,
      global_hour: 0,
      global_day: 0,
      ...overrides,
    }] })
    .mockResolvedValueOnce({ rows: [{ claim_key: claimKey }] });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.transaction.mockImplementation(async (callback) => callback({ execute: h.execute, insert: h.insert }));
  h.insert.mockReturnValue({ values: h.values });
  h.values.mockResolvedValue(undefined);
  h.sourceId.mockReturnValue(sourceId);
  h.budgetId.mockReturnValue(budgetId);
  usage();
});

describe("atomic source and global generation capacity for Studio guests", () => {
  it("admits and records a generation under all three concurrent ceilings", async () => {
    const result = await reserveStudioAppGenerationCapacity(actor, claimKey, request());

    expect(result).toEqual({ reason: "accepted" });
    expect(h.values).toHaveBeenCalledWith(expect.objectContaining({
      userId,
      kind: "studio.app_generation.admitted",
      details: { sourceId, claimKey, budgetId },
    }));
    const lock = dialect.sqlToQuery(h.execute.mock.calls[0][0] as SQL);
    const counts = dialect.sqlToQuery(h.execute.mock.calls[1][0] as SQL);
    expect(lock.sql).toContain("pg_advisory_xact_lock");
    expect(counts.sql).toContain("free_tier_quota_claims");
    expect(counts.sql).toContain("activity_events");
    expect(counts.sql).toContain("details ->> 'sourceId'");
    expect(counts.sql).toContain("claims.status = 'consumed'");
    expect(counts.sql).toContain("claims.status = 'reserved'");
    expect(counts.sql).toContain("events.status = 'paid_started'");
    expect(counts.sql).toMatch(/claims\.status = 'reserved'\s+OR events\.status = 'paid_started'/);
    expect(counts.sql).toMatch(/claims\.status = 'reserved'\s+AND claims\.created_at >= statement_timestamp\(\) - INTERVAL '20 minutes'\) AS is_active/);
    expect(counts.sql).toContain("INTERVAL '1 hour'");
    expect(counts.sql).toContain("INTERVAL '24 hours'");
    expect(counts.params).toEqual(expect.arrayContaining([userId, sourceId]));
    const claim = dialect.sqlToQuery(h.execute.mock.calls[2][0] as SQL);
    expect(claim.sql).toContain("INSERT INTO free_tier_quota_claims");
    expect(claim.params).toContain(`studio:${budgetId}`);
    expect(claim.sql).not.toContain("free_tier_quotas");
  });

  it("records the provider-start marker before a paid attempt can be released", async () => {
    h.directExecute.mockResolvedValue({ rows: [{ event_key: `studio-app-generation:${claimKey}` }] });

    await markStudioAppGenerationPaidStarted(claimKey);

    const update = dialect.sqlToQuery(h.directExecute.mock.calls[0][0] as SQL);
    expect(update.sql).toContain("UPDATE activity_events");
    expect(update.sql).toContain("status = 'paid_started'");
    expect(update.sql).toContain("status = 'admitted'");
    expect(update.params).toContain(`studio-app-generation:${claimKey}`);
  });

  it("fails closed when the provider-start marker finds no admission event", async () => {
    h.directExecute.mockResolvedValue({ rows: [] });

    await expect(markStudioAppGenerationPaidStarted(claimKey))
      .rejects.toThrow("Studio generation admission was not found");
  });

  it.each([
    [{ user_active: true }, "user"],
    [{ source_active: 8 }, "source"],
    [{ global_active: 24 }, "global"],
  ])("denies an active %s ceiling without a quota claim", async (overrides, scope) => {
    usage(overrides);

    expect(await reserveStudioAppGenerationCapacity(actor, claimKey, request()))
      .toEqual({ reason: "busy", scope });
    expect(h.execute).toHaveBeenCalledTimes(2);
    expect(h.values).not.toHaveBeenCalled();
  });

  it.each([
    [{ user_hour: 12 }, "user", "hour"],
    [{ user_day: 48 }, "user", "day"],
    [{ source_hour: 240 }, "source", "hour"],
    [{ source_day: 1200 }, "source", "day"],
    [{ global_hour: 1000 }, "global", "hour"],
    [{ global_day: 5000 }, "global", "day"],
  ])("limits rolling guest generation starts at %s", async (overrides, scope, window) => {
    usage(overrides);

    expect(await reserveStudioAppGenerationCapacity(actor, claimKey, request()))
      .toMatchObject({ reason: "rate_limit", scope, window,
        message: expect.stringContaining(`past ${window}`) });
    expect(h.execute).toHaveBeenCalledTimes(2);
    expect(h.values).not.toHaveBeenCalled();
  });

  it("fails closed without a trusted source or valid usage counts", async () => {
    h.sourceId.mockReturnValue(null);
    expect(await reserveStudioAppGenerationCapacity(actor, claimKey, request()))
      .toEqual({ reason: "unavailable" });
    expect(h.transaction).not.toHaveBeenCalled();

    h.sourceId.mockReturnValue(sourceId);
    usage({ global_active: null });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await reserveStudioAppGenerationCapacity(actor, claimKey, request()))
        .toEqual({ reason: "unavailable" });
    } finally {
      logged.mockRestore();
    }
    expect(h.values).not.toHaveBeenCalled();
  });

  it("fails closed if a duplicate claim key is not inserted", async () => {
    usage();
    h.execute.mockReset()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        user_active: false, source_active: 0, global_active: 0,
        user_hour: 0, user_day: 0, source_hour: 0, source_day: 0,
        global_hour: 0, global_day: 0,
      }] })
      .mockResolvedValueOnce({ rows: [] });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await reserveStudioAppGenerationCapacity(actor, claimKey, request()))
        .toEqual({ reason: "unavailable" });
    } finally {
      logged.mockRestore();
    }
    expect(h.values).not.toHaveBeenCalled();
  });

  it("uses the same browser budget for app-funded Google and guest actors", async () => {
    const googleActor = { userId: "google-owner", kind: "google" as const };
    const googleClaim = `web-generation:google-owner:e3e31e8f-1a27-4c11-bd64-92829c0a889a`;
    h.execute.mockReset()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        user_active: false, source_active: 0, global_active: 0,
        user_hour: 0, user_day: 0, source_hour: 0, source_day: 0,
        global_hour: 0, global_day: 0,
      }] })
      .mockResolvedValueOnce({ rows: [{ claim_key: googleClaim }] });

    expect(await reserveStudioAppGenerationCapacity(googleActor, googleClaim, request()))
      .toEqual({ reason: "accepted" });
    expect(h.values).toHaveBeenCalledWith(expect.objectContaining({
      userId: "google-owner",
      details: { sourceId, claimKey: googleClaim, budgetId },
    }));
    const claim = dialect.sqlToQuery(h.execute.mock.calls[2][0] as SQL);
    expect(claim.params).toContain(`studio:${budgetId}`);
  });
});
