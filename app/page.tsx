import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight, ScanLine } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import styles from "./marketing.module.css";

// The public QR destination is injected into the Container App at runtime.
export const dynamic = "force-dynamic";

export default function Home() {
  const startUrl = new URL("/start", process.env.PUBLIC_BASE_URL || "http://localhost:3000").toString();

  return (
    <div className={styles.page}>
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
      </header>

      <main>
        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={styles.heroCopy}>
            <p className={styles.kicker}>Your comic starts with Twilio</p>
            <h1 id="hero-title">
              Your words.
              <br />
              A world of panels.
            </h1>
            <p className={styles.heroDescription}>
              Bring a story idea. Our AI agent helps turn it into a comic, then sends the finished link to your phone.
            </p>

            <div className={styles.startBlock} id="start">
              <Link className={styles.startAction} href="/start">
                Choose how to start <ArrowUpRight size={22} aria-hidden="true" />
              </Link>
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
            <div className={styles.qrCard}>
              <div className={styles.qrFrame}>
                <QRCodeSVG
                  value={startUrl}
                  size={132}
                  level="M"
                  includeMargin
                  bgColor="#ffffff"
                  fgColor="#000d25"
                  title="Scan to choose how to start"
                />
              </div>
              <div className={styles.qrCopy}>
                <ScanLine size={19} aria-hidden="true" />
                <span>Scan to choose how to start</span>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.howSection} id="how-it-works" aria-labelledby="how-title">
          <div className={styles.sectionIntro}>
            <p>How it works</p>
            <h2 id="how-title">From a thought to a comic page.</h2>
          </div>
          <div className={styles.steps}>
            <article className={styles.step}>
              <span className={styles.stepNumber}>1</span>
              <h3>Choose how to start</h3>
              <p>Open the start page and pick how you want to reach the agent.</p>
            </article>
            <article className={styles.step}>
              <span className={styles.stepNumber}>2</span>
              <h3>Share your idea</h3>
              <p>Bring a character, a joke, or one wild scene. The agent helps shape your story.</p>
            </article>
            <article className={styles.step}>
              <span className={styles.stepNumber}>3</span>
              <h3>Get your comic</h3>
              <p>We send the finished comic link to your phone.</p>
            </article>
          </div>
        </section>
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
