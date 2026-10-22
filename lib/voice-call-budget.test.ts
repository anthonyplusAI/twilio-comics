import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({
  transaction: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { transaction: h.transaction } }));

import { reserveVoiceCallBudget } from "@/lib/voice-call-budget";

const dialect = new PgDialect();
const callSid = `CA${"a".repeat(32)}`;
const fromAddress = "+15551112222";
const toAddress = "+18669012028";
const input = { callSid, fromAddress, toAddress };

function statements(): Array<{ sql: string; params: unknown[] }> {
  return h.execute.mock.calls.map(([query]: unknown[]) => dialect.sqlToQuery(query as SQL));
}

beforeEach(() => {
  h.execute.mockReset();
  h.transaction.mockReset();
  h.transaction.mockImplementation(async (run) => run({ execute: h.execute }));
});

describe("Voice call budget", () => {
  it("admits the sixth call using a caller lock and a rolling 24-hour count", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ used: 5 }] })
      .mockResolvedValueOnce({ rows: [{ call_sid: callSid }] });

    await expect(reserveVoiceCallBudget(input)).resolves.toEqual({
      allowed: true,
      duplicate: false,
    });

    const queries = statements();
    expect(queries).toHaveLength(4);
    expect(queries[0].sql).toContain("pg_advisory_xact_lock");
    expect(queries[0].params).toContain(fromAddress);
    expect(queries[1].params).toContain(callSid);
    expect(queries[2].sql).toMatch(/started_at\s*>\s*statement_timestamp\(\)\s*-\s*INTERVAL '24 hours'/i);
    expect(queries[2].sql).toMatch(/status\s*<>\s*'rate_limited'/i);
    expect(queries[2].params).toContain(fromAddress);
    expect(queries[3].sql).toMatch(/INSERT INTO voice_calls/i);
    expect(queries[3].sql).toMatch(/ON CONFLICT\s*\(call_sid\)\s*DO NOTHING/i);
    expect(queries[3].params).toEqual(expect.arrayContaining([callSid, fromAddress, toAddress, "active"]));
  });

  it("rejects the seventh call and keeps a durable denied-call record", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ used: 6 }] })
      .mockResolvedValueOnce({ rows: [{ call_sid: callSid }] });

    await expect(reserveVoiceCallBudget(input)).resolves.toEqual({
      allowed: false,
      reason: "rate_limit",
    });

    const insert = statements()[3];
    expect(insert.params).toEqual(expect.arrayContaining([callSid, fromAddress, toAddress, "rate_limited"]));
    expect(insert.sql).toMatch(/ended_at/i);
    expect(insert.sql).toMatch(/duration_seconds/i);
  });

  it("returns the original allowance for a repeated CallSid without counting it twice", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ from_address: fromAddress, to_address: toAddress, status: "active", ended_at: null }] });

    await expect(reserveVoiceCallBudget(input)).resolves.toEqual({
      allowed: true,
      duplicate: true,
    });
    expect(statements()).toHaveLength(2);
  });

  it("keeps a repeated denied CallSid denied", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ from_address: fromAddress, to_address: toAddress, status: "rate_limited", ended_at: "2026-10-21T12:00:00.000Z" }] });

    await expect(reserveVoiceCallBudget(input)).resolves.toEqual({
      allowed: false,
      reason: "rate_limit",
    });
    expect(statements()).toHaveLength(2);
  });

  it("does not transfer an admitted CallSid to a different caller", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ from_address: "+15559990000", to_address: toAddress, status: "active", ended_at: null }] });

    await expect(reserveVoiceCallBudget(input)).resolves.toEqual({
      allowed: false,
      reason: "identity_mismatch",
    });
    expect(statements()).toHaveLength(2);
  });

  it("does not reopen a finished CallSid on a signed callback replay", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        from_address: fromAddress,
        to_address: toAddress,
        status: "completed",
        ended_at: "2026-10-21T12:00:00.000Z",
      }] });

    await expect(reserveVoiceCallBudget(input)).resolves.toEqual({
      allowed: false,
      reason: "finished",
    });
    expect(statements()[1].sql).toContain("ended_at");
    expect(statements()).toHaveLength(2);
  });

  it("fails closed if the insert loses a CallSid race", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ used: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(reserveVoiceCallBudget(input)).resolves.toEqual({
      allowed: false,
      reason: "unavailable",
    });
  });

  it("fails closed when the database transaction fails", async () => {
    h.transaction.mockRejectedValue(new Error("database offline"));

    await expect(reserveVoiceCallBudget(input)).resolves.toEqual({
      allowed: false,
      reason: "unavailable",
    });
  });

  it("rejects invalid Twilio identifiers before opening a transaction", async () => {
    await expect(reserveVoiceCallBudget({ ...input, fromAddress: "anonymous" })).resolves.toEqual({
      allowed: false,
      reason: "invalid",
    });
    expect(h.transaction).not.toHaveBeenCalled();
  });
});
