import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({ transaction: vi.fn(), execute: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { transaction: h.transaction } }));

import { reserveMessageAgentTurn } from "@/lib/message-agent-budget";

const request = {
  messageSid: "SM123",
  channel: "sms" as const,
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

describe("inbound messaging AI turn budget", () => {
  it("reserves the twentieth hourly and eightieth daily turn under a sender lock", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ hour_count: 19, day_count: 79, notice_count: 0 }] })
      .mockResolvedValueOnce({ rows: [{ id: "event-id" }] });

    await expect(reserveMessageAgentTurn(request)).resolves.toEqual({
      allowed: true, duplicate: false,
    });

    expect(queries()).toHaveLength(4);
    expect(queries()[0].sql).toContain("pg_advisory_xact_lock");
    expect(queries()[2].sql).toContain("INTERVAL '1 hour'");
    expect(queries()[2].sql).toContain("INTERVAL '24 hours'");
    expect(queries()[2].params).toEqual(expect.arrayContaining([
      "+15551112222", "whatsapp:+15551112222",
    ]));
    expect(queries()[3].sql).toContain("ON CONFLICT (event_key) DO NOTHING");
    expect(queries()[3].params).toEqual(expect.arrayContaining([
      "message:SM123:agent-turn", "message.agent_turn.reserved", "reserved",
    ]));
  });

  it("uses the same phone budget for a WhatsApp turn", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ hour_count: 19, day_count: 79, notice_count: 0 }] })
      .mockResolvedValueOnce({ rows: [{ id: "event-id" }] });

    await expect(reserveMessageAgentTurn({
      messageSid: "SMwhatsapp1",
      channel: "whatsapp",
      fromAddress: `whatsapp:${request.fromAddress}`,
      toAddress: "whatsapp:+14155238886",
    })).resolves.toEqual({ allowed: true, duplicate: false });

    expect(queries()[0].params).toContain(request.fromAddress);
    expect(queries()[2].params).toEqual(expect.arrayContaining([
      request.fromAddress, `whatsapp:${request.fromAddress}`,
    ]));
    expect(queries()[3].params).toContain("whatsapp");
  });

  it("denies the twenty-first turn in an hour with one saved notice", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ hour_count: 20, day_count: 20, notice_count: 0 }] })
      .mockResolvedValueOnce({ rows: [{ id: "denial-id" }] });

    await expect(reserveMessageAgentTurn(request)).resolves.toEqual({
      allowed: false, reason: "rate_limit", sendNotice: true,
    });
    expect(queries()[3].params).toEqual(expect.arrayContaining([
      "message.agent_turn.denied", "notice_pending",
    ]));
  });

  it("silently denies the eighty-first turn in 24 hours after a prior channel notice", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ hour_count: 1, day_count: 80, notice_count: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: "denial-id" }] });

    await expect(reserveMessageAgentTurn(request)).resolves.toEqual({
      allowed: false, reason: "rate_limit", sendNotice: false,
    });
    expect(queries()[3].params).toEqual(expect.arrayContaining([
      "message.agent_turn.denied", "silent",
    ]));
  });

  it("lets a retry of the same SID finish its reserved turn without consuming a second slot", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        channel: "sms", address: request.fromAddress, status: "reserved",
        kind: "message.agent_turn.reserved", details: { toAddress: request.toAddress },
      }] });

    await expect(reserveMessageAgentTurn(request)).resolves.toEqual({
      allowed: true, duplicate: true,
    });
    expect(queries()).toHaveLength(2);
  });

  it.each([
    ["notice_pending", true],
    ["silent", false],
  ] as const)("keeps a retried %s denial and its reply decision", async (status, sendNotice) => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        channel: "sms", address: request.fromAddress, status,
        kind: "message.agent_turn.denied", details: { toAddress: request.toAddress },
      }] });

    await expect(reserveMessageAgentTurn(request)).resolves.toEqual({
      allowed: false, reason: "rate_limit", sendNotice,
    });
    expect(queries()).toHaveLength(2);
  });

  it("does not reuse a SID reserved by a different sender", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        channel: "sms", address: "+15559990000", status: "reserved",
        kind: "message.agent_turn.reserved", details: { toAddress: request.toAddress },
      }] });

    await expect(reserveMessageAgentTurn(request)).resolves.toEqual({
      allowed: false, reason: "invalid",
    });
    expect(queries()).toHaveLength(2);
  });

  it("fails closed for database outages and malformed channel addresses", async () => {
    h.transaction.mockRejectedValueOnce(new Error("offline"));
    await expect(reserveMessageAgentTurn(request)).resolves.toEqual({
      allowed: false, reason: "unavailable",
    });
    await expect(reserveMessageAgentTurn({
      ...request, channel: "whatsapp", fromAddress: request.fromAddress,
    })).resolves.toEqual({ allowed: false, reason: "invalid" });
    expect(h.transaction).toHaveBeenCalledOnce();
  });
});
