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
        {operatorName ?? "an operator whose name has not yet been configured"}. You can
        make a comic by text, by texting photos and then calling, or in Browser Studio
        when that option is open. Every new comic needs at least one reference photo.
        Browser Studio lets you take or upload photos without a Google account.
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
          Before calling, text one or two reference photos from the phone you will call on.
          Calls are handled by an AI voice agent. Your speech is transcribed so the agent can
          respond and shape the comic with you. After you approve the comic, its result link
          is sent by SMS to the number you called from. Use a phone that can receive SMS.
        </p>
      </section>

      <section className={styles.legalSection}>
        <h2>Browser Studio</h2>
        <p>
          When Browser Studio is open, take or upload one or two reference photos and enter
          your idea there. The finished comic appears in your browser. You may also choose
          to receive its link by SMS after verifying the phone number you enter. The browser
          session used to find your comics lasts up to 30 days on that device. Editing and
          optional texting are available while Browser Studio is open.
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
