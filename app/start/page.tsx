import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, MessageCircle, Phone, ScanLine } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import {
  COMIC_START_MESSAGE,
  getMarketingContact,
  type MarketingChannel,
} from "@/lib/marketing-contact";
import { getCameraDestination } from "@/lib/browser-photo-access";
import { getExperienceSettings } from "@/lib/photo-experience-settings";
import { getPublicEnabledChannels } from "@/lib/public-channel-readiness";
import marketingStyles from "../marketing.module.css";
import styles from "./start.module.css";

type ChannelChoice = {
  id: MarketingChannel;
  label: string;
  heading: string;
  destination: string;
  href: string;
  action: string;
  qrTitle: string;
  qrCaption: string;
};

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Choose a channel | Twilio Comics",
  description:
    "Choose an available Twilio text or phone channel, shape a comic idea with the agent, and get the result on your phone.",
};

export default async function StartPage() {
  const contact = getMarketingContact(
    process.env.TWILIO_PHONE_NUMBER,
    process.env.TWILIO_WHATSAPP_NUMBER,
  );
  const selectedChannels = getPublicEnabledChannels(
    contact,
    process.env.TWILIO_ENABLED_CHANNELS,
  );
  const phoneNumber = contact.phoneNumber ?? "";
  const whatsappNumber = contact.whatsappNumber ?? "";
  const choices: Record<MarketingChannel, ChannelChoice> = {
    sms: {
      id: "sms",
      label: "Twilio SMS",
      heading: "Text us.",
      destination: phoneNumber,
      href: contact.smsHref ?? "",
      action: "Open SMS draft",
      qrTitle: `Scan to open a text to ${phoneNumber} with ${COMIC_START_MESSAGE}`,
      qrCaption: "Scan to open a text.",
    },
    whatsapp: {
      id: "whatsapp",
      label: "Twilio WhatsApp",
      heading: "Chat with us.",
      destination: whatsappNumber,
      href: contact.whatsappHref ?? "",
      action: "Open WhatsApp",
      qrTitle: `Scan to open WhatsApp with ${COMIC_START_MESSAGE}`,
      qrCaption: "Scan to open WhatsApp.",
    },
    voice: {
      id: "voice",
      label: "Twilio Voice",
      heading: "Call us.",
      destination: phoneNumber,
      href: contact.callHref ?? "",
      action: "Call the agent",
      qrTitle: `Scan to call ${phoneNumber}`,
      qrCaption: "Scan to call.",
    },
  };
  const activeChoices = selectedChannels
    .map((channel) => choices[channel])
    .filter((choice) => Boolean(choice.href));
  const hasSms = activeChoices.some((choice) => choice.id === "sms");
  const hasVoice = activeChoices.some((choice) => choice.id === "voice");
  const hasTextDelivery = hasSms || hasVoice;
  const settings = hasTextDelivery ? await getExperienceSettings() : null;
  const voicePhotoMode = hasVoice ? settings?.voicePhotoMode : null;
  const voiceUsesPhotos = hasVoice && voicePhotoMode !== "none";
  const cameraDestination = settings?.cameraEnabled
    ? await getCameraDestination(settings)
    : null;
  const showCamera = Boolean(cameraDestination);

  return (
    <div className={`${marketingStyles.page} ${styles.startPage}`}>
      <header className={marketingStyles.siteHeader}>
        <Link href="/" className={marketingStyles.brand} aria-label="Twilio Comics home">
          <Image src="/images/twilio-bug.svg" alt="" width={40} height={40} />
          <span>Twilio Comics</span>
        </Link>
        <nav className={marketingStyles.headerNav} aria-label="Main navigation">
          <Link href="/" className={styles.backLink}>
            <ArrowLeft size={17} aria-hidden="true" /> Home
          </Link>
        </nav>
      </header>

      <main>
        <section
          className={styles.intro}
          aria-labelledby="start-title"
          role={activeChoices.length ? undefined : "status"}
        >
          <div className={styles.introInner}>
            <h1 id="start-title">
              {activeChoices.length ? "Choose how to start." : "Comic line opening soon."}
            </h1>
            <p className={styles.introCopy}>
              {activeChoices.length
                ? "Your comic arrives on your phone. Public five-digit links can be guessed."
                : "Come back to start your comic when a channel is ready."}
            </p>
          </div>
        </section>

        {activeChoices.length > 0 && (
          <section className={styles.choicesSection} aria-label="Available channels">
            <div className={styles.cards}>
              {activeChoices.map((choice) => (
                <article
                  className={`${styles.card} ${styles[choice.id]}`}
                  key={choice.id}
                >
                  <div className={styles.cardBand}>
                    <span className={styles.channelIcon} aria-hidden="true">
                      {choice.id === "voice" ? <Phone size={24} /> : <MessageCircle size={24} />}
                    </span>
                    <span className={styles.channelLabel}>{choice.label}</span>
                  </div>
                  <div className={styles.cardTop}>
                    <div className={styles.cardAction}>
                      <h2>{choice.heading}</h2>
                      <p className={styles.destination}>{choice.destination}</p>
                      <a className={styles.channelButton} href={choice.href}>
                        {choice.action} <ArrowUpRight size={22} aria-hidden="true" />
                      </a>
                    </div>
                    <div className={styles.qrPanel}>
                      <div className={styles.qrFrame}>
                        <QRCodeSVG
                          value={choice.href}
                          size={146}
                          level="M"
                          includeMargin
                          bgColor="#ffffff"
                          fgColor="#000d25"
                          title={choice.qrTitle}
                        />
                      </div>
                      <p><ScanLine size={16} aria-hidden="true" /> {choice.qrCaption}</p>
                    </div>
                  </div>
                </article>
              ))}
            </div>
            {(hasSms || showCamera) && (
              <div className={showCamera
                ? `${styles.photoPath} ${styles.cameraPath}`
                : styles.photoPath}
              >
                <p>
                  <strong>Want to appear in the comic?</strong>{" "}
                  {hasSms
                    ? voiceUsesPhotos
                      ? "Text up to two photos, then keep texting or call from the same number."
                      : "Text up to two photos, then share your idea."
                    : "Take photos here, then call from the same number."}
                  {hasVoice && " Or call without photos."}
                </p>
                {showCamera && (
                  <Link className={styles.cameraLink} href="/start/camera">
                    Take photos <ArrowUpRight size={18} aria-hidden="true" />
                  </Link>
                )}
              </div>
            )}
            <details className={styles.howItWorks}>
              <summary>How it works</summary>
              <ul>
                {hasSms && (
                  <li>
                    <strong>Text:</strong> Send a photo or an idea. The agent guides you and texts
                    the comic link.
                  </li>
                )}
                {hasVoice && (
                  <li>
                    <strong>Call:</strong> Confirm the SMS code, then tell the agent your idea.
                    Your comic link arrives by text.
                  </li>
                )}
                {activeChoices.some((choice) => choice.id === "whatsapp") && (
                  <li>
                    <strong>WhatsApp:</strong> Share your idea in chat. The agent sends your
                    comic link there.
                  </li>
                )}
              </ul>
            </details>
            <p className={styles.programDisclosure}>
              {hasTextDelivery
                ? "Twilio Comics sends automated replies and comic links by text. "
                : "Twilio Comics sends automated replies and comic links in WhatsApp. "}
              Message frequency varies; message and data rates may apply.{" "}
              {hasTextDelivery && "Reply HELP for help or STOP to opt out. "}
              <Link href="/privacy">Privacy Policy</Link> ·{" "}
              <Link href="/terms">Terms of Service</Link>
            </p>
          </section>
        )}
      </main>

      <footer className={`${marketingStyles.footer} ${styles.startFooter}`}>
        <p className={styles.forkCredit}>
          Forked from <a href="https://github.com/Nutlope/make-comics">Make Comics</a>.
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
