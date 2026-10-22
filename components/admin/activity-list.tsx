import Link from "next/link";
import type { AdminActivityRow } from "@/lib/admin-analytics";
import { formatAdminDate } from "@/components/admin/format";
import styles from "@/app/admin/admin.module.css";

const eventLabels: Record<string, string> = {
  "message.inbound": "Text received",
  "message.outbound": "Text sent",
  "message.delivery": "Delivery update",
  "voice.started": "Call started",
  "voice.ended": "Call ended",
  "voice.caller_turn": "Caller spoke",
  "voice.agent_turn": "Agent replied",
  "generation.requested": "Comic requested",
  "generation.started": "Comic generation started",
  "generation.succeeded": "Comic generated",
  "generation.failed": "Comic generation failed",
  "generation.delivery": "Comic delivery",
};

export function ActivityList({
  events,
  compact = false,
}: {
  events: AdminActivityRow[];
  compact?: boolean;
}) {
  if (!events.length) {
    return (
      <div className={styles.emptyState}>
        <strong>No activity recorded yet.</strong>
        <p>Texts, calls, comic jobs, and delivery updates will appear here.</p>
      </div>
    );
  }

  return (
    <ol className={styles.activityList}>
      {events.map((event) => (
        <li className={styles.activityItem} key={event.id}>
          <div className={styles.activityDot} aria-hidden="true" />
          <div className={styles.activityBody}>
            <div className={styles.activityHeading}>
              <strong>{eventLabels[event.kind] ?? event.kind.replaceAll(".", " ")}</strong>
              <time dateTime={new Date(event.occurred_at).toISOString()}>
                {formatAdminDate(event.occurred_at)}
              </time>
            </div>
            <div className={styles.eventTags}>
              <span>{event.channel}</span>
              {event.status ? <span data-status={event.status}>{event.status}</span> : null}
              {event.direction ? <span>{event.direction}</span> : null}
              {event.address ? <span className={styles.addressTag}>{event.address}</span> : null}
            </div>
            {event.content ? <p className={styles.eventContent}>{event.content}</p> : null}
            {compact ? (
              event.user_id ? (
                <Link className={styles.inlineLink} href={`/admin/users/${encodeURIComponent(event.user_id)}`}>
                  View user history
                </Link>
              ) : null
            ) : (
              <>
                {(event.call_sid || event.message_sid || event.job_id || event.story_id) ? (
                  <dl className={styles.eventReferences}>
                    {event.call_sid ? <><dt>Call SID</dt><dd>{event.call_sid}</dd></> : null}
                    {event.message_sid ? <><dt>Message SID</dt><dd>{event.message_sid}</dd></> : null}
                    {event.job_id ? <><dt>Job ID</dt><dd>{event.job_id}</dd></> : null}
                    {event.story_id ? <><dt>Story ID</dt><dd>{event.story_id}</dd></> : null}
                  </dl>
                ) : null}
                {event.details && Object.keys(event.details).length ? (
                  <details className={styles.detailDisclosure}>
                    <summary>Recorded details</summary>
                    <pre>{JSON.stringify(event.details, null, 2)}</pre>
                  </details>
                ) : null}
              </>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
