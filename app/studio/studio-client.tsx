"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { useEffect, useState } from "react";
import { ComicCreationForm } from "@/components/landing/comic-creation-form";
import { ComicPreview } from "@/components/landing/comic-preview";
import { Footer } from "@/components/landing/footer";
import marketingStyles from "../marketing.module.css";
import styles from "./studio.module.css";

export function StudioClient() {
  const [prompt, setPrompt] = useState("");
  const [style, setStyle] = useState("noir");
  const [characterFiles, setCharacterFiles] = useState<File[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [studioReady, setStudioReady] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function openStudio() {
      try {
        const response = await fetch("/api/studio/session", {
          method: "POST",
          cache: "no-store",
        });
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(body?.error || "Browser Studio could not open. Please refresh and try again.");
        }
        if (active) setStudioReady(true);
      } catch (error) {
        if (active) setSessionError(error instanceof Error ? error.message : "Browser Studio could not open.");
      }
    }
    void openStudio();
    return () => { active = false; };
  }, []);

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
          {studioReady && <Link href="/stories">My comics</Link>}
        </nav>
      </header>

      <main>
        <section className={styles.hero} aria-labelledby="studio-title">
          <div className={styles.heroInner}>
            <div>
              <p className={styles.kicker}>Twilio Comics / Browser Studio</p>
              <h1 id="studio-title">Your photo.<br />Your comic.</h1>
              <p className={styles.heroCopy}>
                Take or upload one or two reference photos, describe your idea, and choose a style.
                Twilio Comics creates your page in the browser. No account or phone number is needed.
              </p>
              {sessionError && <p className={styles.accessNote} role="alert">{sessionError} <button type="button" onClick={() => window.location.reload()}>Try again</button></p>}
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
                studioReady={studioReady}
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
            <div className={styles.previewColumn}>
              <ComicPreview style={style} onSelectStyle={setStyle} disabled={isLoading} />
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}
