import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { ActivityList } from "@/components/admin/activity-list";
import { requireAdmin } from "@/lib/admin-access";
import { getAdminActivityHistory, type AdminActivityFilter } from "@/lib/admin-analytics";
import styles from "../../admin.module.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function activityHref(filter: AdminActivityFilter, cursor?: string): string {
  const params = new URLSearchParams();
  if (filter === "failed-agent-replies") params.set("filter", filter);
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  return `/admin/activity${query ? `?${query}` : ""}`;
}

export default async function AdminActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; cursor?: string }>;
}) {
  await requireAdmin();
  const { filter: requestedFilter, cursor } = await searchParams;
  const filter: AdminActivityFilter = requestedFilter === "failed-agent-replies"
    ? "failed-agent-replies"
    : "all";
  const failuresOnly = filter === "failed-agent-replies";
  const history = await getAdminActivityHistory(filter, cursor);

  return (
    <div className={styles.directoryPage}>
      <div className={styles.pageHeading}>
        <div>
          <p className={styles.sectionKicker}>Operations history</p>
          <h1>Follow the activity.</h1>
          <p>Browse retained channel, comic, and delivery events in time order.</p>
        </div>
        <Link className={styles.backAction} href="/admin"><ArrowLeft size={17} aria-hidden="true" /> Overview</Link>
      </div>

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
          <Link href={activityHref("all")} aria-current={!failuresOnly ? "page" : undefined}>All activity</Link>
          <Link href={activityHref("failed-agent-replies")} aria-current={failuresOnly ? "page" : undefined}>Failed agent replies</Link>
        </nav>
        {history.items.length ? (
          <ActivityList events={history.items} showUserLink />
        ) : failuresOnly ? (
          <div className={styles.emptyState}>
            <strong>No failed agent replies recorded.</strong>
            <p>Twilio failures and undelivered callbacks for agent text replies will appear here.</p>
          </div>
        ) : (
          <ActivityList events={history.items} />
        )}
        <nav className={styles.historyPagination} aria-label="Operations activity pages">
          {cursor ? <Link href={activityHref(filter)}>Back to newest</Link> : <span />}
          {history.nextCursor ? (
            <Link href={activityHref(filter, history.nextCursor)}>
              Older events <ArrowRight size={17} aria-hidden="true" />
            </Link>
          ) : <span />}
        </nav>
      </section>
    </div>
  );
}
