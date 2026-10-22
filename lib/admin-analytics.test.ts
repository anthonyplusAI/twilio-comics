import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { execute: h.execute } }));

import {
  buildAdminActivityHistoryQuery,
  buildAdminUserSearchQuery,
  buildActivityHistoryQuery,
  decodeActivityCursor,
  encodeActivityCursor,
  getAdminActivityHistory,
  getAdminDashboard,
  paginateActivityRows,
  summarizeAdminCounts,
} from "@/lib/admin-analytics";

const dialect = new PgDialect();

describe("administrator analytics", () => {
  beforeEach(() => {
    h.execute.mockReset();
  });

  it("keeps search input bound rather than part of SQL syntax", () => {
    const injection = "%' OR TRUE --";
    const query = dialect.sqlToQuery(buildAdminUserSearchQuery(injection, 0, 21));

    expect(query.sql).not.toContain(injection);
    expect(query.sql).toContain("LIMIT");
    expect(query.params).toContain(injection.toLowerCase());
  });

  it("scopes the timeline to a user and known phone address before paging", () => {
    const cursor = encodeActivityCursor({
      occurredAt: new Date("2026-10-20T12:00:00.000Z"),
      id: "11111111-1111-4111-8111-111111111111",
    });
    const query = dialect.sqlToQuery(buildActivityHistoryQuery({
      userId: "user-1",
      addresses: ["+18669012028"],
      cursor: decodeActivityCursor(cursor),
      limit: 51,
    }));

    expect(query.sql).toContain("activity_events");
    expect(query.sql).toContain("user_id");
    expect(query.sql).toContain("user_id IS NULL");
    expect(query.sql).toContain("address");
    expect(query.sql).toContain("occurred_at");
    expect(query.params).toContain("user-1");
    expect(query.params).toContain("+18669012028");
    expect(query.params).toContain(51);
  });

  it("produces a stable next-page cursor and rejects malformed cursors", () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      id: `11111111-1111-4111-8111-11111111111${index}`,
      occurred_at: new Date(`2026-10-20T12:00:0${index}.000Z`),
    }));
    const page = paginateActivityRows(rows, 2);

    expect(page.items).toEqual(rows.slice(0, 2));
    expect(decodeActivityCursor(page.nextCursor)).toEqual({
      occurredAt: rows[1].occurred_at,
      id: rows[1].id,
    });
    expect(decodeActivityCursor("invalid")).toBeNull();
  });

  it("maps empty and populated counts to stable numeric metrics", () => {
    expect(summarizeAdminCounts({
      phone_users: "17",
      sms_inbound: "42",
      sms_inbound_7d: "9",
      message_agent_turns_denied: "6",
      message_agent_turns_denied_7d: "2",
      voice_calls: "8",
      voice_calls_7d: "2",
      voice_calls_rate_limited: "3",
      voice_verifications: "14",
      voice_verifications_denied: "2",
      voice_duration_seconds: "312",
      voice_turns: "31",
      comic_requests: "12",
      comic_requests_7d: "3",
      comics_completed: "10",
      comics_failed: "2",
      delivered: "9",
      delivery_failed: "1",
      agent_reply_delivery_failed: "4",
      outbound_messages: "34",
      outbound_messages_7d: "7",
      event_count: "120",
    })).toMatchObject({
      phoneUsers: 17,
      smsInbound: 42,
      smsInbound7d: 9,
      messageAgentTurnsDenied: 6,
      messageAgentTurnsDenied7d: 2,
      voiceCalls: 8,
      voiceCallsRateLimited: 3,
      voiceVerifications: 14,
      voiceVerificationsDenied: 2,
      voiceDurationSeconds: 312,
      comicsCompleted: 10,
      delivered: 9,
      deliveryFailed: 1,
      agentReplyDeliveryFailed: 4,
    });
    expect(summarizeAdminCounts({}).voiceCallsRateLimited).toBe(0);
    expect(summarizeAdminCounts({})).toMatchObject({ agentReplyDeliveryFailed: 0 });
  });

  it("counts only failed Twilio agent text replies, once per outbound Message SID", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [{ agent_reply_delivery_failed: "4" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const dashboard = await getAdminDashboard();

    expect(dashboard.counts).toMatchObject({ agentReplyDeliveryFailed: 4 });
    const countsSql = dialect.sqlToQuery(h.execute.mock.calls[0][0]).sql;
    expect(countsSql).toMatch(/COUNT\(DISTINCT message_sid\).*?AS agent_reply_delivery_failed/s);
    expect(countsSql).toContain("kind = 'message.delivery'");
    expect(countsSql).toContain("status IN ('failed', 'undelivered')");
    expect(countsSql).toContain("details->>'purpose' = 'agent_reply'");
  });

  it("filters paged operations history to failed agent replies without including comic delivery", () => {
    const cursor = {
      occurredAt: new Date("2026-10-20T12:00:00.000Z"),
      id: "11111111-1111-4111-8111-111111111111",
    };
    const filtered = dialect.sqlToQuery(buildAdminActivityHistoryQuery({
      filter: "failed-agent-replies",
      cursor,
      limit: 41,
    }));
    const all = dialect.sqlToQuery(buildAdminActivityHistoryQuery({ filter: "all", cursor: null, limit: 41 }));

    expect(filtered.sql).toContain("kind = 'message.delivery'");
    expect(filtered.sql).toContain("status IN ('failed', 'undelivered')");
    expect(filtered.sql).toContain("details->>'purpose' = 'agent_reply'");
    expect(filtered.sql).toContain("message_sid IS NOT NULL");
    expect(filtered.sql).toContain("(occurred_at, id) <");
    expect(filtered.sql).toContain("ORDER BY occurred_at DESC, id DESC");
    expect(filtered.params).toContain(41);
    expect(filtered.params).toContain(cursor.id);
    expect(all.sql).not.toContain("details->>'purpose'");
  });

  it("pages the filtered operations history without dropping older failure events", async () => {
    const rows = Array.from({ length: 41 }, (_, index) => ({
      id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
      occurred_at: new Date(Date.UTC(2026, 9, 21, 12, 0, 0) - index * 1000),
    }));
    h.execute.mockResolvedValueOnce({ rows });

    const page = await getAdminActivityHistory("failed-agent-replies", null);

    expect(page.items).toHaveLength(40);
    expect(page.items.at(-1)?.id).toBe(rows[39].id);
    expect(decodeActivityCursor(page.nextCursor)).toEqual({
      occurredAt: rows[39].occurred_at,
      id: rows[39].id,
    });
    const query = dialect.sqlToQuery(h.execute.mock.calls[0][0]);
    expect(query.sql).toContain("details->>'purpose' = 'agent_reply'");
    expect(query.params).toContain(41);
  });

  it("counts durable messaging agent denials for lifetime and trailing week", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [{
        message_agent_turns_denied: "6",
        message_agent_turns_denied_7d: "2",
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const dashboard = await getAdminDashboard();

    expect(dashboard.counts).toMatchObject({
      messageAgentTurnsDenied: 6,
      messageAgentTurnsDenied7d: 2,
    });
    const countsSql = dialect.sqlToQuery(h.execute.mock.calls[0][0]).sql;
    expect(countsSql).toMatch(/kind = 'message\.agent_turn\.denied'\) AS message_agent_turns_denied/);
    expect(countsSql).toMatch(/kind = 'message\.agent_turn\.denied' AND occurred_at >= NOW\(\) - INTERVAL '7 days'\) AS message_agent_turns_denied_7d/);
  });

  it("separates rate-limited calls from answered calls and the call trend", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [{ voice_calls: "8", voice_calls_7d: "2", voice_calls_rate_limited: "3" }] })
      .mockResolvedValueOnce({ rows: [{ day: "2026-10-21", sms_inbound: "1", voice_calls: "2", comics_completed: "1" }] })
      .mockResolvedValueOnce({ rows: [] });

    const dashboard = await getAdminDashboard();
    expect(dashboard.counts).toMatchObject({ voiceCalls: 8, voiceCalls7d: 2, voiceCallsRateLimited: 3 });
    expect(dashboard.trend).toMatchObject([{ day: "2026-10-21", voiceCalls: 2 }]);

    const countsSql = dialect.sqlToQuery(h.execute.mock.calls[0][0]).sql;
    const trendSql = dialect.sqlToQuery(h.execute.mock.calls[1][0]).sql;
    expect(countsSql).toMatch(/COUNT\(\*\) FROM voice_calls\s+WHERE status <> 'rate_limited'\) AS voice_calls/);
    expect(countsSql).toMatch(/COUNT\(\*\) FROM voice_calls\s+WHERE status <> 'rate_limited'\s+AND started_at >= .*\) AS voice_calls_7d/);
    expect(countsSql).toMatch(/COUNT\(\*\) FROM voice_calls\s+WHERE status = 'rate_limited'\) AS voice_calls_rate_limited/);
    expect(trendSql).toMatch(/FROM voice_calls\s+WHERE started_at >= CURRENT_DATE - 13\s+AND status <> 'rate_limited'/);
  });
});
