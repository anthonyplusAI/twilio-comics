import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({ transaction: vi.fn(), execute: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: { transaction: h.transaction, execute: h.execute },
}));

import {
  finishVoiceVerificationStart,
  reserveVoiceVerificationStart,
} from "@/lib/voice-verification-budget";

const callSid = "CA" + "a".repeat(32);
const request = {
  callSid,
  fromAddress: "+15551112222",
  toAddress: "+18669012028",
};
const dialect = new PgDialect();

function queries(): Array<{ sql: string; params: unknown[] }> {
  return h.execute.mock.calls.map((call: unknown[]) => dialect.sqlToQuery(call[0] as SQL));
}

function mockFreshReservation(
  usage: { caller_hour_count: number | null; caller_day_count: number | null },
  id = "event-id",
) {
  h.execute
    .mockResolvedValueOnce({ rows: [] }) // Caller lock.
    .mockResolvedValueOnce({ rows: [] }) // New CallSid.
    .mockResolvedValueOnce({ rows: [usage] })
    .mockResolvedValueOnce({ rows: [{ id }] });
}

beforeEach(() => {
  vi.resetAllMocks();
  h.transaction.mockImplementation(async (run) => run({ execute: h.execute }));
});

afterEach(() => vi.unstubAllEnvs());

describe("Voice Verify SMS start budget", () => {
  it("reserves the fourth hourly and tenth daily caller start", async () => {
    mockFreshReservation({ caller_hour_count: 3, caller_day_count: 9 });

    await expect(reserveVoiceVerificationStart(request)).resolves.toEqual({
      allowed: true, sendCode: true,
    });

    const issued = queries();
    expect(issued).toHaveLength(4);
    expect(issued[0].sql).toContain("pg_advisory_xact_lock");
    expect(issued[0].sql).toContain("twilio-comics:voice-verify:caller");
    expect(issued[0].params).toContain(request.fromAddress);
    expect(issued[2].sql).toContain("INTERVAL '24 hours'");
    expect(issued[2].sql).toContain("INTERVAL '1 hour'");
    expect(issued[2].params).toContain(request.fromAddress);
    expect(issued[2].sql).not.toContain("number_hour_count");
    expect(issued[3].sql).toContain("ON CONFLICT (event_key) DO NOTHING");
    expect(issued[3].params).toEqual(expect.arrayContaining([
      request.fromAddress, request.toAddress, "voice.verification.requested", "reserved",
    ]));
    expect(issued[3].params.slice(-2)).toEqual([request.toAddress, null]);
    expect(issued[3].sql).toMatch(/'toAddress', \$\d+::text, 'budgetLimit', \$\d+::text/);
  });

  it("denies a fifth start in the hour and records the caller reason", async () => {
    mockFreshReservation({ caller_hour_count: 4, caller_day_count: 4 }, "denied-event");

    await expect(reserveVoiceVerificationStart(request)).resolves.toEqual({
      allowed: false, reason: "rate_limit",
    });
    expect(queries()[3].params).toEqual(expect.arrayContaining([
      "voice.verification.denied", "caller_hour",
    ]));
  });

  it("denies an eleventh start in 24 hours", async () => {
    mockFreshReservation({ caller_hour_count: 0, caller_day_count: 10 }, "denied-event");

    await expect(reserveVoiceVerificationStart(request)).resolves.toEqual({
      allowed: false, reason: "rate_limit",
    });
    expect(queries()[3].params).toContain("caller_day");
  });

  it("allows another caller regardless of the old recipient-wide setting", async () => {
    vi.stubEnv("VOICE_VERIFY_NUMBER_DAILY_LIMIT", "0");
    mockFreshReservation({ caller_hour_count: 0, caller_day_count: 0 }, "first");
    mockFreshReservation({ caller_hour_count: 0, caller_day_count: 0 }, "second");

    await expect(reserveVoiceVerificationStart(request)).resolves.toEqual({
      allowed: true, sendCode: true,
    });
    const secondCaller = "+15553334444";
    await expect(reserveVoiceVerificationStart({
      ...request, callSid: "CA" + "b".repeat(32), fromAddress: secondCaller,
    })).resolves.toEqual({ allowed: true, sendCode: true });

    const issued = queries();
    expect(issued).toHaveLength(8);
    expect(issued[0].params).toContain(request.fromAddress);
    expect(issued[4].params).toContain(secondCaller);
    expect(issued[2].params).not.toContain(secondCaller);
    expect(issued[6].params).not.toContain(request.fromAddress);
    expect(issued.map((query) => query.sql).join("\n"))
      .not.toContain("twilio-comics:voice-verify:recipient");
  });

  it("reuses a code already sent for a retried Twilio webhook", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        address: request.fromAddress,
        status: "sent",
        details: { toAddress: request.toAddress },
      }] });

    await expect(reserveVoiceVerificationStart(request)).resolves.toEqual({
      allowed: true, sendCode: false,
    });
    expect(queries()).toHaveLength(2);
  });

  it("does not send a second code while the first request is in progress", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        address: request.fromAddress,
        status: "reserved",
        details: { toAddress: request.toAddress },
      }] });

    await expect(reserveVoiceVerificationStart(request)).resolves.toEqual({
      allowed: false, reason: "in_progress",
    });
  });

  it("rejects a retried CallSid belonging to another caller", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        address: "+15559990000",
        status: "sent",
        details: { toAddress: request.toAddress },
      }] });

    await expect(reserveVoiceVerificationStart(request)).resolves.toEqual({
      allowed: false, reason: "invalid",
    });
  });

  it("fails closed on database outage, invalid caller, or malformed usage", async () => {
    h.transaction.mockRejectedValueOnce(new Error("offline"));
    await expect(reserveVoiceVerificationStart(request)).resolves.toEqual({
      allowed: false, reason: "unavailable",
    });
    await expect(reserveVoiceVerificationStart({
      ...request, fromAddress: "anonymous",
    })).resolves.toEqual({ allowed: false, reason: "invalid" });

    mockFreshReservation({ caller_hour_count: null, caller_day_count: 0 });
    await expect(reserveVoiceVerificationStart(request)).resolves.toEqual({
      allowed: false, reason: "unavailable",
    });
    expect(queries()).toHaveLength(3);
  });

  it("marks a reservation sent only after the provider accepts it", async () => {
    h.execute.mockResolvedValueOnce({ rows: [{ id: "event-id" }] });

    await finishVoiceVerificationStart(callSid, "sent");
    expect(queries()[0].sql).toMatch(/UPDATE activity_events[\s\S]*status = 'reserved'/i);
    expect(queries()[0].params).toContain("sent");
  });
});
