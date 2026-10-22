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
  expectation: string;
  qrTitle: string;
  qrCaption: string;
};

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Choose a channel | Twilio Comics",
  description:
    "Choose an available Twilio text or phone channel, shape a comic idea with the agent, and get the result on your phone.",
};

export default function StartPage() {
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
      expectation: "Share your idea, then send CREATE. Your comic link arrives by SMS.",
      qrTitle: `Scan to text ${COMIC_START_MESSAGE} to ${phoneNumber}`,
      qrCaption: "Scan to open a text.",
    },
    whatsapp: {
      id: "whatsapp",
      label: "Twilio WhatsApp",
      heading: "Chat with us.",
      destination: whatsappNumber,
      href: contact.whatsappHref ?? "",
      action: "Open WhatsApp",
      expectation: "Share your idea, then send CREATE. Your comic link arrives in WhatsApp.",
      qrTitle: `Scan to start a WhatsApp chat with ${COMIC_START_MESSAGE}`,
      qrCaption: "Scan to open WhatsApp.",
    },
    voice: {
      id: "voice",
      label: "Twilio Voice",
      heading: "Call us.",
      destination: phoneNumber,
      href: contact.callHref ?? "",
      action: "Call the agent",
      expectation:
        "Call from a phone that receives texts. Enter the code on your keypad, share your idea, then say “create it.” Your comic link arrives by SMS.",
      qrTitle: `Scan to call ${phoneNumber}`,
      qrCaption: "Scan to call.",
    },
  };
  const activeChoices = selectedChannels
    .map((channel) => choices[channel])
    .filter((choice) => Boolean(choice.href));

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
                ? "Tell our AI agent your idea. Get the comic link on your phone."
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
                          size={100}
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
                  <div className={styles.cardInfo}>
                    {choice.id !== "voice" && (
                      <p className={styles.sendInstruction}>
                        <strong>{COMIC_START_MESSAGE} is in the draft. Tap Send to start.</strong>{" "}
                        Blank draft? Type {COMIC_START_MESSAGE}.
                      </p>
                    )}
                    <p className={styles.expectation}>{choice.expectation}</p>
                    {(choice.id === "sms" || choice.id === "voice") && (
                      <p className={styles.programDisclosure}>
                        {choice.id === "voice"
                          ? "An AI agent handles your call; verification and the comic link arrive by SMS. "
                          : "Automated replies and comic updates. Message frequency varies. "}
                        Message and data rates may apply.{" "}
                        {choice.id === "sms" && "Reply HELP for help or STOP to opt out. "}
                        <Link href="/privacy">Privacy Policy</Link> ·{" "}
                        <Link href="/terms">Terms of Service</Link>.
                      </p>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}
      </main>

      <footer className={marketingStyles.footer}>
        <div className={marketingStyles.footerIdentity}>
          <span>Twilio Comics</span>
          <p>Your story starts on your phone.</p>
        </div>
        <p className={marketingStyles.footerCredit}>
          Forked from <a href="https://github.com/Nutlope/make-comics">Make Comics</a>.{" "}
          Thanks to its original creators and contributors.
        </p>
        <nav className={marketingStyles.footerLinks} aria-label="Policies">
          <Link href="/privacy">Twilio Comics Privacy Policy</Link>
          <Link href="/terms">Twilio Comics Terms of Service</Link>
          <a href="https://www.twilio.com/en-us/legal/privacy">Twilio provider privacy notice</a>
          <a href="https://www.twilio.com/en-us/legal/tos">Twilio provider terms</a>
        </nav>
      </footer>
    </div>
  );
}
