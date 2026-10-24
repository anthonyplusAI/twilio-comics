import Link from "next/link";
import { ArrowUpRight, MessageCircle, PhoneCall, UsersRound, WandSparkles } from "lucide-react";
import { ActivityList } from "@/components/admin/activity-list";
import { TrendChart } from "@/components/admin/trend-chart";
import { formatAdminDuration } from "@/components/admin/format";
import { requireAdmin } from "@/lib/admin-access";
import { getAdminDashboard } from "@/lib/admin-analytics";
import { parseAdminDashboardRange, type AdminDashboardRange } from "@/lib/admin-dashboard-range";
import styles from "../admin.module.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface DashboardSearchParams {
  range?: string | string[];
  from?: string | string[];
  to?: string | string[];
}

function singleValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function activityHref(range: AdminDashboardRange, failedReplies = false): string {
  const params = new URLSearchParams();
  if (failedReplies) params.set("filter", "failed-agent-replies");
  if (range.mode !== "all") params.set("range", range.mode);
  if (range.mode === "custom" && range.from) {
    params.set("from", range.from);
    if (range.to) params.set("to", range.to);
  }
  const query = params.toString();
  return `/admin/activity${query ? `?${query}` : ""}`;
}

export default async function AdminDashboardPage({
  searchParams,
}: {
  searchParams: Promise<DashboardSearchParams>;
}) {
  await requireAdmin();
  const search = await searchParams;
  const rawMode = singleValue(search.range);
  const rawFrom = singleValue(search.from);
  const rawTo = singleValue(search.to);
  const range = parseAdminDashboardRange({ range: rawMode, from: rawFrom, to: rawTo });
  const { counts, trend, recentActivity } = await getAdminDashboard(range);
  const isCustomRequest = rawMode === "custom";
  const customSelected = range.mode === "custom";

  return (
    <div className={styles.dashboardPage}>
      <div className={styles.pageHeading}>
        <div>
          <p className={styles.sectionKicker}>Operations overview</p>
          <h1>Every story has a trail.</h1>
          <p>Messages, calls, comic jobs, and deliveries across the dates you choose.</p>
        </div>
        <Link className={styles.headingAction} href="/admin/users">
          Explore people <ArrowUpRight size={18} aria-hidden="true" />
        </Link>
      </div>

      <section className={styles.dateRangePanel} aria-labelledby="date-range-heading">
        <div className={styles.dateRangeSummary}>
          <h2 id="date-range-heading">Date range</h2>
          <p>Showing {range.mode === "all" ? "all time" : range.label}</p>
          <small>Dates in UTC</small>
        </div>
        <div className={styles.dateRangeControls}>
          <nav className={styles.datePresets} aria-label="Metric date presets">
            <Link href="/admin" aria-current={range.mode === "all" ? "page" : undefined}>All time</Link>
            <Link href="/admin?range=today" aria-current={range.mode === "today" ? "page" : undefined}>Today</Link>
            <Link href="/admin?range=7d" aria-current={range.mode === "7d" ? "page" : undefined}>Last 7 days</Link>
            <Link href="/admin?range=30d" aria-current={range.mode === "30d" ? "page" : undefined}>Last 30 days</Link>
          </nav>
          <form className={styles.customDateForm} method="get" action="/admin" aria-label="Custom metric date range">
            <input type="hidden" name="range" value="custom" />
            <div className={styles.customDateHeading}>Custom dates{customSelected ? " (selected)" : ""}</div>
            <label className={styles.customDateField} htmlFor="metrics-from">
              From
              <input id="metrics-from" name="from" type="date" defaultValue={isCustomRequest ? rawFrom ?? "" : ""} required />
            </label>
            <label className={styles.customDateField} htmlFor="metrics-to">
              To <span>(optional)</span>
              <input id="metrics-to" name="to" type="date" defaultValue={isCustomRequest ? rawTo ?? "" : ""} />
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

      <section className={styles.heroMetrics} aria-label={`${range.label} overview`}>
        <div className={styles.heroMetricPrimary}>
          <WandSparkles size={29} aria-hidden="true" />
          <span>Comics completed</span>
          <strong>{counts.comicsCompleted.toLocaleString()}</strong>
          <p>{counts.comicRequests.toLocaleString()} comic requests</p>
        </div>
        <div className={styles.heroMetricGrid}>
          <div><UsersRound size={22} aria-hidden="true" /><span>{range.mode === "all" ? "Phone participants" : "New phone participants"}</span><strong>{counts.phoneUsers.toLocaleString()}</strong></div>
          <div><MessageCircle size={22} aria-hidden="true" /><span>Texts received</span><strong>{counts.smsInbound.toLocaleString()}</strong></div>
          <div><PhoneCall size={22} aria-hidden="true" /><span>Calls answered</span><strong>{counts.voiceCalls.toLocaleString()}</strong></div>
        </div>
      </section>

      <div className={styles.analyticsGrid}>
        <section className={styles.trendPanel} aria-labelledby="trend-heading">
          <div className={styles.panelHeading}>
            <div>
              <h2 id="trend-heading">{range.chartLabel}</h2>
              <p>Daily channel activity and completed comics.</p>
            </div>
            <div className={styles.chartLegend} aria-label="Chart legend">
              <span><i className={styles.legendSms} /> SMS</span>
              <span><i className={styles.legendVoice} /> Calls</span>
              <span><i className={styles.legendComic} /> Comics</span>
            </div>
          </div>
          <TrendChart days={trend} periodLabel={range.chartLabel} />
        </section>
        <section className={styles.healthPanel} aria-labelledby="health-heading">
          <div className={styles.panelHeading}>
            <div>
              <h2 id="health-heading">Delivery &amp; flow</h2>
              <p>Results for the selected period.</p>
            </div>
          </div>
          <dl className={styles.healthList}>
            <div><dt>Comic links delivered</dt><dd>{counts.delivered.toLocaleString()}</dd></div>
            <div><dt>Unresolved delivery issues</dt><dd data-alert={counts.deliveryFailed > 0}>{counts.deliveryFailed.toLocaleString()}</dd></div>
            <div>
              <dt>Agent reply delivery issues <Link className={styles.inlineLink} href={activityHref(range, true)}>{range.mode === "all" ? "View all dates" : "View selected dates"}</Link></dt>
              <dd data-alert={counts.agentReplyDeliveryFailed > 0}>{counts.agentReplyDeliveryFailed.toLocaleString()}</dd>
            </div>
            <div><dt>Generation failures</dt><dd data-alert={counts.comicsFailed > 0}>{counts.comicsFailed.toLocaleString()}</dd></div>
            <div><dt>Outbound texts recorded</dt><dd>{counts.outboundMessages.toLocaleString()}</dd></div>
            <div><dt>Message turns limited</dt><dd data-alert={counts.messageAgentTurnsDenied > 0}>{counts.messageAgentTurnsDenied.toLocaleString()}</dd></div>
            <div><dt>Calls rate limited</dt><dd data-alert={counts.voiceCallsRateLimited > 0}>{counts.voiceCallsRateLimited.toLocaleString()}</dd></div>
            <div><dt>Voice code requests</dt><dd>{counts.voiceVerifications.toLocaleString()}</dd></div>
            <div><dt>Voice code requests limited</dt><dd data-alert={counts.voiceVerificationsDenied > 0}>{counts.voiceVerificationsDenied.toLocaleString()}</dd></div>
            <div><dt>Call time</dt><dd>{formatAdminDuration(counts.voiceDurationSeconds)}</dd></div>
            <div><dt>Voice turns</dt><dd>{counts.voiceTurns.toLocaleString()}</dd></div>
          </dl>
          <p className={styles.healthFootnote}>{counts.eventCount.toLocaleString()} detailed activity events in this period.</p>
        </section>
      </div>

      <section className={styles.activityPanel} aria-labelledby="recent-heading">
        <div className={styles.panelHeading}>
          <div>
            <h2 id="recent-heading">Recent activity</h2>
            <p>Latest message, voice, generation, and delivery events in this period.</p>
          </div>
          <Link className={styles.inlineLink} href={activityHref(range)}>{range.mode === "all" ? "View all dates" : "View selected dates"}</Link>
        </div>
        {range.mode !== "all" && recentActivity.length === 0 ? (
          <div className={styles.emptyState}>
            <strong>No activity in this period.</strong>
            <p>Try a wider date range to see more events.</p>
          </div>
        ) : (
          <ActivityList events={recentActivity} compact />
        )}
      </section>
    </div>
  );
}
