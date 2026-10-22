import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, MessageCircle, Phone, ScanLine } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import {
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
  description: string;
  destination: string;
  href: string;
  action: string;
  nextStep: string;
  result: string;
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
      heading: "Text your idea.",
      description:
        "Send a character, a joke, or one scene. You can add up to two reference photos for your characters.",
      destination: phoneNumber,
      href: contact.smsHref ?? "",
      action: "Open Messages",
      nextStep: "Reply to the agent, then send CREATE when the story sounds right.",
      result: "Your comic link arrives by SMS, with a preview when available.",
      qrTitle: `Scan to text ${phoneNumber}`,
      qrCaption: "Scan with your phone to start a text.",
    },
    whatsapp: {
      id: "whatsapp",
      label: "Twilio WhatsApp",
      heading: "Chat it through.",
      description:
        "Message your comic idea in WhatsApp. You can share up to two reference photos in the chat.",
      destination: whatsappNumber,
      href: contact.whatsappHref ?? "",
      action: "Open WhatsApp",
      nextStep: "Reply to the agent, then send CREATE when the story sounds right.",
      result: "Your comic link arrives in the same WhatsApp chat.",
      qrTitle: "Scan for WhatsApp to start a comic",
      qrCaption: "Scan with your phone to open WhatsApp.",
    },
    voice: {
      id: "voice",
      label: "Twilio Voice",
      heading: "Talk to the agent.",
      description:
        "Call from a phone that can receive SMS. Enter the code we text you on your keypad, then tell the agent your idea out loud.",
      destination: phoneNumber,
      href: contact.callHref ?? "",
      action: "Call the agent",
      nextStep: "Enter the six digit texted code on your keypad, answer out loud, then say “create it” when the story sounds right.",
      result: "Your comic link arrives by SMS after the call.",
      qrTitle: `Scan to call ${phoneNumber}`,
      qrCaption: "Scan with your phone to call the agent.",
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
        <section className={styles.intro} aria-labelledby="start-title">
          <div className={styles.introInner}>
            <p className={styles.eyebrow}>Twilio Comics · Start here</p>
            <h1 id="start-title">Pick your way into the story.</h1>
            <p className={styles.introCopy}>
              Choose a channel, share your idea, and shape the comic with our agent.
              Your finished comic link comes back to your phone.
            </p>
          </div>
          <div className={styles.introMark} aria-hidden="true">
            <span>YOUR</span>
            <span>STORY</span>
            <span>STARTS</span>
            <span>HERE!</span>
          </div>
        </section>

        <section className={styles.choicesSection} aria-labelledby="choices-title">
          <div className={styles.sectionHeading}>
            <span className={styles.sectionRule} aria-hidden="true" />
            <h2 id="choices-title">
              {activeChoices.length ? "Choose your channel" : "The comic line is opening soon"}
            </h2>
            <p>
              {activeChoices.length
                ? "Tap a button on your phone, or scan its QR code from another screen."
                : "Available text and phone call options will appear here when they are ready."}
            </p>
          </div>

          {activeChoices.length ? (
            <div className={styles.cards}>
              {activeChoices.map((choice, index) => (
                <article
                  className={`${styles.card} ${styles[choice.id]}`}
                  key={choice.id}
                >
                  <div className={styles.cardBand}>
                    <span className={styles.channelIcon} aria-hidden="true">
                      {choice.id === "voice" ? <Phone size={24} /> : <MessageCircle size={24} />}
                    </span>
                    <span className={styles.channelLabel}>{choice.label}</span>
                    <span className={styles.channelIndex}>{String(index + 1).padStart(2, "0")}</span>
                  </div>
                  <div className={styles.cardContent}>
                    <h3>{choice.heading}</h3>
                    <p className={styles.description}>{choice.description}</p>
                    <p className={styles.destination}>
                      <span>{choice.id === "voice" ? "Call" : "Message"}</span>
                      <strong>{choice.destination}</strong>
                    </p>
                    <a className={styles.channelButton} href={choice.href}>
                      {choice.action} <ArrowUpRight size={22} aria-hidden="true" />
                    </a>
                    {(choice.id === "sms" || choice.id === "voice") && (
                      <p className={styles.programDisclosure}>
                        {choice.id === "voice"
                          ? "Twilio Comics' AI agent handles your call. Your comic result is sent by SMS to the number you call from. "
                          : "Twilio Comics sends automated replies, generation updates, and your comic link after you text us. "}
                        Message frequency varies with your requests. Message and data rates may apply.
                        Reply HELP for help or STOP to opt out. Read our{" "}
                        <Link href="/privacy">Privacy Policy</Link> and{" "}
                        <Link href="/terms">Terms of Service</Link>.
                      </p>
                    )}
                    <div className={styles.flow}>
                      <p><strong>Then</strong> {choice.nextStep}</p>
                      <p><strong>Result</strong> {choice.result}</p>
                    </div>
                  </div>
                  <div className={styles.qrPanel}>
                    <div className={styles.qrFrame}>
                      <QRCodeSVG
                        value={choice.href}
                        size={108}
                        level="M"
                        includeMargin
                        bgColor="#ffffff"
                        fgColor="#000d25"
                        title={choice.qrTitle}
                      />
                    </div>
                    <p><ScanLine size={19} aria-hidden="true" /> {choice.qrCaption}</p>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className={styles.closedPanel} role="status">
              <span className={styles.closedIcon} aria-hidden="true">
                <MessageCircle size={30} />
              </span>
              <div>
                <strong>Opening soon</strong>
                <p>Come back when a Twilio channel is connected to start your comic.</p>
              </div>
            </div>
          )}
        </section>
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
