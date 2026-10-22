import { beforeEach, describe, expect, it, vi } from "vitest";
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

function queries(): Array<{ sql: string; params: unknown[] }> {
  return h.execute.mock.calls.map((call: unknown[]) => dialect.sqlToQuery(call[0] as SQL));
}

beforeEach(() => {
  vi.resetAllMocks();
  h.transaction.mockImplementation(async (run) => run({ execute: h.execute }));
});

describe("Voice Verify SMS start budget", () => {
  it("reserves the fourth start in an hour with a caller lock and durable CallSid", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ hour_count: 3, day_count: 9 }] })
      .mockResolvedValueOnce({ rows: [{ id: "event-id" }] });

    await expect(reserveVoiceVerificationStart(request)).resolves.toEqual({
      allowed: true, sendCode: true,
    });
    expect(queries()).toHaveLength(4);
    expect(queries()[0].sql).toContain("pg_advisory_xact_lock");
    expect(queries()[2].sql).toContain("INTERVAL '24 hours'");
    expect(queries()[2].sql).toContain("INTERVAL '1 hour'");
    expect(queries()[3].sql).toContain("ON CONFLICT (event_key) DO NOTHING");
    expect(queries()[3].params).toEqual(expect.arrayContaining([
      request.fromAddress, request.toAddress, "voice.verification.requested", "reserved",
    ]));
  });

  it("denies a fifth start in the hour and records that denial", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ hour_count: 4, day_count: 4 }] })
      .mockResolvedValueOnce({ rows: [{ id: "denied-event" }] });

    await expect(reserveVoiceVerificationStart(request)).resolves.toEqual({
      allowed: false, reason: "rate_limit",
    });
    expect(queries()[3].params).toContain("voice.verification.denied");
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

  it("marks a reservation sent only after the provider accepts it", async () => {
    h.execute.mockResolvedValueOnce({ rows: [{ id: "event-id" }] });

    await finishVoiceVerificationStart(callSid, "sent");
    expect(queries()[0].sql).toMatch(/UPDATE activity_events[\s\S]*status = 'reserved'/i);
    expect(queries()[0].params).toContain("sent");
  });
});
