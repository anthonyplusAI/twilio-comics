import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight, ScanLine } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { GitHubStarLink } from "@/components/github-star-link";
import { getHomeStartEntryMode } from "@/lib/home-start-entry";
import { getPublicOrigin } from "@/lib/public-origin";
import styles from "./marketing.module.css";

// The public QR destination is injected into the Container App at runtime.
export const dynamic = "force-dynamic";

export default function Home() {
  const publicOrigin = getPublicOrigin() ||
    (!process.env.PUBLIC_BASE_URL && process.env.NODE_ENV !== "production"
      ? "http://localhost:3000"
      : null);
  const startUrl = publicOrigin ? new URL("/start", publicOrigin).toString() : null;
  const mode = getHomeStartEntryMode();
  const showQr = mode !== "button" && Boolean(startUrl);
  const showButton = mode !== "qr" || !showQr;
  const startBlockClass = showQr && showButton
    ? styles.startBlock
    : `${styles.startBlock} ${showQr ? styles.startBlockQrOnly : styles.startBlockNoQr}`;

  return (
    <div className={`${styles.page} ${styles.homePage}`}>
      <header className={styles.siteHeader}>
        <Link href="/" className={styles.brand} aria-label="Twilio Comics home">
          <Image
            src="/images/twilio-bug.svg"
            alt=""
            width={40}
            height={40}
          />
          <span>Twilio Comics</span>
        </Link>
        <GitHubStarLink className={styles.githubStar} />
      </header>

      <main className={styles.homeMain}>
        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={styles.heroCopy}>
            <p className={styles.kicker}>Your comic starts with Twilio</p>
            <h1 id="hero-title">
              Your story.
              <br />
              Your comic.
            </h1>
            <p className={styles.heroDescription}>
              Add a reference photo, share your idea, and get a comic starring your characters.
            </p>

            <div className={startBlockClass} id="start">
              {showButton && (
                <Link className={styles.startAction} href="/start">
                  Choose how to start <ArrowUpRight size={22} aria-hidden="true" />
                </Link>
              )}
              {showQr && startUrl && (
                <Link className={styles.qrCard} href="/start" aria-label="Scan or tap to choose how to start">
                  <div className={styles.qrFrame}>
                    <QRCodeSVG
                      value={startUrl}
                      size={showButton ? 132 : 176}
                      level="M"
                      includeMargin
                      bgColor="#ffffff"
                      fgColor="#000d25"
                      title="Scan to choose how to start"
                    />
                  </div>
                  <div className={styles.qrCopy}>
                    <ScanLine size={19} aria-hidden="true" />
                    <span>Scan or tap to start</span>
                  </div>
                </Link>
              )}
            </div>
          </div>

          <div className={styles.heroArt}>
            <div className={styles.artBackdrop} aria-hidden="true" />
            <div className={styles.ideaBubble}>
              <span className={styles.bubbleLabel}>The idea</span>
              “A detective finds a clock that runs backwards…”
            </div>
            <figure className={styles.comicSheet}>
              <Image
                src="/noir.jpg"
                alt="Sample comic page in a noir style"
                width={1024}
                height={1024}
                priority
              />
              <figcaption>Imagine what yours could be</figcaption>
            </figure>
            <div className={styles.resultBubble}>Your comic is ready!</div>
          </div>
        </section>

        <section className={styles.howSection} id="how-it-works" aria-labelledby="how-title">
          <div className={styles.sectionIntro}>
            <p>How it works</p>
            <h2 id="how-title">Three simple steps.</h2>
          </div>
          <div className={styles.steps}>
            <article className={styles.step}>
              <span className={styles.stepNumber}>1</span>
              <h3>Add a reference photo</h3>
              <p>Show us who stars in the story.</p>
            </article>
            <article className={styles.step}>
              <span className={styles.stepNumber}>2</span>
              <h3>Share your idea</h3>
              <p>Tell us who they are and what happens.</p>
            </article>
            <article className={styles.step}>
              <span className={styles.stepNumber}>3</span>
              <h3>Get your comic</h3>
              <p>Open and share the finished comic.</p>
            </article>
          </div>
        </section>
      </main>

      <footer className={`${styles.footer} ${styles.homeFooter}`}>
        <div className={styles.footerIdentity}>
          <span>Twilio Comics</span>
        </div>
        <p className={styles.footerCredit}>
          Built by Twilio · Forked from <a href="https://github.com/Nutlope/make-comics">Make Comics</a>
        </p>
        <nav className={styles.footerLinks} aria-label="Policies">
          <Link href="/privacy" aria-label="Twilio Comics Privacy Policy">Privacy</Link>
          <Link href="/terms" aria-label="Twilio Comics Terms of Service">Terms</Link>
          <a href="https://www.twilio.com/en-us/legal/privacy" aria-label="Twilio provider privacy notice">Twilio privacy</a>
          <a href="https://www.twilio.com/en-us/legal/tos" aria-label="Twilio provider terms">Twilio terms</a>
        </nav>
      </footer>
    </div>
  );
}
