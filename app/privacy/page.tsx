import type { Metadata } from "next";
import Link from "next/link";
import { getLegalIdentity } from "../legal-info";
import { LegalShell } from "../legal-shell";
import styles from "../marketing.module.css";

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  const { published } = getLegalIdentity();
  return {
    title: "Privacy Policy | Twilio Comics",
    description: "How Twilio Comics handles phone, comic, and service data.",
    robots: published ? undefined : { index: false, follow: false },
  };
}

export default function PrivacyPage() {
  const { operatorName, contactEmail, published } = getLegalIdentity();

  return (
    <LegalShell title="Privacy Policy" published={published}>
      <p>
        {operatorName ?? "The operator of Twilio Comics"} operates this AI comic service.
        This policy describes the information the app uses when you text, call, view a comic,
        or use its browser testing studio.
      </p>

      <section className={styles.legalSection}>
        <h2>Information we handle</h2>
        <ul>
          <li>Your phone number, channel, text messages, and voice conversation transcripts.</li>
          <li>Comic ideas, prompts, reference photos, generated pages, and story links.</li>
          <li>Message and call identifiers, delivery status, dates, errors, and usage history.</li>
          <li>Google account details and session data if you sign in to the browser studio.</li>
        </ul>
      </section>

      <section className={styles.legalSection}>
        <h2>How we use it</h2>
        <p>
          We use this information to run the AI comic conversation, generate and deliver your
          comic, show your story, maintain admin usage and delivery history, diagnose failures,
          and prevent misuse. The voice channel converts speech to text for the agent; the app
          stores finalized transcript text rather than raw call audio. Twilio handles calling
          and messaging, OpenAI processes comic ideas and images, Azure hosts
          the app, stores images and jobs, and provides the PostgreSQL database. Google is
          used only when you choose to sign in to the browser studio. Authorized app
          administrators can review identifiable conversation, call, comic, and delivery
          history through a password-protected dashboard.
        </p>
      </section>

      <section className={styles.legalSection}>
        <h2>Sharing and story links</h2>
        <p>
          We share data with the service providers named above to provide the comic service.
          We do not sell your mobile information or messaging consent, and we do not share
          mobile information or opt-in consent with third parties or affiliates for marketing
          or promotional purposes. Anyone with a story link you share may view that comic.
          Please avoid sending confidential information or images you do not want in a comic.
        </p>
      </section>

      <section className={styles.legalSection}>
        <h2>Retention and requests</h2>
        <p>
          We retain messages, voice transcripts, prompts, reference images, comic records,
          and operational history until we explicitly delete them, including when you make a
          verified deletion request. There is no automatic expiration schedule. These records
          remain in the database and storage across app deployments. We handle access and
          deletion requests manually and may need to confirm that you control the phone
          number or account. Service providers
          may retain their own records under their separate policies.
        </p>
        <p>
          {contactEmail ? (
            <>For access, correction, or deletion requests, email <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.</>
          ) : (
            <>The app operator&apos;s contact address is pending. This draft is not ready for public use.</>
          )}
        </p>
      </section>

      <section className={styles.legalSection}>
        <h2>Twilio as a provider</h2>
        <p>
          Twilio&apos;s <a href="https://www.twilio.com/en-us/legal/privacy">Twilio provider privacy notice</a>
          {" "}and <a href="https://www.twilio.com/en-us/legal/tos">Twilio provider terms</a> describe
          Twilio&apos;s services. They do not replace this app&apos;s Privacy Policy or its{" "}
          <Link href="/terms">Terms of Service</Link>.
        </p>
      </section>
    </LegalShell>
  );
}
