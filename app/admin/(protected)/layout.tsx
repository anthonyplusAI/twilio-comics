import type { Metadata } from "next";
import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight, LogOut } from "lucide-react";
import { requireAdmin } from "@/lib/admin-access";
import { adminSignOut } from "@/app/admin/actions";
import styles from "../admin.module.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  title: "Operations | Twilio Comics",
  robots: { index: false, follow: false },
};

export default async function ProtectedAdminLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const session = await requireAdmin();

  return (
    <div className={styles.adminShell}>
      <header className={styles.adminHeader}>
        <div className={styles.headerInner}>
          <Link href="/admin" className={styles.adminBrand} aria-label="Twilio Comics operations home">
            <Image src="/images/twilio-bug.svg" alt="" width={34} height={34} />
            <span>Twilio Comics</span>
            <strong>Operations</strong>
          </Link>
          <nav className={styles.adminNav} aria-label="Admin navigation">
            <Link href="/admin">Overview</Link>
            <Link href="/admin/activity">Activity</Link>
            <Link href="/admin/users">People</Link>
            <Link href="/admin/settings">Settings</Link>
            <Link href="/start" target="_blank" rel="noopener noreferrer">
              Public site <ArrowUpRight size={14} aria-hidden="true" />
            </Link>
          </nav>
          <div className={styles.headerAccount}>
            <span>{session.user?.name ?? "Operator"}</span>
            <form action={adminSignOut}>
              <button type="submit" aria-label="Sign out"><LogOut size={17} /></button>
            </form>
          </div>
        </div>
      </header>
      <main className={styles.adminMain}>{children}</main>
      <footer className={styles.adminFooter}>
        <span>Twilio Comics operations</span>
        <span>All times shown in UTC · Data retained in PostgreSQL</span>
      </footer>
    </div>
  );
}
