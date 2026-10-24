export type AdminDashboardRangeMode = "all" | "today" | "7d" | "30d" | "custom";

export interface AdminDashboardRange {
  mode: AdminDashboardRangeMode;
  from: string | null;
  to: string | null;
  start: Date | null;
  endExclusive: Date | null;
  chartStart: Date;
  chartEndExclusive: Date;
  label: string;
  chartLabel: string;
  error?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function dayText(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function parseIsoDay(value: string | undefined): Date | null {
  if (!value || !ISO_DAY.test(value) || value.startsWith("0000-")) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && dayText(parsed) === value ? parsed : null;
}

function chartLabel(start: Date, endExclusive: Date): string {
  const first = dayText(start);
  const last = dayText(new Date(endExclusive.getTime() - DAY_MS));
  return `Daily activity · ${first}${first === last ? "" : ` to ${last}`} (UTC)`;
}

function allTimeRange(today: Date, error?: string): AdminDashboardRange {
  const chartStart = new Date(today.getTime() - 13 * DAY_MS);
  const chartEndExclusive = new Date(today.getTime() + DAY_MS);
  return {
    mode: "all",
    from: null,
    to: null,
    start: null,
    endExclusive: null,
    chartStart,
    chartEndExclusive,
    label: "All time",
    chartLabel: chartLabel(chartStart, chartEndExclusive),
    ...(error ? { error } : {}),
  };
}

function datedRange(
  mode: Exclude<AdminDashboardRangeMode, "all">,
  start: Date,
  lastDay: Date,
  to: string | null,
  label: string,
): AdminDashboardRange {
  const endExclusive = new Date(lastDay.getTime() + DAY_MS);
  const chartStart = new Date(Math.max(start.getTime(), endExclusive.getTime() - 14 * DAY_MS));
  return {
    mode,
    from: dayText(start),
    to,
    start,
    endExclusive,
    chartStart,
    chartEndExclusive: endExclusive,
    label,
    chartLabel: chartLabel(chartStart, endExclusive),
  };
}

export function parseAdminDashboardRange(
  input: { range?: string; from?: string; to?: string },
  now: Date = new Date(),
): AdminDashboardRange {
  const today = utcMidnight(now);
  const mode = input.range ?? "all";
  if (mode === "all") return allTimeRange(today);

  if (mode === "today" || mode === "7d" || mode === "30d") {
    const numberOfDays = mode === "today" ? 1 : mode === "7d" ? 7 : 30;
    const start = new Date(today.getTime() - (numberOfDays - 1) * DAY_MS);
    const label = mode === "today" ? `Today · ${dayText(today)} (UTC)`
      : `Last ${numberOfDays} days · ${dayText(start)} to ${dayText(today)} (UTC)`;
    return datedRange(mode, start, today, dayText(today), label);
  }

  if (mode !== "custom") return allTimeRange(today, "Choose a valid date filter.");

  const start = parseIsoDay(input.from);
  const hasEnd = Boolean(input.to);
  const lastDay = hasEnd ? parseIsoDay(input.to) : start;
  if (!start || !lastDay) {
    return allTimeRange(today, "Enter a valid start and end date in YYYY-MM-DD format.");
  }
  if (lastDay.getTime() < start.getTime()) {
    return allTimeRange(today, "End date must be on or after start date.");
  }
  if (lastDay.getTime() > today.getTime()) {
    return allTimeRange(today, "Choose dates up to today in UTC.");
  }

  const from = dayText(start);
  const to = hasEnd ? dayText(lastDay) : null;
  const label = to && to !== from
    ? `${from} to ${to} (UTC)`
    : `${from} (UTC)`;
  return datedRange("custom", start, lastDay, to, label);
}
