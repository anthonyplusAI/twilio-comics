"use client";

import Image from "next/image";
import Link from "next/link";
import { signOut, useSession } from "next-auth/react";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { useState } from "react";
import { SignInButton } from "@/components/auth/sign-in-button";
import { ComicCreationForm } from "@/components/landing/comic-creation-form";
import { ComicPreview } from "@/components/landing/comic-preview";
import { Footer } from "@/components/landing/footer";
import marketingStyles from "../marketing.module.css";
import styles from "./studio.module.css";

export default function StudioPage() {
  const [prompt, setPrompt] = useState("");
  const [style, setStyle] = useState("noir");
  const [characterFiles, setCharacterFiles] = useState<File[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const { data: session, status } = useSession();
  const hasStudioSession = status === "authenticated" &&
    session?.user?.studioAuthorized === true && Boolean(session.user.id?.trim());

  return (
    <div className={`${marketingStyles.page} ${styles.studioPage}`}>
      <header className={marketingStyles.siteHeader}>
        <Link href="/" className={marketingStyles.brand} aria-label="Twilio Comics home">
          <Image src="/images/twilio-bug.svg" alt="" width={40} height={40} />
          <span>Twilio Comics</span>
        </Link>
        <nav className={`${marketingStyles.headerNav} ${styles.headerNav}`} aria-label="Studio navigation">
          <Link href="/start" className={styles.backLink}>
            <ArrowLeft size={17} aria-hidden="true" /> Start options
          </Link>
          {hasStudioSession ? (
            <>
              <Link href="/stories">My comics</Link>
              <button type="button" className={styles.headerButton}
                onClick={() => void signOut({ redirectTo: "/start" })}>
                Sign out
              </button>
            </>
          ) : status !== "loading" ? (
            <SignInButton className={styles.headerButton}>Sign in with Google</SignInButton>
          ) : (
            <span className={styles.signInPending} aria-live="polite">Checking sign-in…</span>
          )}
        </nav>
      </header>

      <main>
        <section className={styles.hero} aria-labelledby="studio-title">
          <div className={styles.heroInner}>
            <div>
              <p className={styles.kicker}>Twilio Comics / Browser Studio</p>
              <h1 id="studio-title">Your photo.<br />Your comic.</h1>
              <p className={styles.heroCopy}>
                {hasStudioSession ? "Take or upload" : "Sign in with Google, then take or upload"} one or two
                reference photos, describe your idea, and choose a style. Twilio Comics creates your page in the browser.
              </p>
              {process.env.NODE_ENV === "production" && (
                <p className={styles.accessNote}>Browser Studio is currently for approved Google testers.</p>
              )}
            </div>
            <div className={styles.heroNote}>
              <span className={styles.heroNoteLabel}>Start with yourself</span>
              <p>Your reference photos guide the characters in your comic.</p>
              <ArrowUpRight size={28} aria-hidden="true" />
            </div>
          </div>
        </section>

        <section className={styles.workspace} aria-label="Create a comic in Browser Studio">
          <div className={styles.workspaceInner}>
            <div className={styles.formColumn}>
              <ComicCreationForm
                prompt={prompt}
                setPrompt={setPrompt}
                style={style}
                setStyle={setStyle}
                characterFiles={characterFiles}
                setCharacterFiles={setCharacterFiles}
                isLoading={isLoading}
                setIsLoading={setIsLoading}
              />
            </div>
            <ComicPreview style={style} onSelectStyle={setStyle} disabled={isLoading} />
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
