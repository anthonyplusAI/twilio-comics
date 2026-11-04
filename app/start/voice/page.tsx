import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, CheckCircle2, ImagePlus, MessageCircle, Phone } from "lucide-react";
import { getCameraDestination } from "@/lib/browser-photo-access";
import { getMarketingContact } from "@/lib/marketing-contact";
import { getExperienceSettings } from "@/lib/photo-experience-settings";
import { getPublicEnabledChannels } from "@/lib/public-channel-readiness";
import marketingStyles from "../../marketing.module.css";
import styles from "./voice.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Prepare your Voice comic | Twilio Comics",
  description: "Add character photos before calling the Twilio Comics agent so your comic can look like you.",
};

export default async function VoiceStartPage() {
  const contact = getMarketingContact(
    process.env.TWILIO_PHONE_NUMBER,
    process.env.TWILIO_WHATSAPP_NUMBER,
  );
  const channels = getPublicEnabledChannels(contact, process.env.TWILIO_ENABLED_CHANNELS);
  const voiceReady = channels.includes("voice") && Boolean(contact.callHref);
  const smsReady = channels.includes("sms") && Boolean(contact.smsHref);
  const settings = voiceReady ? await getExperienceSettings() : null;
  const voiceCanUsePhotos = voiceReady && settings?.voicePhotoMode !== "none";
  const camera = voiceCanUsePhotos && settings?.cameraEnabled
    ? await getCameraDestination(settings)
    : null;
  const browserUploadReady = Boolean(camera?.callHref);
  const mmsReady = voiceCanUsePhotos && smsReady;
  const hasPhotoPath = browserUploadReady || mmsReady;
  const browserUploadPrimary = browserUploadReady && !mmsReady;
  const photoTextHref = mmsReady && contact.phoneNumber ? `sms:${contact.phoneNumber}` : null;

  return (
    <div className={`${marketingStyles.page} ${styles.page}`}>
      <header className={`${marketingStyles.siteHeader} ${styles.header}`}>
        <Link href="/" className={marketingStyles.brand} aria-label="Twilio Comics home">
          <Image src="/images/twilio-bug.svg" alt="" width={40} height={40} />
          <span>Twilio Comics</span>
        </Link>
        <nav className={marketingStyles.headerNav} aria-label="Main navigation">
          <Link href="/start" className={styles.backLink}>
            <ArrowLeft size={17} aria-hidden="true" /> Start options
          </Link>
        </nav>
      </header>

      <main>
        <section className={styles.hero} aria-labelledby="voice-start-title">
          <div className={styles.heroInner}>
            <p className={styles.kicker}>Twilio Voice</p>
            <h1 id="voice-start-title">
              {!voiceReady
                ? "Voice is unavailable."
                : hasPhotoPath
                  ? "Add photos before your call."
                  : "Photo setup is unavailable for Voice."}
            </h1>
            <p className={styles.heroCopy}>
              {!voiceReady
                ? "Choose an available way to make your comic."
                : hasPhotoPath
                  ? "Your portraits make the characters yours. Save one or two photos, then call from that same number to tell the agent your story."
                  : "A personalized Voice comic needs at least one reference photo before the call."}
            </p>
          </div>
        </section>

        {!voiceReady ? (
          <section className={styles.messagePanel} role="status">
            <p>The Voice channel is not accepting calls right now.</p>
            <Link className={styles.primaryAction} href="/start">
              Back to start options <ArrowUpRight size={20} aria-hidden="true" />
            </Link>
          </section>
        ) : hasPhotoPath ? (
          <div className={styles.content}>
            <div className={styles.steps}>
              <section className={styles.step} aria-labelledby="photos-step-title">
                <div className={styles.stepHeader}>
                  <span className={styles.stepNumber}>01</span>
                  <ImagePlus size={27} aria-hidden="true" />
                </div>
                <h2 id="photos-step-title">Save your reference photos.</h2>
                {browserUploadPrimary ? (
                  <>
                    <p>
                      Verify the phone number you&apos;ll call from and take or upload one or two photos.
                      Finish photo setup, then call from that same number within 24 hours.
                    </p>
                    <Link className={styles.primaryAction} href="/start/camera">
                      Take or upload photos <ArrowUpRight size={20} aria-hidden="true" />
                    </Link>
                    <p className={styles.finePrint}>
                      You&apos;ll receive a text code to save photos and a new six-digit code when you call.
                    </p>
                  </>
                ) : (
                  <>
                    <p>
                      Attach one or two photos in a text to <strong>{contact.phoneNumber}</strong> from
                      the phone you&apos;ll call on. Wait for the “Photo saved” reply, then call within 24 hours.
                    </p>
                    <a className={styles.primaryAction} href={photoTextHref ?? undefined}>
                      <MessageCircle size={20} aria-hidden="true" /> Open Messages to attach photos
                      <ArrowUpRight size={20} aria-hidden="true" />
                    </a>
                    <p className={styles.finePrint}>
                      Send only photos first. Making another comic? Text NEW, then send fresh photos.
                    </p>
                    {browserUploadReady && (
                      <p className={styles.alternatePhotoPath}>
                        Want to use your browser camera? <Link href="/start/camera">Take or upload photos</Link> there
                        with the same phone number before calling.
                      </p>
                    )}
                  </>
                )}
              </section>

              <section className={styles.step} aria-labelledby="call-step-title">
                <div className={styles.stepHeader}>
                  <span className={styles.stepNumber}>02</span>
                  <Phone size={26} aria-hidden="true" />
                </div>
                <h2 id="call-step-title">Call from the same number.</h2>
                <p>
                  Once your photo is saved, call <strong>{contact.phoneNumber}</strong>.
                  We&apos;ll text you a six-digit code. Enter it on your phone&apos;s keypad to reach the agent.
                </p>
                <a className={styles.callAction} href={contact.callHref ?? undefined}>
                  Call after photo confirmation <ArrowUpRight size={20} aria-hidden="true" />
                </a>
                <p className={styles.finePrint}>
                  Don&apos;t have a saved photo yet? Finish step one before calling. Photos sent after the call starts
                  may not be available during that call.
                </p>
              </section>

              <section className={styles.step} aria-labelledby="idea-step-title">
                <div className={styles.stepHeader}>
                  <span className={styles.stepNumber}>03</span>
                  <CheckCircle2 size={27} aria-hidden="true" />
                </div>
                <h2 id="idea-step-title">Tell and approve your idea.</h2>
                <p>
                  Tell the agent who&apos;s in the comic and what happens. Listen to the recap, correct anything
                  you want, then say “create it” when you&apos;re ready.
                </p>
                <p className={styles.finePrint}>
                  The agent will confirm when creation starts. You can hang up then; your comic link arrives by text
                  at the number you called from.
                </p>
              </section>
            </div>
            <p className={styles.deliveryNote}>
              Your finished comic link arrives by text. Message and data rates may apply. {" "}
              <Link href="/privacy">Privacy Policy</Link> · <Link href="/terms">Terms of Service</Link>
            </p>
          </div>
        ) : (
          <section className={styles.messagePanel} role="status">
            <h2>Reference photos are unavailable for this Voice setup.</h2>
            <p>
              {settings?.voicePhotoMode === "none"
                ? smsReady
                  ? "Voice calls currently cannot use reference photos. Choose SMS for a personalized comic instead."
                  : "Voice calls currently cannot use reference photos. Choose another available start option."
                : "The browser upload and MMS photo paths are unavailable. A personalized Voice comic cannot start yet."}
            </p>
            {smsReady && contact.smsHref && (
              <a className={styles.primaryAction} href={contact.smsHref}>
                Make a photo comic by SMS <ArrowUpRight size={20} aria-hidden="true" />
              </a>
            )}
            <Link className={styles.backAction} href="/start">Back to start options</Link>
          </section>
        )}
      </main>

      <footer className={`${marketingStyles.footer} ${styles.footer}`}>
        <Link href="/privacy">Privacy Policy</Link>
        <Link href="/terms">Terms of Service</Link>
      </footer>
    </div>
  );
}
