import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Footer } from "@/components/landing/footer";
import { getBrowserStudioEnabled } from "@/lib/browser-studio-settings";
import { isStudioStartReady } from "@/lib/studio-start-readiness";
import marketingStyles from "../marketing.module.css";
import styles from "./studio.module.css";
import { StudioClient } from "./studio-client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Browser Studio | Twilio Comics",
  description: "Take or upload a photo and make your own comic in Twilio Comics Studio.",
};

export default async function StudioPage() {
  if (isStudioStartReady() && await getBrowserStudioEnabled()) {
    return <StudioClient />;
  }

  return (
    <div className={`${marketingStyles.page} ${styles.studioPage}`}>
      <header className={marketingStyles.siteHeader}>
        <Link href="/" className={marketingStyles.brand} aria-label="Twilio Comics home">
          <Image src="/images/twilio-bug.svg" alt="" width={40} height={40} />
          <span>Twilio Comics</span>
        </Link>
        <nav className={marketingStyles.headerNav} aria-label="Studio navigation">
          <Link href="/start" className={styles.backLink}>
            <ArrowLeft size={17} aria-hidden="true" /> Start options
          </Link>
        </nav>
      </header>
      <main>
        <section className={styles.hero} aria-labelledby="studio-title">
          <div className={`${styles.heroInner} ${styles.closedHeroInner}`}>
            <div>
              <p className={styles.kicker}>Twilio Comics / Browser Studio</p>
              <h1 id="studio-title">Browser Studio is closed.</h1>
              <p className={styles.heroCopy}>Choose another available way to make your comic.</p>
              <Link href="/start" className={styles.backLink}>See ways to play</Link>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
