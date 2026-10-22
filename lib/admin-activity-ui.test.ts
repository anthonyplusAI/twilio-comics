import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { execute: h.execute } }));
vi.mock("@/lib/admin-access", () => ({
  requireAdmin: vi.fn(async () => ({ user: { id: "", role: "admin", name: "operator" } })),
}));

import AdminDashboardPage from "@/app/admin/(protected)/page";
import AdminActivityPage from "@/app/admin/(protected)/activity/page";

describe("administrator reply delivery visibility", () => {
  beforeEach(() => h.execute.mockReset());

  it("links a visible dashboard failure count to the filtered operations history", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [{ agent_reply_delivery_failed: "4" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const html = renderToStaticMarkup(await AdminDashboardPage());

    expect(html).toMatch(/Agent reply delivery issues[\s\S]*?4/);
    expect(html).toContain('href="/admin/activity?filter=failed-agent-replies"');
    expect(html).toContain('href="/admin/activity"');
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
