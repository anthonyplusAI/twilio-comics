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
import { parseAdminDashboardRange } from "@/lib/admin-dashboard-range";

const dialect = new PgDialect();
const now = new Date("2026-10-23T23:42:00.000Z");

function countSubquery(sqlText: string, alias: string): string {
  const end = sqlText.indexOf(`) AS ${alias}`);
  expect(end).toBeGreaterThan(-1);
  const start = sqlText.lastIndexOf("(SELECT", end);
  expect(start).toBeGreaterThan(-1);
  return sqlText.slice(start, end);
}

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
    const counts = summarizeAdminCounts({
      phone_users: "17",
      sms_inbound: "42",
      message_agent_turns_denied: "6",
      voice_calls: "8",
      voice_calls_rate_limited: "3",
      voice_verifications: "14",
      voice_verifications_denied: "2",
      voice_duration_seconds: "312",
      voice_turns: "31",
      comic_requests: "12",
      comics_completed: "10",
      comics_failed: "2",
      delivered: "9",
      delivery_failed: "1",
      agent_reply_delivery_failed: "4",
      outbound_messages: "34",
      event_count: "120",
    });
    expect(counts).toMatchObject({
      phoneUsers: 17,
      smsInbound: 42,
      messageAgentTurnsDenied: 6,
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
    expect(counts).not.toHaveProperty("smsInbound7d");
    expect(counts).not.toHaveProperty("voiceCalls7d");
    expect(counts).not.toHaveProperty("messageAgentTurnsDenied7d");
    expect(counts).not.toHaveProperty("comicRequests7d");
    expect(counts).not.toHaveProperty("outboundMessages7d");
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

  it("applies half-open UTC bounds to every dashboard metric family", async () => {
    h.execute.mockResolvedValue({ rows: [] });
    const range = parseAdminDashboardRange({
      range: "custom", from: "2026-10-22", to: "2026-10-23",
    }, now);

    await getAdminDashboard(range);

    const countQuery = dialect.sqlToQuery(h.execute.mock.calls[0][0]);
    expect(countQuery.params).toContain("2026-10-22 00:00:00.000");
    expect(countQuery.params).toContain("2026-10-24 00:00:00.000");
    expect(countQuery.sql).not.toMatch(/(?:created_at|started_at|completed_at|occurred_at)::date\s*(?:>=|<)/);
    for (const [alias, table, column] of [
      ["phone_users", "channel_identities", "created_at"],
      ["sms_inbound", "twilio_inbound_messages", "created_at"],
      ["message_agent_turns_denied", "activity_events", "occurred_at"],
      ["voice_calls", "voice_calls", "started_at"],
      ["voice_calls_rate_limited", "voice_calls", "started_at"],
      ["voice_verifications", "activity_events", "occurred_at"],
      ["voice_verifications_denied", "activity_events", "occurred_at"],
      ["voice_duration_seconds", "voice_calls", "started_at"],
      ["voice_turns", "voice_calls", "started_at"],
      ["comic_requests", "generation_jobs", "created_at"],
      ["comics_completed", "generation_jobs", "completed_at"],
      ["comics_failed", "generation_jobs", "completed_at"],
      ["agent_reply_delivery_failed", "activity_events", "occurred_at"],
      ["outbound_messages", "activity_events", "occurred_at"],
      ["event_count", "activity_events", "occurred_at"],
    ] as const) {
      const subquery = countSubquery(countQuery.sql, alias);
      expect(subquery, alias).toContain(`FROM ${table}`);
      expect(subquery, alias).toMatch(new RegExp(`${column} >= \\$\\d+::timestamp`));
      expect(subquery, alias).toMatch(new RegExp(`${column} < \\$\\d+::timestamp`));
    }

    const delivered = countSubquery(countQuery.sql, "delivered");
    const deliveryFailed = countSubquery(countQuery.sql, "delivery_failed");
    for (const column of ["delivery_updated_at", "delivery_fallback_updated_at"]) {
      expect(delivered).toMatch(new RegExp(`${column} >= \\$\\d+::timestamp`));
      expect(delivered).toMatch(new RegExp(`${column} < \\$\\d+::timestamp`));
      expect(deliveryFailed).toMatch(new RegExp(`${column} >= \\$\\d+::timestamp`));
      expect(deliveryFailed).toMatch(new RegExp(`${column} < \\$\\d+::timestamp`));
    }
    expect(delivered).toMatch(/delivery_status IN \('delivered', 'read'\)\s+AND delivery_updated_at >= \$\d+::timestamp\s+AND delivery_updated_at < \$\d+::timestamp/);
    expect(delivered).toMatch(/delivery_fallback_status IN \('delivered', 'read'\)\s+AND delivery_fallback_updated_at >= \$\d+::timestamp\s+AND delivery_fallback_updated_at < \$\d+::timestamp/);
    expect(deliveryFailed).toMatch(/delivery_fallback_status IN \('failed', 'undelivered'\)\s+AND delivery_fallback_updated_at >= \$\d+::timestamp\s+AND delivery_fallback_updated_at < \$\d+::timestamp/);
  });

  it("limits the chart to the final 14 selected days and bounds recent activity", async () => {
    h.execute.mockResolvedValue({ rows: [] });
    const range = parseAdminDashboardRange({
      range: "custom", from: "2021-01-01", to: "2026-10-03",
    }, now);

    await getAdminDashboard(range);

    const trendQuery = dialect.sqlToQuery(h.execute.mock.calls[1][0]);
    const activityQuery = dialect.sqlToQuery(h.execute.mock.calls[2][0]);
    expect(trendQuery.sql).toMatch(/generate_series\(\$\d+::timestamp, \$\d+::timestamp, INTERVAL '1 day'\)/);
    expect(trendQuery.sql).toContain("TO_CHAR(days.day, 'YYYY-MM-DD') AS day");
    expect(trendQuery.params).toContain("2026-09-20 00:00:00.000");
    expect(trendQuery.params).toContain("2026-10-03 00:00:00.000");
    expect(trendQuery.params).toContain("2026-10-04 00:00:00.000");
    expect(trendQuery.params).not.toContain("2021-01-01 00:00:00.000");
    for (const column of ["created_at", "started_at", "completed_at"]) {
      expect(trendQuery.sql).toMatch(new RegExp(`${column} >= \\$\\d+::timestamp`));
      expect(trendQuery.sql).toMatch(new RegExp(`${column} < \\$\\d+::timestamp`));
    }
    expect(activityQuery.sql).toMatch(/FROM activity_events\s+WHERE occurred_at >= \$\d+::timestamp\s+AND occurred_at < \$\d+::timestamp\s+ORDER BY occurred_at DESC, id DESC\s+LIMIT 12/);
    expect(activityQuery.params).toContain("2021-01-01 00:00:00.000");
    expect(activityQuery.params).toContain("2026-10-04 00:00:00.000");
  });

  it("keeps the default dashboard totals and recent activity unbounded", async () => {
    h.execute.mockResolvedValue({ rows: [] });

    await getAdminDashboard();

    const countQuery = dialect.sqlToQuery(h.execute.mock.calls[0][0]);
    const trendQuery = dialect.sqlToQuery(h.execute.mock.calls[1][0]);
    const activityQuery = dialect.sqlToQuery(h.execute.mock.calls[2][0]);
    expect(countQuery.params).toEqual([]);
    expect(countQuery.sql).not.toContain("INTERVAL '7 days'");
    expect(countQuery.sql).not.toContain("NOW() -");
    expect(activityQuery.sql).not.toContain("WHERE occurred_at >=");
    expect(trendQuery.sql).toContain("generate_series(");
    expect(trendQuery.params).toHaveLength(8);
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

  it("counts durable messaging agent denials only inside the selected window", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [{
        message_agent_turns_denied: "6",
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const dashboard = await getAdminDashboard(parseAdminDashboardRange({ range: "7d" }, now));

    expect(dashboard.counts.messageAgentTurnsDenied).toBe(6);
    const countQuery = dialect.sqlToQuery(h.execute.mock.calls[0][0]);
    expect(countSubquery(countQuery.sql, "message_agent_turns_denied"))
      .toMatch(/kind = 'message\.agent_turn\.denied'\s+AND occurred_at >= \$\d+::timestamp\s+AND occurred_at < \$\d+::timestamp/);
    expect(countQuery.params).toContain("2026-10-17 00:00:00.000");
    expect(countQuery.params).toContain("2026-10-24 00:00:00.000");
  });

  it("separates rate-limited calls from answered calls and the call trend", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [{ voice_calls: "8", voice_calls_rate_limited: "3" }] })
      .mockResolvedValueOnce({ rows: [{ day: "2026-10-21", sms_inbound: "1", voice_calls: "2", comics_completed: "1" }] })
      .mockResolvedValueOnce({ rows: [] });

    const dashboard = await getAdminDashboard(parseAdminDashboardRange({ range: "7d" }, now));
    expect(dashboard.counts).toMatchObject({ voiceCalls: 8, voiceCallsRateLimited: 3 });
    expect(dashboard.trend).toMatchObject([{ day: "2026-10-21", voiceCalls: 2 }]);

    const answered = countSubquery(dialect.sqlToQuery(h.execute.mock.calls[0][0]).sql, "voice_calls");
    const limited = countSubquery(dialect.sqlToQuery(h.execute.mock.calls[0][0]).sql, "voice_calls_rate_limited");
    const trendSql = dialect.sqlToQuery(h.execute.mock.calls[1][0]).sql;
    expect(answered).toMatch(/status <> 'rate_limited'\s+AND started_at >= \$\d+::timestamp\s+AND started_at < \$\d+::timestamp/);
    expect(limited).toMatch(/status = 'rate_limited'\s+AND started_at >= \$\d+::timestamp\s+AND started_at < \$\d+::timestamp/);
    expect(trendSql).toMatch(/FROM voice_calls\s+WHERE started_at >= \$\d+::timestamp\s+AND started_at < \$\d+::timestamp\s+AND status <> 'rate_limited'/);
  });
});
