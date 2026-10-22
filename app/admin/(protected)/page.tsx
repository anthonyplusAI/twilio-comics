import Link from "next/link";
import { ArrowUpRight, MessageCircle, PhoneCall, UsersRound, WandSparkles } from "lucide-react";
import { ActivityList } from "@/components/admin/activity-list";
import { TrendChart } from "@/components/admin/trend-chart";
import { formatAdminDuration } from "@/components/admin/format";
import { requireAdmin } from "@/lib/admin-access";
import { getAdminDashboard } from "@/lib/admin-analytics";
import styles from "../admin.module.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminDashboardPage() {
  await requireAdmin();
  const { counts, trend, recentActivity } = await getAdminDashboard();

  return (
    <div className={styles.dashboardPage}>
      <div className={styles.pageHeading}>
        <div>
          <p className={styles.sectionKicker}>Operations overview</p>
          <h1>Every story has a trail.</h1>
          <p>Live totals from saved messages, calls, comic jobs, and delivery receipts.</p>
        </div>
        <Link className={styles.headingAction} href="/admin/users">
          Explore people <ArrowUpRight size={18} aria-hidden="true" />
        </Link>
      </div>

      <section className={styles.heroMetrics} aria-label="Lifetime overview">
        <div className={styles.heroMetricPrimary}>
          <WandSparkles size={29} aria-hidden="true" />
          <span>Comics completed</span>
          <strong>{counts.comicsCompleted.toLocaleString()}</strong>
          <p>{counts.comicRequests.toLocaleString()} total requests · {counts.comicRequests7d.toLocaleString()} in the last 7 days</p>
        </div>
        <div className={styles.heroMetricGrid}>
          <div><UsersRound size={22} aria-hidden="true" /><span>Phone participants</span><strong>{counts.phoneUsers.toLocaleString()}</strong></div>
          <div><MessageCircle size={22} aria-hidden="true" /><span>Texts received</span><strong>{counts.smsInbound.toLocaleString()}</strong><small>{counts.smsInbound7d.toLocaleString()} this week</small></div>
          <div><PhoneCall size={22} aria-hidden="true" /><span>Calls answered</span><strong>{counts.voiceCalls.toLocaleString()}</strong><small>{counts.voiceCalls7d.toLocaleString()} this week</small></div>
        </div>
      </section>

      <div className={styles.analyticsGrid}>
        <section className={styles.trendPanel} aria-labelledby="trend-heading">
          <div className={styles.panelHeading}>
            <div>
              <h2 id="trend-heading">The last 14 days</h2>
              <p>Daily channel activity and completed comics.</p>
            </div>
            <div className={styles.chartLegend} aria-label="Chart legend">
              <span><i className={styles.legendSms} /> SMS</span>
              <span><i className={styles.legendVoice} /> Calls</span>
              <span><i className={styles.legendComic} /> Comics</span>
            </div>
          </div>
          <TrendChart days={trend} />
        </section>
        <section className={styles.healthPanel} aria-labelledby="health-heading">
          <div className={styles.panelHeading}>
            <div>
              <h2 id="health-heading">Delivery &amp; flow</h2>
              <p>Lifetime totals.</p>
            </div>
          </div>
          <dl className={styles.healthList}>
            <div><dt>Comic links delivered</dt><dd>{counts.delivered.toLocaleString()}</dd></div>
            <div><dt>Delivery issues</dt><dd data-alert={counts.deliveryFailed > 0}>{counts.deliveryFailed.toLocaleString()}</dd></div>
            <div><dt>Generation failures</dt><dd data-alert={counts.comicsFailed > 0}>{counts.comicsFailed.toLocaleString()}</dd></div>
            <div><dt>Outbound texts recorded</dt><dd>{counts.outboundMessages.toLocaleString()}</dd></div>
            <div><dt>Message turns limited</dt><dd data-alert={counts.messageAgentTurnsDenied > 0}>{counts.messageAgentTurnsDenied.toLocaleString()}</dd></div>
            <div><dt>Message turns limited · 7 days</dt><dd data-alert={counts.messageAgentTurnsDenied7d > 0}>{counts.messageAgentTurnsDenied7d.toLocaleString()}</dd></div>
            <div><dt>Calls rate limited</dt><dd data-alert={counts.voiceCallsRateLimited > 0}>{counts.voiceCallsRateLimited.toLocaleString()}</dd></div>
            <div><dt>Voice code requests</dt><dd>{counts.voiceVerifications.toLocaleString()}</dd></div>
            <div><dt>Voice code requests limited</dt><dd data-alert={counts.voiceVerificationsDenied > 0}>{counts.voiceVerificationsDenied.toLocaleString()}</dd></div>
            <div><dt>Call time</dt><dd>{formatAdminDuration(counts.voiceDurationSeconds)}</dd></div>
            <div><dt>Voice turns</dt><dd>{counts.voiceTurns.toLocaleString()}</dd></div>
          </dl>
          <p className={styles.healthFootnote}>{counts.eventCount.toLocaleString()} detailed activity events retained.</p>
        </section>
      </div>

      <section className={styles.activityPanel} aria-labelledby="recent-heading">
        <div className={styles.panelHeading}>
          <div>
            <h2 id="recent-heading">Recent activity</h2>
            <p>Message, voice, generation, and delivery events.</p>
          </div>
          <Link className={styles.inlineLink} href="/admin/users">Find a participant</Link>
        </div>
        <ActivityList events={recentActivity} compact />
      </section>
    </div>
  );
}
