import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./marketing.module.css";

export function LegalShell({
  title,
  published,
  children,
}: {
  title: string;
  published: boolean;
  children: ReactNode;
}) {
  return (
    <div className={styles.page}>
      <header className={styles.siteHeader}>
        <Link href="/" className={styles.brand} aria-label="Twilio Comics home">
          <Image src="/images/twilio-bug.svg" alt="" width={40} height={40} />
          <span>Twilio Comics</span>
        </Link>
        <nav className={`${styles.headerNav} ${styles.legalNav}`} aria-label="Main navigation">
          <Link href="/start">How to start</Link>
        </nav>
      </header>

      <main>
        <div className={styles.legalHero}>
          <p>Twilio Comics · app policies</p>
          <h1>{title}</h1>
        </div>
        <article className={styles.legalBody}>
          {!published && (
            <div className={styles.draftNotice} role="status">
              <strong>Draft — not published for public use</strong>
              <p>
                The app operator and support contact are not configured. These app policies
                need the operator&apos;s review before the SMS and Voice launch.
              </p>
            </div>
          )}
          {children}
        </article>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerIdentity}>
          <span>Twilio Comics</span>
          <p>Your story starts on your phone.</p>
        </div>
        <p className={styles.footerCredit}>
          Forked from <a href="https://github.com/Nutlope/make-comics">Make Comics</a>.{" "}
          Thanks to its original creators and contributors.
        </p>
        <nav className={styles.footerLinks} aria-label="Policies">
          <Link href="/privacy">Twilio Comics Privacy Policy</Link>
          <Link href="/terms">Twilio Comics Terms of Service</Link>
          <a href="https://www.twilio.com/en-us/legal/privacy">Twilio provider privacy notice</a>
          <a href="https://www.twilio.com/en-us/legal/tos">Twilio provider terms</a>
        </nav>
      </footer>
    </div>
  );
}
