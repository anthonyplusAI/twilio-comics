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

const callSid = `CA${"a".repeat(32)}`;
const request = {
  callSid,
  fromAddress: "+15551112222",
  toAddress: "+18669012028",
};
const dialect = new PgDialect();

interface Usage {
  caller_hour_count: number;
  caller_day_count: number;
  number_hour_count: number;
  number_day_count: number;
}

function mockFreshReservation(usage: Usage, id = "event-id") {
  h.execute
    .mockResolvedValueOnce({ rows: [] }) // number lock
    .mockResolvedValueOnce({ rows: [] }) // caller lock
    .mockResolvedValueOnce({ rows: [] }) // CallSid lookup
    .mockResolvedValueOnce({ rows: [usage] })
    .mockResolvedValueOnce({ rows: [{ id }] });
}

function queries(): Array<{ sql: string; params: unknown[] }> {
  return h.execute.mock.calls.map((call: unknown[]) => dialect.sqlToQuery(call[0] as SQL));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("VOICE_VERIFY_NUMBER_DAILY_LIMIT", undefined);
  h.transaction.mockImplementation(async (run) => run({ execute: h.execute }));
});

afterEach(() => vi.unstubAllEnvs());

describe("Voice Verify SMS start budget", () => {
  it("reserves the fourth caller start with recipient and caller locks and durable CallSid", async () => {
    mockFreshReservation({
      caller_hour_count: 3,
      caller_day_count: 9,
      number_hour_count: 11,
      number_day_count: 39,
    });

    await expect(reserveVoiceVerificationStart(request)).resolves.toEqual({
      allowed: true, sendCode: true,
    });
    expect(queries()).toHaveLength(5);
    expect(queries()[0].sql).toContain("pg_advisory_xact_lock");
    expect(queries()[0].sql).toContain("twilio-comics:voice-verify:recipient");
    expect(queries()[0].params).toContain(request.toAddress);
    expect(queries()[0].params).not.toContain(request.fromAddress);
    expect(queries()[1].sql).toContain("twilio-comics:voice-verify:caller");
    expect(queries()[1].params).toContain(request.fromAddress);
    expect(queries()[3].sql).toContain("INTERVAL '24 hours'");
    expect(queries()[3].sql).toContain("INTERVAL '1 hour'");
    expect(queries()[3].sql).toContain("details->>'toAddress'");
    expect(queries()[3].params).toContain(request.toAddress);
    expect(queries()[4].sql).toContain("ON CONFLICT (event_key) DO NOTHING");
    expect(queries()[4].params).toEqual(expect.arrayContaining([
      request.fromAddress, request.toAddress, "voice.verification.requested", "reserved",
    ]));
  });

  it("denies a fifth start in the hour and records that denial", async () => {
    mockFreshReservation({
      caller_hour_count: 4,
      caller_day_count: 4,
      number_hour_count: 4,
      number_day_count: 4,
    }, "denied-event");

    await expect(reserveVoiceVerificationStart(request)).resolves.toEqual({
      allowed: false, reason: "rate_limit",
    });
    expect(queries()[4].params).toContain("voice.verification.denied");
  });

  it("keeps the caller's daily cap even when the number has room", async () => {
    mockFreshReservation({
      caller_hour_count: 0,
      caller_day_count: 10,
      number_hour_count: 0,
      number_day_count: 10,
    }, "caller-daily-denial");

    await expect(reserveVoiceVerificationStart(request)).resolves.toEqual({
      allowed: false, reason: "rate_limit",
    });
    expect(queries()[4].params).toContain("caller_day");
  });

  it("denies a new caller at the number's hourly cap and records the denial", async () => {
    mockFreshReservation({
      caller_hour_count: 0,
      caller_day_count: 0,
      number_hour_count: 12,
      number_day_count: 12,
    }, "hourly-denial");

    await expect(reserveVoiceVerificationStart(request)).resolves.toEqual({
      allowed: false, reason: "rate_limit",
    });
    expect(queries()[4].params).toEqual(expect.arrayContaining([
      request.toAddress, "voice.verification.denied", "denied", "number_hour",
    ]));
  });

  it("denies a new caller at the number's daily cap", async () => {
    mockFreshReservation({
      caller_hour_count: 0,
      caller_day_count: 0,
      number_hour_count: 0,
      number_day_count: 40,
    }, "daily-denial");

    await expect(reserveVoiceVerificationStart(request)).resolves.toEqual({
      allowed: false, reason: "rate_limit",
    });
    expect(queries()[4].params).toEqual(expect.arrayContaining([
      "voice.verification.denied", "number_day",
    ]));
  });

  it("allows a pilot number's fourth start in 24 hours", async () => {
    vi.stubEnv("VOICE_VERIFY_NUMBER_DAILY_LIMIT", "4");
    mockFreshReservation({
      caller_hour_count: 0,
      caller_day_count: 0,
      number_hour_count: 3,
      number_day_count: 3,
    });

    await expect(reserveVoiceVerificationStart(request)).resolves.toEqual({
      allowed: true, sendCode: true,
    });
  });

  it("denies the next pilot start once the number reaches four in 24 hours", async () => {
    vi.stubEnv("VOICE_VERIFY_NUMBER_DAILY_LIMIT", "4");
    mockFreshReservation({
      caller_hour_count: 0,
      caller_day_count: 0,
      number_hour_count: 4,
      number_day_count: 4,
    });

    await expect(reserveVoiceVerificationStart(request)).resolves.toEqual({
      allowed: false, reason: "rate_limit",
    });
    expect(queries()[4].params).toContain("number_day");
  });

  it("pauses new Verify starts when the number's daily limit is zero", async () => {
    vi.stubEnv("VOICE_VERIFY_NUMBER_DAILY_LIMIT", "0");
    mockFreshReservation({
      caller_hour_count: 0,
      caller_day_count: 0,
      number_hour_count: 0,
      number_day_count: 0,
    });

    await expect(reserveVoiceVerificationStart(request)).resolves.toEqual({
      allowed: false, reason: "rate_limit",
    });
    expect(queries()[0].sql).toContain("pg_advisory_xact_lock");
    expect(queries()[4].params).toContain("number_day");
  });

  it.each(["", "-1", "4.5", "abc", "9007199254740992"])(
    "fails closed for invalid daily number limit %j",
    async (configuredLimit) => {
      vi.stubEnv("VOICE_VERIFY_NUMBER_DAILY_LIMIT", configuredLimit);

      await expect(reserveVoiceVerificationStart(request)).resolves.toEqual({
        allowed: false, reason: "unavailable",
      });
      expect(h.transaction).not.toHaveBeenCalled();
    },
  );

  it("takes the same number lock for different caller IDs", async () => {
    const secondCaller = {
      ...request,
      callSid: `CA${"b".repeat(32)}`,
      fromAddress: "+15553334444",
    };
    const counts = {
      caller_hour_count: 0,
      caller_day_count: 0,
      number_hour_count: 0,
      number_day_count: 0,
    };
    mockFreshReservation(counts);
    await reserveVoiceVerificationStart(request);
    mockFreshReservation(counts);
    await reserveVoiceVerificationStart(secondCaller);

    const statements = queries();
    expect(statements[0].params).toEqual(statements[5].params);
    expect(statements[1].params).not.toEqual(statements[6].params);
  });

  it("reuses a code already sent for a retried Twilio webhook", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        address: request.fromAddress,
        status: "sent",
        details: { toAddress: request.toAddress },
      }] });

    await expect(reserveVoiceVerificationStart(request)).resolves.toEqual({
      allowed: true, sendCode: false,
    });
    expect(queries()).toHaveLength(3);
  });

  it("does not send a second code while the first request is in progress", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
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

  it("fails closed on a database outage or invalid caller ID", async () => {
    h.transaction.mockRejectedValueOnce(new Error("offline"));
    await expect(reserveVoiceVerificationStart(request)).resolves.toEqual({
      allowed: false, reason: "unavailable",
    });
    await expect(reserveVoiceVerificationStart({ ...request, fromAddress: "anonymous" })).resolves.toEqual({
      allowed: false, reason: "invalid",
    });
    expect(h.transaction).toHaveBeenCalledOnce();
  });

  it("fails closed when the number usage count is unavailable", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        caller_hour_count: 0,
        caller_day_count: 0,
        number_hour_count: null,
        number_day_count: 0,
      }] });

    await expect(reserveVoiceVerificationStart(request)).resolves.toEqual({
      allowed: false, reason: "unavailable",
    });
    expect(queries()).toHaveLength(4);
  });

  it("marks a reservation sent only after the provider accepts it", async () => {
    h.execute.mockResolvedValueOnce({ rows: [{ id: "event-id" }] });

    await finishVoiceVerificationStart(callSid, "sent");
    expect(queries()[0].sql).toMatch(/UPDATE activity_events[\s\S]*status = 'reserved'/i);
    expect(queries()[0].params).toContain("sent");
  });
});
