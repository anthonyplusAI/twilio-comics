import { renderToStaticMarkup } from "react-dom/server";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { execute: h.execute } }));
vi.mock("@/lib/admin-access", () => ({
  requireAdmin: vi.fn(async () => ({ user: { id: "admin", role: "admin", name: "operator" } })),
}));

import AdminDashboardPage from "@/app/admin/(protected)/page";
import AdminActivityPage from "@/app/admin/(protected)/activity/page";
import {
  buildAdminActivityHistoryQuery,
  decodeActivityCursor,
  getAdminActivityHistory,
} from "@/lib/admin-analytics";
import { parseAdminDashboardRange } from "@/lib/admin-dashboard-range";

const dialect = new PgDialect();
const now = new Date("2026-10-23T23:42:00.000Z");
const from = "2026-10-01";
const to = "2026-10-03";
const customRange = () => parseAdminDashboardRange({ range: "custom", from, to }, now);

function readableLinks(html: string): string {
  return html.replaceAll("&amp;", "&");
}

function event(index: number) {
  return {
    id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
    occurred_at: new Date(Date.UTC(2026, 9, 3, 12, 0, 0) - index * 1000),
    user_id: null,
    channel: "sms",
    kind: "message.delivery",
    direction: "outbound",
    address: "+14155552671",
    call_sid: null,
    message_sid: `SM${index}`,
    job_id: null,
    story_id: null,
    content: null,
    status: "failed",
    details: { purpose: "agent_reply" },
  };
}

describe("admin activity date filtering", () => {
  beforeEach(() => h.execute.mockReset());

  it("bounds failed reply history by an inclusive UTC date range before keyset pagination", () => {
    const cursor = {
      occurredAt: new Date("2026-10-03T12:00:00.000Z"),
      id: "11111111-1111-4111-8111-111111111111",
    };
    const query = dialect.sqlToQuery(buildAdminActivityHistoryQuery({
      filter: "failed-agent-replies",
      cursor,
      limit: 41,
      range: customRange(),
    }));

    expect(query.sql).toMatch(/WHERE TRUE[\s\S]*kind = 'message\.delivery'[\s\S]*AND occurred_at >= \$\d+::timestamp\s+AND occurred_at < \$\d+::timestamp[\s\S]*AND \(occurred_at, id\) <[\s\S]*ORDER BY occurred_at DESC, id DESC/);
    expect(query.sql).not.toMatch(/occurred_at::date\s*(?:>=|<)/);
    expect(query.params).toContain("2026-10-01 00:00:00.000");
    expect(query.params).toContain("2026-10-04 00:00:00.000");
    expect(query.params).toContain(cursor.id);
  });

  it("keeps all-time history unbounded and passes a selected range through the history loader", async () => {
    const all = dialect.sqlToQuery(buildAdminActivityHistoryQuery({
      filter: "all", cursor: null, limit: 41,
      range: parseAdminDashboardRange({}, now),
    }));
    expect(all.sql).not.toContain("occurred_at >=");
    expect(all.sql).not.toContain("occurred_at <");

    h.execute.mockResolvedValueOnce({ rows: [] });
    await getAdminActivityHistory("all", null, customRange());
    const selected = dialect.sqlToQuery(h.execute.mock.calls[0][0]);
    expect(selected.params).toContain("2026-10-01 00:00:00.000");
    expect(selected.params).toContain("2026-10-04 00:00:00.000");
  });

  it("keeps dates and failure filter in activity tabs, the custom form, and Older events", async () => {
    h.execute.mockResolvedValueOnce({ rows: Array.from({ length: 41 }, (_, index) => event(index)) });

    const html = readableLinks(renderToStaticMarkup(await AdminActivityPage({
      searchParams: Promise.resolve({ filter: "failed-agent-replies", range: "custom", from, to }),
    })));

    expect(html).toContain('href="/admin/activity?range=custom&from=2026-10-01&to=2026-10-03"');
    expect(html).toContain('href="/admin/activity?filter=failed-agent-replies&range=custom&from=2026-10-01&to=2026-10-03"');
    expect(html).toMatch(/href="\/admin\/activity\?filter=failed-agent-replies&range=custom&from=2026-10-01&to=2026-10-03&cursor=[^"]+"/);
    expect(html).toContain('href="/admin?range=custom&from=2026-10-01&to=2026-10-03"');
    expect(html).toContain('name="filter" value="failed-agent-replies"');
    expect(html.match(/<input[^>]*name="from"[^>]*>/)?.[0]).toContain('value="2026-10-01"');
    expect(html.match(/<input[^>]*name="to"[^>]*>/)?.[0]).toContain('value="2026-10-03"');
    expect(html).toContain("Dates in UTC");
    expect(html).toContain("Custom dates (selected)");

    const last = event(39);
    expect(decodeActivityCursor(html.match(/&cursor=([^"]+)"/)?.[1])).toEqual({
      occurredAt: last.occurred_at,
      id: last.id,
    });
  });

  it("keeps the date preset while paging back to newest", async () => {
    h.execute.mockResolvedValueOnce({ rows: [] });
    const html = readableLinks(renderToStaticMarkup(await AdminActivityPage({
      searchParams: Promise.resolve({ range: "7d", cursor: "invalid" }),
    })));

    expect(html).toContain('href="/admin/activity?range=7d"');
    expect(html).toContain("Back to newest");
    expect(html).toContain('href="/admin?range=7d"');
  });

  it("explains malformed dates and does not imply activity was filtered", async () => {
    h.execute.mockResolvedValueOnce({ rows: [] });
    const html = readableLinks(renderToStaticMarkup(await AdminActivityPage({
      searchParams: Promise.resolve({ range: "custom", from: "2026-13-01", to: "2026-10-03" }),
    })));

    expect(html).toContain('role="alert"');
    expect(html).toContain("Showing all time");
    expect(html.match(/<input[^>]*name="from"[^>]*>/)?.[0]).toContain('value="2026-13-01"');
    expect(html).toContain('href="/admin/activity"');
    expect(html).not.toContain("Custom dates (selected)");
    const query = dialect.sqlToQuery(h.execute.mock.calls[0][0]);
    expect(query.sql).not.toContain("occurred_at >=");
  });

  it("carries selected dashboard dates into its activity drilldown links", async () => {
    h.execute.mockResolvedValue({ rows: [] });
    const html = readableLinks(renderToStaticMarkup(await AdminDashboardPage({
      searchParams: Promise.resolve({ range: "custom", from, to }),
    })));

    expect(html).toContain('href="/admin/activity?filter=failed-agent-replies&range=custom&from=2026-10-01&to=2026-10-03"');
    expect(html).toContain('href="/admin/activity?range=custom&from=2026-10-01&to=2026-10-03"');
    expect(html).toContain("View selected dates");
  });
});
