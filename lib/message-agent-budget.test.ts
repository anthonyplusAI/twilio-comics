import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function mockFreshTurn(
  usage: { hour_count: number; day_count: number; notice_count: number },
  id = "event-id",
) {
  h.execute
    .mockResolvedValueOnce({ rows: [] }) // Phone lock.
    .mockResolvedValueOnce({ rows: [] }) // New MessageSid.
    .mockResolvedValueOnce({ rows: [usage] })
    .mockResolvedValueOnce({ rows: [{ id }] });
}

beforeEach(() => {
  vi.resetAllMocks();
  h.transaction.mockImplementation(async (run) => run({ execute: h.execute }));
});

afterEach(() => vi.unstubAllEnvs());

describe("inbound messaging AI turn budget", () => {
  it("reserves the twentieth hourly and eightieth daily turn under a phone lock", async () => {
    mockFreshTurn({ hour_count: 19, day_count: 79, notice_count: 0 });

    await expect(reserveMessageAgentTurn(request)).resolves.toEqual({
      allowed: true, duplicate: false,
    });

    const issued = queries();
    expect(issued).toHaveLength(4);
    expect(issued[0].sql).toContain("pg_advisory_xact_lock");
    expect(issued[0].params).toContain(request.fromAddress);
    expect(issued[2].sql).toContain("INTERVAL '1 hour'");
    expect(issued[2].sql).toContain("INTERVAL '24 hours'");
    expect(issued[2].params).toEqual(expect.arrayContaining([
      "+15551112222", "whatsapp:+15551112222",
    ]));
    expect(issued[2].sql).not.toContain("global_count");
    expect(issued[3].sql).toContain("ON CONFLICT (event_key) DO NOTHING");
    expect(issued[3].params).toEqual(expect.arrayContaining([
      "message:SM123:agent-turn", "message.agent_turn.reserved", "reserved",
    ]));
    // PostgreSQL needs concrete types for parameters inside jsonb_build_object.
    expect(issued[3].params.slice(-3)).toEqual([request.toAddress, 19, 79]);
    expect(issued[3].sql).toMatch(/'toAddress', \$\d+::text/);
    expect(issued[3].sql).toMatch(/'hourCount', \$\d+::integer/);
    expect(issued[3].sql).toMatch(/'dayCount', \$\d+::integer/);
  });

  it("shares one phone budget between SMS and WhatsApp", async () => {
    mockFreshTurn({ hour_count: 19, day_count: 79, notice_count: 0 });

    await expect(reserveMessageAgentTurn({
      messageSid: "SMwhatsapp1",
      channel: "whatsapp",
      fromAddress: "whatsapp:" + request.fromAddress,
      toAddress: "whatsapp:+14155238886",
    })).resolves.toEqual({ allowed: true, duplicate: false });

    expect(queries()[0].params).toContain(request.fromAddress);
    expect(queries()[2].params).toEqual(expect.arrayContaining([
      request.fromAddress, "whatsapp:" + request.fromAddress,
    ]));
    expect(queries()[3].params).toContain("whatsapp");
  });

  it("denies the twenty-first turn in an hour with one saved notice", async () => {
    mockFreshTurn({ hour_count: 20, day_count: 20, notice_count: 0 }, "denial-id");

    await expect(reserveMessageAgentTurn(request)).resolves.toEqual({
      allowed: false, reason: "rate_limit", sendNotice: true,
    });
    expect(queries()[3].params).toEqual(expect.arrayContaining([
      "message.agent_turn.denied", "notice_pending",
    ]));
  });

  it("silently denies the eighty-first turn after a prior notice", async () => {
    mockFreshTurn({ hour_count: 1, day_count: 80, notice_count: 1 }, "denial-id");

    await expect(reserveMessageAgentTurn(request)).resolves.toEqual({
      allowed: false, reason: "rate_limit", sendNotice: false,
    });
    expect(queries()[3].params).toEqual(expect.arrayContaining([
      "message.agent_turn.denied", "silent",
    ]));
  });

  it("reuses the original decision for a retried MessageSid", async () => {
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
  ] as const)("reuses a retried %s denial", async (status, sendNotice) => {
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

  it("rejects a MessageSid belonging to another sender", async () => {
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

  it("does not block a second phone when an obsolete global setting is zero", async () => {
    vi.stubEnv("MESSAGE_AGENT_GLOBAL_DAILY_LIMIT", "0");
    mockFreshTurn({ hour_count: 0, day_count: 0, notice_count: 0 }, "first");
    mockFreshTurn({ hour_count: 0, day_count: 0, notice_count: 0 }, "second");

    await expect(reserveMessageAgentTurn(request)).resolves.toEqual({
      allowed: true, duplicate: false,
    });
    const secondPhone = "+15553334444";
    await expect(reserveMessageAgentTurn({
      ...request, messageSid: "SM124", fromAddress: secondPhone,
    })).resolves.toEqual({ allowed: true, duplicate: false });

    const issued = queries();
    expect(issued).toHaveLength(8);
    expect(issued[0].params).toContain(request.fromAddress);
    expect(issued[4].params).toContain(secondPhone);
    expect(issued[2].params).not.toContain(secondPhone);
    expect(issued[6].params).not.toContain(request.fromAddress);
    expect(issued.map((query) => query.sql).join("\n"))
      .not.toContain("message-agent-global-budget");
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
