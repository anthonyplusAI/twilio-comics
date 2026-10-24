import { describe, expect, it } from "vitest";
import { parseAdminDashboardRange } from "@/lib/admin-dashboard-range";

const now = new Date("2026-10-23T17:42:00.000Z");

describe("admin dashboard date range", () => {
  it("defaults to lifetime totals with a chart for the latest 14 UTC days", () => {
    const range = parseAdminDashboardRange({}, now);

    expect(range).toMatchObject({ mode: "all", from: null, to: null, start: null, endExclusive: null });
    expect(range.chartStart.toISOString()).toBe("2026-10-10T00:00:00.000Z");
    expect(range.chartEndExclusive.toISOString()).toBe("2026-10-24T00:00:00.000Z");
    expect(range.label).toMatch(/all time/i);
    expect(range.chartLabel).toMatch(/UTC/);
    expect(range.error).toBeUndefined();
  });

  it.each([
    ["today", "2026-10-23", "2026-10-24", "2026-10-23"],
    ["7d", "2026-10-17", "2026-10-24", "2026-10-17"],
    ["30d", "2026-09-24", "2026-10-24", "2026-10-10"],
  ] as const)("uses inclusive UTC calendar days for %s", (mode, from, end, chartFrom) => {
    const range = parseAdminDashboardRange({ range: mode }, now);

    expect(range.mode).toBe(mode);
    expect(range.from).toBe(from);
    expect(range.to).toBe("2026-10-23");
    expect(range.start?.toISOString()).toBe(`${from}T00:00:00.000Z`);
    expect(range.endExclusive?.toISOString()).toBe(`${end}T00:00:00.000Z`);
    expect(range.chartStart.toISOString()).toBe(`${chartFrom}T00:00:00.000Z`);
    expect(range.chartEndExclusive.toISOString()).toBe(`${end}T00:00:00.000Z`);
    expect(range.label).toMatch(/UTC/);
  });

  it("uses the UTC date immediately after midnight even when the server is in another time zone", () => {
    const range = parseAdminDashboardRange(
      { range: "today" },
      new Date("2026-10-24T00:10:00.000Z"),
    );

    expect(range.from).toBe("2026-10-24");
    expect(range.start?.toISOString()).toBe("2026-10-24T00:00:00.000Z");
    expect(range.endExclusive?.toISOString()).toBe("2026-10-25T00:00:00.000Z");
  });

  it("treats a custom date without an end date as one full day", () => {
    const range = parseAdminDashboardRange({ range: "custom", from: "2026-10-04" }, now);

    expect(range.mode).toBe("custom");
    expect(range.from).toBe("2026-10-04");
    expect(range.to).toBeNull();
    expect(range.start?.toISOString()).toBe("2026-10-04T00:00:00.000Z");
    expect(range.endExclusive?.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(range.chartStart.toISOString()).toBe("2026-10-04T00:00:00.000Z");
    expect(range.chartLabel).toContain("2026-10-04");
  });

  it("includes both endpoints of a valid custom range and charts its latest 14 days", () => {
    const range = parseAdminDashboardRange({
      range: "custom", from: "2026-09-20", to: "2026-10-03",
    }, now);

    expect(range.start?.toISOString()).toBe("2026-09-20T00:00:00.000Z");
    expect(range.endExclusive?.toISOString()).toBe("2026-10-04T00:00:00.000Z");
    expect(range.chartStart.toISOString()).toBe("2026-09-20T00:00:00.000Z");
    expect(range.chartEndExclusive.toISOString()).toBe("2026-10-04T00:00:00.000Z");
    expect(range.label).toContain("2026-09-20");
    expect(range.label).toContain("2026-10-03");
  });

  it("counts a multi-year custom range while charting only its latest 14 days", () => {
    const range = parseAdminDashboardRange({
      range: "custom", from: "2021-01-01", to: "2026-10-23",
    }, now);

    expect(range.mode).toBe("custom");
    expect(range.error).toBeUndefined();
    expect(range.start?.toISOString()).toBe("2021-01-01T00:00:00.000Z");
    expect(range.chartStart.toISOString()).toBe("2026-10-10T00:00:00.000Z");
  });

  it.each([
    { range: "unknown" },
    { range: "custom" },
    { range: "custom", from: "2026-02-30" },
    { range: "custom", from: "2026-10-03", to: "2026-09-30" },
    { range: "custom", from: "2026-10-24" },
    { range: "custom", from: "0000-01-01" },
    { range: "custom", from: "2026-10-01'; DROP TABLE users; --" },
  ])("falls back to visible all-time results for invalid filter %j", (input) => {
    const range = parseAdminDashboardRange(input, now);

    expect(range.mode).toBe("all");
    expect(range.start).toBeNull();
    expect(range.endExclusive).toBeNull();
    expect(range.error).toEqual(expect.any(String));
    expect(range.error).not.toBe("");
  });
});
