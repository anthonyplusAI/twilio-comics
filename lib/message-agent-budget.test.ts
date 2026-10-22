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

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("MESSAGE_AGENT_GLOBAL_DAILY_LIMIT", undefined);
  h.transaction.mockImplementation(async (run) => run({ execute: h.execute }));
});

afterEach(() => vi.unstubAllEnvs());

describe("inbound messaging AI turn budget", () => {
  it("reserves the twentieth hourly and eightieth daily turn under a sender lock", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ hour_count: 19, day_count: 79, notice_count: 0, global_count: 199 }] })
      .mockResolvedValueOnce({ rows: [{ id: "event-id" }] });

    await expect(reserveMessageAgentTurn(request)).resolves.toEqual({
      allowed: true, duplicate: false,
    });

    expect(queries()).toHaveLength(5);
    expect(queries()[0].sql).toContain("pg_advisory_xact_lock");
    expect(queries()[1].params).toContain(request.fromAddress);
    expect(queries()[3].sql).toContain("INTERVAL '1 hour'");
    expect(queries()[3].sql).toContain("INTERVAL '24 hours'");
    expect(queries()[3].params).toEqual(expect.arrayContaining([
      "+15551112222", "whatsapp:+15551112222",
    ]));
    expect(queries()[4].sql).toContain("ON CONFLICT (event_key) DO NOTHING");
    expect(queries()[4].params).toEqual(expect.arrayContaining([
      "message:SM123:agent-turn", "message.agent_turn.reserved", "reserved",
    ]));
    // jsonb_build_object(VARIADIC "any") cannot infer a prepared parameter's
    // type. Verify the SQL sent to PostgreSQL gives each detail a concrete type.
    const insert = queries()[4];
    expect(insert.params.slice(-5)).toEqual([request.toAddress, 19, 79, 199, 200]);
    expect(insert.sql).toMatch(/'toAddress', \$\d+::text/);
    expect(insert.sql).toMatch(/'hourCount', \$\d+::integer/);
    expect(insert.sql).toMatch(/'dayCount', \$\d+::integer/);
    expect(insert.sql).toMatch(/'globalCount', \$\d+::integer/);
    expect(insert.sql).toMatch(/'globalLimit', \$\d+::bigint/);
  });

  it("uses the same phone budget for a WhatsApp turn", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ hour_count: 19, day_count: 79, notice_count: 0, global_count: 199 }] })
      .mockResolvedValueOnce({ rows: [{ id: "event-id" }] });

    await expect(reserveMessageAgentTurn({
      messageSid: "SMwhatsapp1",
      channel: "whatsapp",
      fromAddress: `whatsapp:${request.fromAddress}`,
      toAddress: "whatsapp:+14155238886",
    })).resolves.toEqual({ allowed: true, duplicate: false });

    expect(queries()[1].params).toContain(request.fromAddress);
    expect(queries()[3].params).toEqual(expect.arrayContaining([
      request.fromAddress, `whatsapp:${request.fromAddress}`,
    ]));
    expect(queries()[4].params).toContain("whatsapp");
  });

  it("denies the twenty-first turn in an hour with one saved notice", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ hour_count: 20, day_count: 20, notice_count: 0, global_count: 20 }] })
      .mockResolvedValueOnce({ rows: [{ id: "denial-id" }] });

    await expect(reserveMessageAgentTurn(request)).resolves.toEqual({
      allowed: false, reason: "rate_limit", sendNotice: true,
    });
    expect(queries()[4].params).toEqual(expect.arrayContaining([
      "message.agent_turn.denied", "notice_pending",
    ]));
  });

  it("silently denies the eighty-first turn in 24 hours after a prior channel notice", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ hour_count: 1, day_count: 80, notice_count: 1, global_count: 80 }] })
      .mockResolvedValueOnce({ rows: [{ id: "denial-id" }] });

    await expect(reserveMessageAgentTurn(request)).resolves.toEqual({
      allowed: false, reason: "rate_limit", sendNotice: false,
    });
    expect(queries()[4].params).toEqual(expect.arrayContaining([
      "message.agent_turn.denied", "silent",
    ]));
  });

  it("lets a retry of the same SID finish its reserved turn without consuming a second slot", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        channel: "sms", address: request.fromAddress, status: "reserved",
        kind: "message.agent_turn.reserved", details: { toAddress: request.toAddress },
      }] });

    await expect(reserveMessageAgentTurn(request)).resolves.toEqual({
      allowed: true, duplicate: true,
    });
    expect(queries()).toHaveLength(3);
  });

  it.each([
    ["notice_pending", true],
    ["silent", false],
  ] as const)("keeps a retried %s denial and its reply decision", async (status, sendNotice) => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        channel: "sms", address: request.fromAddress, status,
        kind: "message.agent_turn.denied", details: { toAddress: request.toAddress },
      }] });

    await expect(reserveMessageAgentTurn(request)).resolves.toEqual({
      allowed: false, reason: "rate_limit", sendNotice,
    });
    expect(queries()).toHaveLength(3);
  });

  it("does not reuse a SID reserved by a different sender", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        channel: "sms", address: "+15559990000", status: "reserved",
        kind: "message.agent_turn.reserved", details: { toAddress: request.toAddress },
      }] });

    await expect(reserveMessageAgentTurn(request)).resolves.toEqual({
      allowed: false, reason: "invalid",
    });
    expect(queries()).toHaveLength(3);
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

  it("denies a new sender after all senders together consume the global daily budget", async () => {
    vi.stubEnv("MESSAGE_AGENT_GLOBAL_DAILY_LIMIT", "200");
    h.execute
      .mockResolvedValueOnce({ rows: [] }) // Global lock, first sender.
      .mockResolvedValueOnce({ rows: [] }) // Sender lock.
      .mockResolvedValueOnce({ rows: [] }) // No existing MessageSid.
      .mockResolvedValueOnce({ rows: [{ hour_count: 0, day_count: 0, notice_count: 0, global_count: 199 }] })
      .mockResolvedValueOnce({ rows: [{ id: "first-reservation" }] })
      .mockResolvedValueOnce({ rows: [] }) // Global lock, second sender.
      .mockResolvedValueOnce({ rows: [] }) // Sender lock.
      .mockResolvedValueOnce({ rows: [] }) // No existing MessageSid.
      .mockResolvedValueOnce({ rows: [{ hour_count: 0, day_count: 0, notice_count: 0, global_count: 200 }] })
      .mockResolvedValueOnce({ rows: [{ id: "second-denial" }] });

    await expect(reserveMessageAgentTurn(request)).resolves.toEqual({
      allowed: true, duplicate: false,
    });
    await expect(reserveMessageAgentTurn({
      ...request,
      messageSid: "SM124",
      channel: "whatsapp",
      fromAddress: "whatsapp:+15551113333",
      toAddress: "whatsapp:+14155238886",
    })).resolves.toEqual({ allowed: false, reason: "rate_limit", sendNotice: true });

    const issued = queries();
    expect(issued).toHaveLength(10);
    expect(issued[0].sql).toContain("pg_advisory_xact_lock");
    expect(issued[0].sql).toContain("message-agent-global-budget");
    expect(issued[1].params).toContain(request.fromAddress);
    expect(issued[5].sql).toContain("message-agent-global-budget");
    expect(issued[6].params).toContain("+15551113333");
    expect(issued[3].sql).toMatch(/channel IN \('sms',\s*'whatsapp'\)/);
    expect(issued[3].sql).toContain("AS global_count");
    expect(issued[9].params).toEqual(expect.arrayContaining([
      "whatsapp", "message.agent_turn.denied", "notice_pending", 200,
    ]));
  });

  it("keeps a duplicate MessageSid reservation without counting another global turn", async () => {
    vi.stubEnv("MESSAGE_AGENT_GLOBAL_DAILY_LIMIT", "0");
    h.execute
      .mockResolvedValueOnce({ rows: [] }) // Global lock.
      .mockResolvedValueOnce({ rows: [] }) // Sender lock.
      .mockResolvedValueOnce({ rows: [{
        channel: "sms", address: request.fromAddress, status: "reserved",
        kind: "message.agent_turn.reserved", details: { toAddress: request.toAddress },
      }] });

    await expect(reserveMessageAgentTurn(request)).resolves.toEqual({
      allowed: true, duplicate: true,
    });
    expect(queries()).toHaveLength(3);
  });

  it("uses a zero global limit to pause new turns and retain the normal notice behavior", async () => {
    vi.stubEnv("MESSAGE_AGENT_GLOBAL_DAILY_LIMIT", "0");
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ hour_count: 0, day_count: 0, notice_count: 0, global_count: 0 }] })
      .mockResolvedValueOnce({ rows: [{ id: "paused-denial" }] });

    await expect(reserveMessageAgentTurn(request)).resolves.toEqual({
      allowed: false, reason: "rate_limit", sendNotice: true,
    });
    expect(queries()[4].params).toEqual(expect.arrayContaining([
      "message.agent_turn.denied", "notice_pending", 0,
    ]));
  });

  it.each(["", "-1", "1.5", "unlimited", "9007199254740992"])(
    "fails closed without querying the database for invalid global limit %s",
    async (configured) => {
      vi.stubEnv("MESSAGE_AGENT_GLOBAL_DAILY_LIMIT", configured);
      await expect(reserveMessageAgentTurn(request)).resolves.toEqual({
        allowed: false, reason: "unavailable",
      });
      expect(h.transaction).not.toHaveBeenCalled();
    },
  );
});
