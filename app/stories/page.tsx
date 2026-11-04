"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ArrowUpRight, BookOpen, Loader2, Plus } from "lucide-react";
import { Footer } from "@/components/landing/footer";
import { COMIC_STYLES } from "@/lib/constants";
import marketingStyles from "../marketing.module.css";
import styles from "./stories.module.css";

interface Story {
  id: string;
  title: string;
  slug: string;
  style: string;
  createdAt: string;
  pageCount: number;
  coverImage: string | null;
}

function styleName(style: string): string {
  return COMIC_STYLES.find((option) => option.id === style)?.name ?? style;
}

export default function StoriesPage() {
  const [stories, setStories] = useState<Story[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accessEnded, setAccessEnded] = useState(false);

  const fetchStories = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setAccessEnded(false);
    try {
      const response = await fetch("/api/stories", { cache: "no-store" });
      if (response.status === 401) {
        setAccessEnded(true);
        return;
      }
      if (!response.ok) throw new Error("Your comics could not be loaded right now.");
      const data = await response.json() as { stories?: Story[] };
      if (!Array.isArray(data.stories)) throw new Error("Your comics could not be loaded right now.");
      setStories(data.stories);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Your comics could not be loaded right now.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void fetchStories(); }, [fetchStories]);

  return (
    <div className={`${marketingStyles.page} ${styles.libraryPage}`}>
      <header className={marketingStyles.siteHeader}>
        <Link href="/" className={marketingStyles.brand} aria-label="Twilio Comics home">
          <Image src="/images/twilio-bug.svg" alt="" width={40} height={40} />
          <span>Twilio Comics</span>
        </Link>
        <nav className={`${marketingStyles.headerNav} ${styles.headerNav}`} aria-label="Comic library navigation">
          <Link href="/start" className={styles.backLink}>
            <ArrowLeft size={17} aria-hidden="true" /> Start options
          </Link>
          <Link href="/studio" className={styles.headerAction}>Open Studio</Link>
        </nav>
      </header>

      <main className={styles.libraryMain}>
        <section className={styles.intro} aria-labelledby="library-title">
          <div className={styles.introInner}>
            <div>
              <p className={styles.kicker}>Twilio Comics / Browser Studio</p>
              <h1 id="library-title">Your comics.</h1>
              <p className={styles.introCopy}>Read, share, or continue the comics you made here.</p>
              <p className={styles.accessNote}>
                This browser can find your comics for up to 30 days. You can edit while Studio is open.
                Save each comic link so you can still read and share it later.
              </p>
            </div>
            <Link href="/studio" className={styles.createAction}>
              <Plus size={20} aria-hidden="true" /> Make another comic
              <ArrowUpRight size={20} aria-hidden="true" />
            </Link>
          </div>
        </section>

        <section className={styles.collection} aria-label="Comics made in this browser">
          {isLoading ? (
            <div className={styles.statePanel} role="status">
              <Loader2 className={styles.loadingIcon} size={30} aria-hidden="true" />
              <p>Loading your comics…</p>
            </div>
          ) : accessEnded ? (
            <div className={styles.statePanel}>
              <BookOpen size={38} aria-hidden="true" />
              <h2>This browser can’t open its saved comics.</h2>
              <p>
                Guest library access lasts up to 30 days in the browser used to make a comic.
                If you saved a comic link, you can still open and share it.
              </p>
              <Link href="/start" className={styles.stateAction}>See ways to start</Link>
            </div>
          ) : error ? (
            <div className={styles.statePanel} role="alert">
              <h2>We couldn’t load your comics.</h2>
              <p>{error}</p>
              <button type="button" onClick={() => void fetchStories()} className={styles.stateAction}>
                Try again
              </button>
            </div>
          ) : stories.length === 0 ? (
            <div className={styles.statePanel}>
              <BookOpen size={38} aria-hidden="true" />
              <h2>Your first comic starts with a photo.</h2>
              <p>Take or upload one or two reference photos in Browser Studio, then tell us your idea.</p>
              <Link href="/studio" className={styles.stateAction}>Make a comic</Link>
            </div>
          ) : (
            <div className={styles.grid}>
              {stories.map((story) => (
                <Link href={`/story/${encodeURIComponent(story.slug)}`} key={story.id} className={styles.storyCard}>
                  <div className={styles.cover}>
                    {story.coverImage ? (
                      <img src={story.coverImage} alt={`Cover of ${story.title}`} loading="lazy" />
                    ) : (
                      <div className={styles.coverPending}>
                        <Loader2 className={styles.loadingIcon} size={30} aria-hidden="true" />
                        <span>Creating page…</span>
                      </div>
                    )}
                  </div>
                  <div className={styles.storyDetails}>
                    <span className={styles.styleName}>{styleName(story.style)}</span>
                    <h2>{story.title}</h2>
                    <p>
                      {story.pageCount} {story.pageCount === 1 ? "page" : "pages"}
                      <span aria-hidden="true"> · </span>
                      {new Date(story.createdAt).toLocaleDateString("en-US", {
                        month: "short", day: "numeric", year: "numeric",
                      })}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
      </main>

      <Footer />
    </div>
  );
}
