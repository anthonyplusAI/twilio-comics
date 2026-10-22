import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight, ExternalLink } from "lucide-react";
import { ActivityList } from "@/components/admin/activity-list";
import { formatAdminDate, formatAdminDuration } from "@/components/admin/format";
import { requireAdmin } from "@/lib/admin-access";
import { getAdminUserHistory, getAdminUserProfile } from "@/lib/admin-analytics";
import styles from "../../../admin.module.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminUserHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  await requireAdmin();
  const { userId } = await params;
  if (!userId || userId.length > 200) notFound();
  const profile = await getAdminUserProfile(userId);
  if (!profile) notFound();
  const { cursor } = await searchParams;
  const history = await getAdminUserHistory(userId, profile.addresses, cursor);
  const displayName = profile.identities[0]?.normalizedAddress
    ?? profile.user.name
    ?? profile.user.email
    ?? profile.user.id;

  return (
    <div className={styles.profilePage}>
      <Link className={styles.backAction} href="/admin/users"><ArrowLeft size={17} aria-hidden="true" /> People</Link>
      <div className={styles.profileHeader}>
        <div>
          <p className={styles.sectionKicker}>Participant record</p>
          <h1>{displayName}</h1>
          <p>{profile.user.kind} account · Joined {formatAdminDate(profile.user.createdAt)}</p>
          <p className={styles.profileId}>User ID: {profile.user.id}</p>
        </div>
        <div className={styles.profileIdentityList}>
          {profile.identities.map((identity) => (
            <div key={identity.id}>
              <span>{identity.channel}</span>
              <strong>{identity.normalizedAddress}</strong>
              <small>Last seen {formatAdminDate(identity.lastSeenAt)}</small>
            </div>
          ))}
          {!profile.identities.length && profile.user.email ? (
            <div><span>Email</span><strong>{profile.user.email}</strong></div>
          ) : null}
        </div>
      </div>

      <div className={styles.profileGrid}>
        <section className={styles.activityPanel} aria-labelledby="history-heading">
          <div className={styles.panelHeading}>
            <div>
              <h2 id="history-heading">Full activity history</h2>
              <p>Texts, voice transcript turns, generation, and delivery events in time order.</p>
            </div>
          </div>
          <ActivityList events={history.items} />
          <nav className={styles.historyPagination} aria-label="Activity history pages">
            {cursor ? <Link href={`/admin/users/${encodeURIComponent(userId)}`}>Back to newest</Link> : <span />}
            {history.nextCursor ? (
              <Link href={`/admin/users/${encodeURIComponent(userId)}?cursor=${encodeURIComponent(history.nextCursor)}`}>
                Older events <ArrowRight size={17} aria-hidden="true" />
              </Link>
            ) : <span />}
          </nav>
        </section>

        <aside className={styles.rawRecords} aria-label="Saved source records">
          <div className={styles.rawIntro}>
            <h2>Saved records</h2>
            <p>The latest 20 in each category. Event history can be paged without a time limit.</p>
          </div>

          <section className={styles.recordSection}>
            <h3>Inbound texts <span>{profile.messages.length}</span></h3>
            {profile.messages.length ? <ul className={styles.recordList}>
              {profile.messages.map((message) => <li key={message.messageSid}>
                <details className={styles.recordDisclosure}>
                  <summary><strong>{message.body.slice(0, 70) || "Photo or empty text"}</strong><small>{formatAdminDate(message.createdAt)}</small></summary>
                  <p className={styles.recordBody}>{message.body || "No text body"}</p>
                  <dl className={styles.recordMeta}>
                    <dt>Channel</dt><dd>{message.channel}</dd>
                    <dt>Status</dt><dd>{message.status}</dd>
                    <dt>Message SID</dt><dd>{message.messageSid}</dd>
                    <dt>From</dt><dd>{message.fromAddress}</dd>
                    <dt>To</dt><dd>{message.toAddress}</dd>
                    <dt>Reference photos</dt><dd>{message.mediaUrls.length}</dd>
                    <dt>Agent reply</dt><dd>{message.replyBody ?? "—"}</dd>
                    <dt>Outbound SID</dt><dd>{message.outboundSid ?? "—"}</dd>
                    <dt>Attempts</dt><dd>{message.attemptCount}</dd>
                  </dl>
                </details>
              </li>)}
            </ul> : <p className={styles.recordEmpty}>No inbound text records.</p>}
          </section>

          <section className={styles.recordSection}>
            <h3>Voice calls <span>{profile.calls.length}</span></h3>
            {profile.calls.length ? <ul className={styles.recordList}>
              {profile.calls.map((call) => <li key={call.callSid}>
                <details className={styles.recordDisclosure}>
                  <summary><strong>{call.fromAddress} · {call.status}</strong><small>{formatAdminDate(call.startedAt)}</small></summary>
                  <dl className={styles.recordMeta}>
                    <dt>Call SID</dt><dd>{call.callSid}</dd>
                    <dt>To</dt><dd>{call.toAddress}</dd>
                    <dt>Duration</dt><dd>{formatAdminDuration(call.durationSeconds)}</dd>
                    <dt>Conversation turns</dt><dd>{call.turnCount}</dd>
                    <dt>Ended</dt><dd>{formatAdminDate(call.endedAt)}</dd>
                    <dt>Error code</dt><dd>{call.errorCode ?? "—"}</dd>
                  </dl>
                </details>
              </li>)}
            </ul> : <p className={styles.recordEmpty}>No call records.</p>}
          </section>

          <section className={styles.recordSection}>
            <h3>Comic jobs <span>{profile.jobs.length}</span></h3>
            {profile.jobs.length ? <ul className={styles.recordList}>
              {profile.jobs.map((job) => <li key={job.id}>
                <details className={styles.recordDisclosure}>
                  <summary><strong>{job.source} · {job.status}</strong><small>{formatAdminDate(job.createdAt)}</small></summary>
                  <p className={styles.recordBody}>{job.prompt}</p>
                  <dl className={styles.recordMeta}>
                    <dt>Job ID</dt><dd>{job.id}</dd>
                    <dt>Style</dt><dd>{job.style}</dd>
                    <dt>Delivery</dt><dd>{job.deliveryStatus ?? "Not reported"}</dd>
                    <dt>Delivery SID</dt><dd>{job.deliverySid ?? "—"}</dd>
                    <dt>Delivery error</dt><dd>{job.deliveryErrorCode ?? "—"}</dd>
                    <dt>Fallback</dt><dd>{job.deliveryFallbackStatus ?? "—"}</dd>
                    <dt>Attempts</dt><dd>{job.attemptCount}</dd>
                    <dt>Completed</dt><dd>{formatAdminDate(job.completedAt)}</dd>
                    <dt>Last error</dt><dd>{job.lastError ?? "—"}</dd>
                  </dl>
                </details>
              </li>)}
            </ul> : <p className={styles.recordEmpty}>No comic jobs.</p>}
          </section>

          <section className={styles.recordSection}>
            <h3>Comics <span>{profile.stories.length}</span></h3>
            {profile.stories.length ? <ul className={styles.recordList}>
              {profile.stories.map((story) => <li key={story.id} className={styles.storyRecord}>
                <div><strong>{story.title}</strong><small>{story.style} · {formatAdminDate(story.createdAt)}</small></div>
                <Link href={`/story/${encodeURIComponent(story.slug)}`} target="_blank" rel="noopener noreferrer" aria-label={`Open ${story.title}`}><ExternalLink size={17} /></Link>
              </li>)}
            </ul> : <p className={styles.recordEmpty}>No comics saved.</p>}
          </section>

          <section className={styles.recordSection}>
            <h3>Conversation state <span>{profile.conversations.length}</span></h3>
            {profile.conversations.length ? <ul className={styles.recordList}>
              {profile.conversations.map((conversation) => <li key={conversation.id}>
                <details className={styles.recordDisclosure}>
                  <summary><strong>{conversation.channel} · {conversation.state}</strong><small>{formatAdminDate(conversation.updatedAt)}</small></summary>
                  <p className={styles.recordBody}>Phone: {conversation.phoneNumber}</p>
                  <pre className={styles.recordJson}>{JSON.stringify(conversation.collected, null, 2)}</pre>
                </details>
              </li>)}
            </ul> : <p className={styles.recordEmpty}>No conversation state.</p>}
          </section>
        </aside>
      </div>
    </div>
  );
}
