import Link from "next/link";
import { ArrowLeft, ArrowRight, Search } from "lucide-react";
import { formatAdminDate } from "@/components/admin/format";
import { requireAdmin } from "@/lib/admin-access";
import { getAdminUserDirectory } from "@/lib/admin-analytics";
import styles from "../../admin.module.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function directoryHref(search: string, page: number): string {
  const params = new URLSearchParams();
  if (search) params.set("q", search);
  if (page > 0) params.set("page", String(page));
  const query = params.toString();
  return `/admin/users${query ? `?${query}` : ""}`;
}

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  await requireAdmin();
  const params = await searchParams;
  const page = Number(params.page ?? 0);
  const directory = await getAdminUserDirectory(params.q ?? "", page);

  return (
    <div className={styles.directoryPage}>
      <div className={styles.pageHeading}>
        <div>
          <p className={styles.sectionKicker}>People &amp; history</p>
          <h1>Find a participant.</h1>
          <p>Search by phone number, email, name, or user ID.</p>
        </div>
        <Link className={styles.backAction} href="/admin"><ArrowLeft size={17} aria-hidden="true" /> Overview</Link>
      </div>

      <form className={styles.searchForm} action="/admin/users" method="get" role="search">
        <label htmlFor="admin-user-search">Search people</label>
        <div>
          <Search size={20} aria-hidden="true" />
          <input
            id="admin-user-search"
            name="q"
            type="search"
            maxLength={100}
            defaultValue={directory.search}
            placeholder="Phone, email, name, or ID"
          />
          <button type="submit">Search</button>
        </div>
      </form>

      <section className={styles.directoryPanel} aria-label="People">
        <div className={styles.directoryHead} aria-hidden="true">
          <span>Participant</span><span>Contact</span><span>Comics</span><span>Last seen</span>
        </div>
        {directory.items.length ? (
          <ol className={styles.directoryList}>
            {directory.items.map((user) => (
              <li key={user.id}>
                <Link className={styles.personRow} href={`/admin/users/${encodeURIComponent(user.id)}`}>
                  <span className={styles.personIdentity}>
                    <strong>{user.name ?? user.email ?? user.addresses ?? "Phone participant"}</strong>
                    <small>{user.kind} · {user.id}</small>
                  </span>
                  <span className={styles.personContact}>{user.addresses ?? user.email ?? "—"}</span>
                  <span className={styles.personCount}>{Number(user.comic_count).toLocaleString()}</span>
                  <span className={styles.personDate}>{formatAdminDate(user.last_activity_at)} <ArrowRight size={17} aria-hidden="true" /></span>
                </Link>
              </li>
            ))}
          </ol>
        ) : (
          <div className={styles.emptyState}>
            <strong>No people found.</strong>
            <p>Try a different phone number, email, name, or ID.</p>
          </div>
        )}
      </section>

      <nav className={styles.pagination} aria-label="People pages">
        {directory.page > 0 ? <Link href={directoryHref(directory.search, directory.page - 1)}><ArrowLeft size={17} /> Newer</Link> : <span />}
        <span>Page {directory.page + 1}</span>
        {directory.hasNext ? <Link href={directoryHref(directory.search, directory.page + 1)}>Older <ArrowRight size={17} /></Link> : <span />}
      </nav>
    </div>
  );
}
