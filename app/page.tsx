import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight, MessageCircle, Phone, ScanLine } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import {
  getEnabledChannels,
  getMarketingContact,
  type MarketingChannel,
} from "@/lib/marketing-contact";
import styles from "./marketing.module.css";

type ChannelInvitation = {
  id: MarketingChannel;
  label: string;
  href: string;
  action: string;
  finalAction: string;
  heading: string;
  heroCopy: string;
  contactCopy: string;
  start: string;
  shape: string;
  delivery: string;
  qrTitle: string;
  qrCaption: string;
  toneClass: string;
};

// Public channel selection is injected into the Container App at runtime.
export const dynamic = "force-dynamic";

export default function Home() {
  const contact = getMarketingContact(
    process.env.TWILIO_PHONE_NUMBER,
    process.env.TWILIO_WHATSAPP_NUMBER,
  );
  const selectedChannels = getEnabledChannels(
    contact,
    process.env.TWILIO_ENABLED_CHANNELS,
  );
  const phoneNumber = contact.phoneNumber ?? "";
  const whatsappNumber = contact.whatsappNumber ?? "";
  const invitations: Record<MarketingChannel, ChannelInvitation> = {
    sms: {
      id: "sms",
      label: "Twilio SMS",
      href: contact.smsHref ?? "",
      action: "Text your idea",
      finalAction: "Text the Twilio number",
      heading: "Make a comic by text.",
      heroCopy: "Start with Twilio SMS: text a comic idea, shape it with the agent, and get your comic link by SMS.",
      contactCopy: `Text ${phoneNumber}. Your comic link comes back to this number by SMS.`,
      start: `Text your comic idea to ${phoneNumber}. A character, a joke, or one scene is enough.`,
      shape: "Reply to the agent's questions, then send CREATE when the story sounds right.",
      delivery: "Your comic link and a preview when available arrive by SMS. Text CONTINUE for another page.",
      qrTitle: `Scan to text ${phoneNumber}`,
      qrCaption: "Scan to text with Twilio",
      toneClass: styles.smsAction,
    },
    whatsapp: {
      id: "whatsapp",
      label: "Twilio WhatsApp",
      href: contact.whatsappHref ?? "",
      action: "Message on WhatsApp",
      finalAction: "Open Twilio WhatsApp",
      heading: "Make a comic in WhatsApp.",
      heroCopy: "Start on Twilio WhatsApp: message a comic idea, shape it with the agent, and get your comic link in the same chat.",
      contactCopy: `Message ${whatsappNumber} on WhatsApp. Your finished comic link arrives in the same chat.`,
      start: `Open a Twilio WhatsApp chat with ${whatsappNumber} and send your comic idea.`,
      shape: "Reply to the agent's questions, then send CREATE when the story sounds right.",
      delivery: "Your comic link and a preview when available arrive in the same WhatsApp chat. Send CONTINUE for another page.",
      qrTitle: "Scan to start a WhatsApp chat",
      qrCaption: "Scan for WhatsApp",
      toneClass: styles.whatsappAction,
    },
    voice: {
      id: "voice",
      label: "Twilio Voice",
      href: contact.callHref ?? "",
      action: "Call the agent",
      finalAction: "Call the Twilio number",
      heading: "Make a comic by phone.",
      heroCopy: "Start with Twilio Voice: call and talk through a comic idea with the agent. We text you the comic link after the call.",
      contactCopy: `Call ${phoneNumber} from a phone that receives SMS. Your comic link arrives by text after the call.`,
      start: `Call ${phoneNumber} and talk to the comic agent through Twilio ConversationRelay.`,
      shape: "Answer out loud, then say “create it” when the story sounds right.",
      delivery: "Your comic link and a preview when available arrive by SMS after the call. Call again to continue the story.",
      qrTitle: `Scan to call ${phoneNumber}`,
      qrCaption: "Scan to call with Twilio",
      toneClass: styles.voiceAction,
    },
  };
  const activeChannels = selectedChannels
    .map((channel) => invitations[channel])
    .filter((invitation) => Boolean(invitation.href));
  const primaryChannel = activeChannels[0];
  const hasTextChannel = activeChannels.some(({ id }) => id !== "voice");
  const hasVoice = activeChannels.some(({ id }) => id === "voice");
  const hasSms = activeChannels.some(({ id }) => id === "sms");
  const hasWhatsApp = activeChannels.some(({ id }) => id === "whatsapp");
  const photoChannelCopy = hasSms && hasWhatsApp
    ? "SMS and WhatsApp messages"
    : hasSms
      ? "SMS messages"
      : "WhatsApp messages";

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
        <nav className={styles.headerNav} aria-label="Main navigation">
          <a href="#how-it-works">How it works</a>
          {primaryChannel ? (
            <a className={styles.headerAction} href="#start">
              Start a comic <ArrowUpRight size={17} aria-hidden="true" />
            </a>
          ) : (
            <span className={styles.headerPending}>Opening soon</span>
          )}
        </nav>
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
              {activeChannels.length === 1
                ? primaryChannel.heroCopy
                : activeChannels.length > 1
                  ? "Choose a Twilio channel below. Our comic agent helps shape your idea and sends the finished comic link back to your phone."
                  : "The Twilio comic line is opening soon. Bring an idea when it opens, and we’ll shape it into a comic together."}
            </p>

            <div className={styles.startBlock} id="start">
              {primaryChannel ? (
                <>
                  <div className={styles.primaryActions}>
                    {activeChannels.map((channel) => (
                      <a
                        className={`${styles.channelAction} ${channel.toneClass}`}
                        href={channel.href}
                        key={channel.id}
                      >
                        {channel.id === "voice" ? (
                          <Phone size={21} strokeWidth={2.5} aria-hidden="true" />
                        ) : (
                          <MessageCircle size={23} strokeWidth={2.5} aria-hidden="true" />
                        )}
                        <span>{channel.action}</span>
                        <ArrowUpRight size={21} aria-hidden="true" />
                      </a>
                    ))}
                  </div>
                  <p className={styles.numberLine}>
                    {activeChannels.length === 1
                      ? primaryChannel.contactCopy
                      : "Pick a channel to begin. Follow its steps below to create your comic and see how the result arrives."}
                  </p>
                </>
              ) : (
                <div className={styles.comingSoon} role="status">
                  <span className={styles.comingSoonIcon} aria-hidden="true">
                    <Phone size={26} />
                  </span>
                  <span>
                    <strong>The comic line is opening soon.</strong>
                    <small>Start options will appear here when ready.</small>
                  </span>
                </div>
              )}
            </div>

            <p className={styles.heroFootnote}>
              {hasTextChannel && hasVoice
                ? `A sentence is enough to start. ${photoChannelCopy} can include up to two reference photos for your characters; on a call, just talk it through.`
                : hasTextChannel
                  ? "A sentence is enough to start. Your messages can include up to two reference photos for your characters."
                  : hasVoice
                    ? "A sentence is enough to start. Talk through the idea with the agent, and say when you’re ready to make it."
                    : "A character, a joke, or one wild scene is enough to begin."}
            </p>
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
            {primaryChannel && (
              <div className={styles.qrCard}>
                <div className={styles.qrFrame}>
                  <QRCodeSVG
                    value={primaryChannel.href}
                    size={132}
                    level="M"
                    includeMargin
                    bgColor="#ffffff"
                    fgColor="#000d25"
                    title={primaryChannel.qrTitle}
                  />
                </div>
                <div className={styles.qrCopy}>
                  <ScanLine size={19} aria-hidden="true" />
                  <span>{primaryChannel.qrCaption}</span>
                </div>
              </div>
            )}
          </div>
        </section>

        <section className={styles.howSection} id="how-it-works" aria-labelledby="how-title">
          <div className={styles.sectionIntro}>
            <p>How it works with Twilio</p>
            <h2 id="how-title">
              {activeChannels.length === 1
                ? primaryChannel.heading
                : primaryChannel
                  ? "Choose how to start your comic."
                  : "From a thought to a comic page."}
            </h2>
          </div>
          {primaryChannel ? (
            <div className={styles.channelGuides}>
              {activeChannels.map((channel) => (
                <article className={styles.channelGuide} key={channel.id}>
                  <div className={styles.guideHeader}>
                    <span className={styles.guideLabel}>{channel.label}</span>
                    <h3>{channel.heading}</h3>
                    <a href={channel.href}>
                      {channel.action} <ArrowUpRight size={18} aria-hidden="true" />
                    </a>
                  </div>
                  <ol className={styles.guideSteps}>
                    <li>
                      <span className={styles.stepNumber} aria-hidden="true">1</span>
                      <h4>Tell us your idea</h4>
                      <p>{channel.start}</p>
                    </li>
                    <li>
                      <span className={styles.stepNumber} aria-hidden="true">2</span>
                      <h4>Shape the story</h4>
                      <p>{channel.shape}</p>
                    </li>
                    <li>
                      <span className={styles.stepNumber} aria-hidden="true">3</span>
                      <h4>Get your comic</h4>
                      <p>{channel.delivery}</p>
                    </li>
                  </ol>
                </article>
              ))}
            </div>
          ) : (
            <div className={styles.steps}>
              <article className={styles.step}>
                <span className={styles.stepNumber}>1</span>
                <h3>Tell us your idea</h3>
                <p>Bring a character, a joke, or one wild scene when the Twilio comic line opens.</p>
              </article>
              <article className={styles.step}>
                <span className={styles.stepNumber}>2</span>
                <h3>Shape the story</h3>
                <p>The agent asks what it needs and reads the idea back before making your comic.</p>
              </article>
              <article className={styles.step}>
                <span className={styles.stepNumber}>3</span>
                <h3>Get your comic</h3>
                <p>We send a link to the full comic page when it is ready.</p>
              </article>
            </div>
          )}
        </section>

        <section className={styles.lastWord} aria-label="Start your comic">
          <p>Ready when your imagination is.</p>
          {primaryChannel ? (
            <a href={primaryChannel.href}>
              {primaryChannel.finalAction} <ArrowUpRight size={22} aria-hidden="true" />
            </a>
          ) : (
            <span>Opening soon</span>
          )}
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
      </footer>
    </div>
  );
}
