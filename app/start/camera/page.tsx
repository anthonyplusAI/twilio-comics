import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getCameraDestination } from "@/lib/browser-photo-access";
import marketingStyles from "../../marketing.module.css";
import CameraClient from "./camera-client";
import styles from "./camera.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Add photos | Twilio Comics",
  description: "Verify your phone, add photos, then tell the Twilio Comics agent your idea by text or call.",
};

export default async function CameraPage() {
  const destination = await getCameraDestination();
  const startAction = destination?.smsHref && destination.callHref
    ? "text or call"
    : destination?.smsHref ? "text" : "call";

  return (
    <div className={`${marketingStyles.page} ${styles.cameraPage}`}>
      <header className={marketingStyles.siteHeader}>
        <Link href="/" className={marketingStyles.brand} aria-label="Twilio Comics home">
          <Image src="/images/twilio-bug.svg" alt="" width={40} height={40} />
          <span>Twilio Comics</span>
        </Link>
        <nav className={marketingStyles.headerNav} aria-label="Main navigation">
          <Link href="/start" className={styles.backLink}>
            <ArrowLeft size={18} aria-hidden="true" /> Channels
          </Link>
        </nav>
      </header>

      <main>
        <section className={styles.hero}>
          <div className={styles.heroInner}>
            <p className={styles.kicker}>Optional photo setup</p>
            <h1>{destination ? "Put yourself in the comic." : "Photo setup is unavailable."}</h1>
            <p>
              {destination
                ? `Verify your number, add up to two photos, then ${startAction} from that same number. Share your idea with the agent on your phone.`
                : "Choose an available way to start your comic."}
            </p>
          </div>
        </section>

        {destination ? (
          <CameraClient
            smsHref={destination.smsHref}
            callHref={destination.callHref}
            contactNumber={destination.phoneNumber}
          />
        ) : (
          <div className={styles.unavailable}>
            <Link href="/start">Back to channels</Link>
          </div>
        )}
      </main>

      <footer className={styles.footer}>
        <p>Photos are kept for your comic and can be deleted on request.</p>
        <div>
          <Link href="/privacy">Privacy Policy</Link>
          <Link href="/terms">Terms of Service</Link>
        </div>
      </footer>
    </div>
  );
}
