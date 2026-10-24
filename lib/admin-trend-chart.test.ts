import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TrendChart } from "@/components/admin/trend-chart";

describe("admin trend chart", () => {
  it("describes the selected date range when that range has no activity", () => {
    const html = renderToStaticMarkup(createElement(TrendChart, {
      days: [{ day: "2026-10-01", smsInbound: 0, voiceCalls: 0, comicsCompleted: 0 }],
      periodLabel: "October 1, 2026",
    }));

    expect(html).toContain("October 1, 2026");
    expect(html).not.toContain("last 14 days");
  });
});
