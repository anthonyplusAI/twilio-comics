import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { execute: h.execute } }));
vi.mock("@/lib/admin-access", () => ({
  requireAdmin: vi.fn(async () => ({ user: { id: "", role: "admin", name: "operator" } })),
}));

import AdminDashboardPage from "@/app/admin/(protected)/page";
import AdminActivityPage from "@/app/admin/(protected)/activity/page";

describe("administrator dashboard and activity visibility", () => {
  beforeEach(() => h.execute.mockReset());

  it("links a visible dashboard failure count to the filtered operations history", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [{ agent_reply_delivery_failed: "4" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const html = renderToStaticMarkup(await AdminDashboardPage({ searchParams: Promise.resolve({}) }));

    expect(html).toMatch(/Agent reply delivery issues[\s\S]*?4/);
    expect(html).toContain('href="/admin/activity?filter=failed-agent-replies"');
    expect(html).toContain('href="/admin/activity"');
  });

  it("shows selected-period metrics and an active seven-day filter without weekly subcounts", async () => {
    h.execute.mockResolvedValue({ rows: [] });

    const html = renderToStaticMarkup(await AdminDashboardPage({
      searchParams: Promise.resolve({ range: "7d" }),
    }));

    const activePreset = html.match(/<a[^>]*aria-current="page"[^>]*>/)?.[0];
    expect(activePreset).toContain('href="/admin?range=7d"');
    expect(html).toContain("New phone participants");
    expect(html).toContain("Dates in UTC");
    expect(html).not.toContain("Lifetime totals");
    expect(html).not.toContain("this week");
    expect(html).not.toContain("Message turns limited · 7 days");
    const recentPanel = html.slice(html.indexOf('id="recent-heading"'));
    expect(recentPanel).toContain("No activity in this period");
    expect(recentPanel).not.toContain("No activity recorded yet");
  });

  it("keeps a custom start and end date in the filter form", async () => {
    h.execute.mockResolvedValue({ rows: [] });

    const html = renderToStaticMarkup(await AdminDashboardPage({
      searchParams: Promise.resolve({ range: "custom", from: "2026-10-01", to: "2026-10-03" }),
    }));

    expect(html).toContain('name="range" value="custom"');
    const fromInput = html.match(/<input[^>]*name="from"[^>]*>/)?.[0];
    const toInput = html.match(/<input[^>]*name="to"[^>]*>/)?.[0];
    expect(fromInput).toContain('type="date"');
    expect(fromInput).toContain('value="2026-10-01"');
    expect(toInput).toContain('type="date"');
    expect(toInput).toContain('value="2026-10-03"');
    expect(html).toContain("Custom dates (selected)");
  });

  it("explains an invalid custom date instead of silently showing unfiltered totals", async () => {
    h.execute.mockResolvedValue({ rows: [] });

    const html = renderToStaticMarkup(await AdminDashboardPage({
      searchParams: Promise.resolve({ range: "custom", from: "2026-13-01", to: "2026-10-03" }),
    }));

    expect(html).toContain('role="alert"');
    expect(html).toContain("Showing all time");
    expect(html).not.toContain("Custom dates (selected)");
  });

  it("shows filtered agent reply failures with the Twilio receipt and participant lookup", async () => {
    h.execute.mockResolvedValueOnce({ rows: [{
      id: "11111111-1111-4111-8111-111111111111",
      occurred_at: new Date("2026-10-21T12:00:00.000Z"),
      user_id: null,
      channel: "sms",
      kind: "message.delivery",
      direction: "outbound",
      address: "+14155552671",
      call_sid: null,
      message_sid: "SMfailedreply",
      job_id: null,
      story_id: null,
      content: null,
      status: "undelivered",
      details: { purpose: "agent_reply", errorCode: "30008", inReplyTo: "SMinbound" },
    }] });

    const html = renderToStaticMarkup(await AdminActivityPage({
      searchParams: Promise.resolve({ filter: "failed-agent-replies" }),
    }));

    expect(html).toContain("Failed agent replies");
    expect(html).toContain('href="/admin/activity?filter=failed-agent-replies"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("Agent reply delivery");
    expect(html).toContain("SMfailedreply");
    expect(html).toContain("30008");
    expect(html).toContain('href="/admin/users?q=%2B14155552671"');
  });

  it("explains when the failed-replies filter has no matching events", async () => {
    h.execute.mockResolvedValueOnce({ rows: [] });

    const html = renderToStaticMarkup(await AdminActivityPage({
      searchParams: Promise.resolve({ filter: "failed-agent-replies" }),
    }));

    expect(html).toContain("No failed agent replies recorded");
    expect(html).not.toContain("No activity recorded yet");
  });
});
