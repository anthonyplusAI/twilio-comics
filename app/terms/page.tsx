import type { Metadata } from "next";
import Link from "next/link";
import { getLegalIdentity } from "../legal-info";
import { LegalShell } from "../legal-shell";
import styles from "../marketing.module.css";

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  const { published } = getLegalIdentity();
  return {
    title: "Terms of Service | Twilio Comics",
    description: "Terms for using Twilio Comics by SMS, Voice, and the browser studio.",
    robots: published ? undefined : { index: false, follow: false },
  };
}

export default function TermsPage() {
  const { operatorName, contactEmail, published } = getLegalIdentity();

  return (
    <LegalShell title="Terms of Service" published={published}>
      <p>
        These terms cover Twilio Comics, operated by{" "}
        {operatorName ?? "an operator whose name has not yet been configured"}. Texting or
        calling the comic line asks our AI agent to help make a comic from your idea. The
        browser studio is available for testing with a Google sign-in.
      </p>

      <section className={styles.legalSection}>
        <h2>SMS program</h2>
        <p>
          Twilio Comics sends automated replies, generation updates, and comic links in
          response to your requests. Message frequency varies with your use of the service.
          Message and data rates may apply. Reply HELP for help or STOP to opt out.
          Wireless carriers are not liable for delayed or undelivered messages.
        </p>
        <p>
          {contactEmail ? (
            <>For support, email <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.</>
          ) : (
            <>The app operator&apos;s support address is pending. This draft is not ready for public use.</>
          )}
        </p>
      </section>

      <section className={styles.legalSection}>
        <h2>Voice calls and comic results</h2>
        <p>
          Calls are handled by an AI voice agent. If you ask it to create a comic, the result
          link is sent by SMS to the number you called from. Use a phone that can receive SMS.
          Your speech is transcribed so the agent can respond and shape the comic with you.
          Where offered, you may text photos or verify your number to upload photos in your
          browser before texting or calling. You can also make a comic without photos.
        </p>
      </section>

      <section className={styles.legalSection}>
        <h2>Your ideas and links</h2>
        <p>
          Send only ideas and reference images you have the right to use. AI-generated comics
          can contain mistakes or unexpected details; review a result before sharing it.
          Anyone who knows or guesses a five-digit short link may view that comic, including
          likenesses generated from reference photos.
        </p>
      </section>

      <section className={styles.legalSection}>
        <h2>Privacy and provider terms</h2>
        <p>
          Read the Twilio Comics <Link href="/privacy">Privacy Policy</Link> for details about
          data and deletion requests. Twilio&apos;s{" "}
          <a href="https://www.twilio.com/en-us/legal/privacy">Twilio provider privacy notice</a>
          {" "}and <a href="https://www.twilio.com/en-us/legal/tos">Twilio provider terms</a>
          {" "}describe Twilio&apos;s services and do not replace these app terms.
        </p>
      </section>
    </LegalShell>
  );
}
