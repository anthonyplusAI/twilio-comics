import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, BookOpen, MessageCircle, Phone, ScanLine } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { GitHubStarLink } from "@/components/github-star-link";
import {
  COMIC_START_MESSAGE,
  getMarketingContact,
} from "@/lib/marketing-contact";
import { getBrowserStudioEnabled } from "@/lib/browser-studio-settings";
import { getExperienceSettings } from "@/lib/photo-experience-settings";
import { getPublicEnabledChannels } from "@/lib/public-channel-readiness";
import { getPublicOrigin } from "@/lib/public-origin";
import { isStudioStartReady } from "@/lib/studio-start-readiness";
import { isVoiceVerificationConfigured } from "@/lib/voice-verification";
import marketingStyles from "../marketing.module.css";
import styles from "./start.module.css";

type StartChoice = {
  id: "sms" | "voice" | "studio";
  label: string;
  heading: string;
  destination: string;
  description: string;
  href: string;
  action: string;
  qrValue: string;
  qrTitle: string;
  qrCaption: string;
};

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Choose how to start | Twilio Comics",
  description:
    "Choose an available way to make a comic by text, text plus call, or in your browser.",
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
  const hasSms = selectedChannels.includes("sms") && Boolean(contact.smsHref);
  const selectedVoice = selectedChannels.includes("voice") && Boolean(contact.callHref);
  const settings = hasSms || selectedVoice ? await getExperienceSettings() : null;
  const showStudio = isStudioStartReady() && await getBrowserStudioEnabled();
  const hasVoice = selectedVoice && hasSms && settings?.voicePhotoMode !== "none";
  const hasTextDelivery = hasSms || hasVoice;
  const publicOrigin = getPublicOrigin() || "http://localhost:3000";
  const voiceStartUrl = new URL(
    "/start/voice",
    publicOrigin,
  ).toString();
  const channelChoices: StartChoice[] = [
    ...(hasSms ? [{
      id: "sms",
      label: "Twilio SMS",
      heading: "Text your photos.",
      destination: phoneNumber,
      description: "Text one photo for one character, or two for different characters. Then share your idea and choose a style by text.",
      href: contact.smsHref ?? "",
      action: "Open text to add photos",
      qrValue: contact.smsHref ?? "",
      qrTitle: `Scan to text reference photos to ${phoneNumber} with ${COMIC_START_MESSAGE}`,
      qrCaption: "Scan, attach photos, then send.",
    } satisfies StartChoice] : []),
    ...(hasVoice ? [{
      id: "voice",
      label: "SMS + Voice",
      heading: "Photos, then call.",
      destination: phoneNumber,
      description: "Text one photo per character. The photo reply gives you a number to call and tell your idea by voice.",
      href: "/start/voice",
      action: "Set up photos first",
      qrValue: voiceStartUrl,
      qrTitle: "Scan to add photos before your Voice call",
      qrCaption: "Scan to add photos, then call.",
    } satisfies StartChoice] : []),
  ];
  const activeChoices: StartChoice[] = [
    ...channelChoices,
    ...(showStudio ? [{
      id: "studio" as const,
      label: "Browser Studio",
      heading: "Create in Studio.",
      destination: "No sign-in needed",
      description: `Take or upload one or two photos, choose a style, and make your comic in the browser. ${hasSms && isVoiceVerificationConfigured() ? "You can also text yourself the finished link." : "View and share the finished comic there."}`,
      href: "/studio",
      action: "Open Studio",
      qrValue: new URL("/studio", publicOrigin).toString(),
      qrTitle: "Scan to open Browser Studio",
      qrCaption: "Scan to create in your browser.",
    }] : []),
  ];

  return (
    <div className={`${marketingStyles.page} ${styles.startPage}`}>
      <header className={marketingStyles.siteHeader}>
        <Link href="/" className={marketingStyles.brand} aria-label="Twilio Comics home">
          <Image src="/images/twilio-bug.svg" alt="" width={40} height={40} />
          <span>Twilio Comics</span>
        </Link>
        <nav className={marketingStyles.headerNav} aria-label="Main navigation">
          <Link href="/" className={styles.backLink} aria-label="Home">
            <ArrowLeft size={17} aria-hidden="true" />
            <span className={marketingStyles.navText}>Home</span>
          </Link>
          <GitHubStarLink className={marketingStyles.githubStar} />
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
                ? "Start with at least one reference photo. Then share your comic idea using any available option below."
                : selectedVoice
                  ? "Calls need reference photos. Come back when photo setup is available."
                  : "Come back to start your comic when an option is ready."}
            </p>
          </div>
        </section>

        {activeChoices.length > 0 && (
          <section className={styles.choicesSection} aria-label="Available ways to start">
            <div className={styles.cards}>
              {activeChoices.map((choice) => (
                <article
                  className={`${styles.card} ${styles[choice.id]}`}
                  key={choice.id}
                >
                  <div className={styles.cardBand}>
                    <span className={styles.channelIcon} aria-hidden="true">
                      {choice.id === "voice" ? <Phone size={24} />
                        : choice.id === "studio" ? <BookOpen size={24} />
                        : <MessageCircle size={24} />}
                    </span>
                    <span className={styles.channelLabel}>{choice.label}</span>
                  </div>
                  <div className={styles.cardTop}>
                    <div className={styles.cardAction}>
                      <h2>{choice.heading}</h2>
                      <p className={styles.destination}>{choice.destination}</p>
                      <p className={styles.cardDescription}>{choice.description}</p>
                      {choice.href.startsWith("/") ? (
                        <Link className={styles.channelButton} href={choice.href}>
                          {choice.action} <ArrowUpRight size={22} aria-hidden="true" />
                        </Link>
                      ) : (
                        <a className={styles.channelButton} href={choice.href}>
                          {choice.action} <ArrowUpRight size={22} aria-hidden="true" />
                        </a>
                      )}
                    </div>
                    <div className={styles.qrPanel}>
                      <div className={styles.qrFrame}>
                        <QRCodeSVG
                          value={choice.qrValue}
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
            <details className={styles.howItWorks}>
              <summary>How it works</summary>
              <ul>
                {hasSms && (
                  <li>
                    <strong>Text:</strong> Send at least one photo, then an idea. The agent guides you and texts
                    the comic link.
                  </li>
                )}
                {hasVoice && (
                  <li>
                    <strong>Call:</strong> Save photos first, then call from the same number. Confirm the SMS code and tell the agent your idea.
                    Your comic link arrives by text.
                  </li>
                )}
                {showStudio && (
                  <li>
                    <strong>Browser:</strong> Take or upload photos, add your idea, choose a style, and create in your browser. Text yourself the link if you want.
                  </li>
                )}
              </ul>
            </details>
            {channelChoices.length > 0 && (
              <p className={styles.programDisclosure}>
                Twilio Comics sends automated replies and comic links by text.{" "}
                Message frequency varies; message and data rates may apply.{" "}
                {hasTextDelivery && "Reply HELP for help or STOP to opt out. "}
                Public five-digit comic links can be guessed.{" "}
                <Link href="/privacy">Privacy Policy</Link> ·{" "}
                <Link href="/terms">Terms of Service</Link>
              </p>
            )}
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
