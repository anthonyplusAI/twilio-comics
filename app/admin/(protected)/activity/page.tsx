import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { ActivityList } from "@/components/admin/activity-list";
import { requireAdmin } from "@/lib/admin-access";
import { getAdminActivityHistory, type AdminActivityFilter } from "@/lib/admin-analytics";
import { parseAdminDashboardRange, type AdminDashboardRangeMode } from "@/lib/admin-dashboard-range";
import styles from "../../admin.module.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface ActivitySearchParams {
  filter?: string | string[];
  cursor?: string | string[];
  range?: string | string[];
  from?: string | string[];
  to?: string | string[];
}

type DateSelection = {
  mode: AdminDashboardRangeMode;
  from?: string | null;
  to?: string | null;
};

function singleValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function dateParams(range: DateSelection): URLSearchParams {
  const params = new URLSearchParams();
  if (range.mode !== "all") params.set("range", range.mode);
  if (range.mode === "custom" && range.from) {
    params.set("from", range.from);
    if (range.to) params.set("to", range.to);
  }
  return params;
}

function activityHref(filter: AdminActivityFilter, range: DateSelection, cursor?: string): string {
  const params = new URLSearchParams();
  if (filter === "failed-agent-replies") params.set("filter", filter);
  for (const [key, value] of dateParams(range)) params.set(key, value);
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  return `/admin/activity${query ? `?${query}` : ""}`;
}

function overviewHref(range: DateSelection): string {
  const query = dateParams(range).toString();
  return `/admin${query ? `?${query}` : ""}`;
}

export default async function AdminActivityPage({
  searchParams,
}: {
  searchParams: Promise<ActivitySearchParams>;
}) {
  await requireAdmin();
  const search = await searchParams;
  const requestedFilter = singleValue(search.filter);
  const cursor = singleValue(search.cursor);
  const rawMode = singleValue(search.range);
  const rawFrom = singleValue(search.from);
  const rawTo = singleValue(search.to);
  const range = parseAdminDashboardRange({ range: rawMode, from: rawFrom, to: rawTo });
  const filter: AdminActivityFilter = requestedFilter === "failed-agent-replies"
    ? "failed-agent-replies"
    : "all";
  const failuresOnly = filter === "failed-agent-replies";
  const history = await getAdminActivityHistory(filter, cursor, range);
  const isCustomRequest = rawMode === "custom";
  const customSelected = range.mode === "custom";

  return (
    <div className={styles.directoryPage}>
      <div className={styles.pageHeading}>
        <div>
          <p className={styles.sectionKicker}>Operations history</p>
          <h1>Follow the activity.</h1>
          <p>Browse retained channel, comic, and delivery events in time order.</p>
        </div>
        <Link className={styles.backAction} href={overviewHref(range)}><ArrowLeft size={17} aria-hidden="true" /> Overview</Link>
      </div>

      <section className={styles.dateRangePanel} aria-labelledby="activity-date-range-heading">
        <div className={styles.dateRangeSummary}>
          <h2 id="activity-date-range-heading">Date range</h2>
          <p>Showing {range.mode === "all" ? "all time" : range.label}</p>
          <small>Dates in UTC</small>
        </div>
        <div className={styles.dateRangeControls}>
          <nav className={styles.datePresets} aria-label="Activity date presets">
            <Link href={activityHref(filter, { mode: "all" })} aria-current={range.mode === "all" ? "page" : undefined}>All time</Link>
            <Link href={activityHref(filter, { mode: "today" })} aria-current={range.mode === "today" ? "page" : undefined}>Today</Link>
            <Link href={activityHref(filter, { mode: "7d" })} aria-current={range.mode === "7d" ? "page" : undefined}>Last 7 days</Link>
            <Link href={activityHref(filter, { mode: "30d" })} aria-current={range.mode === "30d" ? "page" : undefined}>Last 30 days</Link>
          </nav>
          <form className={styles.customDateForm} method="get" action="/admin/activity" aria-label="Custom activity date range">
            {failuresOnly && <input type="hidden" name="filter" value="failed-agent-replies" />}
            <input type="hidden" name="range" value="custom" />
            <div className={styles.customDateHeading}>Custom dates{customSelected ? " (selected)" : ""}</div>
            <label className={styles.customDateField} htmlFor="activity-from">
              From
              <input id="activity-from" name="from" type="date" defaultValue={isCustomRequest ? rawFrom ?? "" : ""} required />
            </label>
            <label className={styles.customDateField} htmlFor="activity-to">
              To <span>(optional)</span>
              <input id="activity-to" name="to" type="date" defaultValue={isCustomRequest ? rawTo ?? "" : ""} />
            </label>
            <button type="submit">Apply dates</button>
            <p>Leave To empty for one day.</p>
          </form>
        </div>
      </section>
      {range.error && (
        <p className={styles.dateRangeError} role="alert">
          {range.error} Showing all time. Check the dates and try again.
        </p>
      )}

      <section className={styles.activityPanel} aria-labelledby="activity-heading">
        <div className={styles.panelHeading}>
          <div>
            <h2 id="activity-heading">{failuresOnly ? "Failed agent replies" : "All activity"}</h2>
            <p>{failuresOnly
              ? "Twilio marked these agent text replies failed or undelivered. Open a record for its outbound Message SID and error code."
              : "Texts, calls, comic jobs, and delivery updates from all participants."}</p>
          </div>
        </div>
        <nav className={styles.activityFilters} aria-label="Activity filters">
          <Link href={activityHref("all", range)} aria-current={!failuresOnly ? "page" : undefined}>All activity</Link>
          <Link href={activityHref("failed-agent-replies", range)} aria-current={failuresOnly ? "page" : undefined}>Failed agent replies</Link>
        </nav>
        {history.items.length ? (
          <ActivityList events={history.items} showUserLink />
        ) : failuresOnly ? (
          <div className={styles.emptyState}>
            <strong>{range.mode === "all" ? "No failed agent replies recorded." : "No failed agent replies in this period."}</strong>
            <p>{range.mode === "all"
              ? "Twilio failures and undelivered callbacks for agent text replies will appear here."
              : "Try a wider date range to see more events."}</p>
          </div>
        ) : range.mode !== "all" ? (
          <div className={styles.emptyState}>
            <strong>No activity in this period.</strong>
            <p>Try a wider date range to see more events.</p>
          </div>
        ) : (
          <ActivityList events={history.items} />
        )}
        <nav className={styles.historyPagination} aria-label="Operations activity pages">
          {cursor ? <Link href={activityHref(filter, range)}>Back to newest</Link> : <span />}
          {history.nextCursor ? (
            <Link href={activityHref(filter, range, history.nextCursor)}>
              Older events <ArrowRight size={17} aria-hidden="true" />
            </Link>
          ) : <span />}
        </nav>
      </section>
    </div>
  );
}
