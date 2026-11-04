"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { COMIC_STYLES } from "@/lib/constants";
import styles from "@/app/marketing.module.css";

type StyleId = (typeof COMIC_STYLES)[number]["id"];

const sampleImages: Record<StyleId, string> = {
  "american-modern": "/american.jpg",
  manga: "/manga.png",
  noir: "/noir.jpg",
  vintage: "/vintage-superman.jpg",
};

const shortNames: Record<StyleId, string> = {
  "american-modern": "American",
  manga: "Manga",
  noir: "Noir",
  vintage: "Vintage",
};

export function HomeStyleShowcase() {
  const [selectedId, setSelectedId] = useState<StyleId>("noir");
  const [paused, setPaused] = useState(false);
  const [selectedByPlayer, setSelectedByPlayer] = useState(false);
  const selectedStyle = COMIC_STYLES.find((style) => style.id === selectedId) ?? COMIC_STYLES[2];

  useEffect(() => {
    if (paused || selectedByPlayer || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    const timer = window.setInterval(() => {
      setSelectedId((currentId) => {
        const currentIndex = COMIC_STYLES.findIndex((style) => style.id === currentId);
        return COMIC_STYLES[(currentIndex + 1) % COMIC_STYLES.length].id;
      });
    }, 8000);

    return () => window.clearInterval(timer);
  }, [paused, selectedByPlayer]);

  return (
    <div className={styles.heroArt}>
      <div className={styles.artBackdrop} aria-hidden="true" />
      <div className={styles.showcaseStack}>
        <figure className={styles.comicSheet} aria-live="off">
          <Image
            key={selectedStyle.id}
            src={sampleImages[selectedStyle.id]}
            alt={`Sample comic art in ${selectedStyle.name} style`}
            width={1024}
            height={1024}
            sizes="(max-width: 640px) 80vw, (max-width: 1100px) 40vw, (max-height: 940px) 35vw, min(50vw, 800px)"
            priority={selectedStyle.id === "noir"}
          />
          <figcaption>Sample: {selectedStyle.name}</figcaption>
        </figure>
        <div
          className={styles.styleChoices}
          role="group"
          aria-label="Explore comic styles"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onFocusCapture={() => setPaused(true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) {
              setPaused(false);
            }
          }}
        >
          {COMIC_STYLES.map((style) => (
            <button
              key={style.id}
              type="button"
              className={styles.styleChoice}
              aria-label={`Show ${style.name} sample`}
              aria-pressed={selectedStyle.id === style.id}
              onClick={() => {
                setSelectedId(style.id);
                setSelectedByPlayer(true);
              }}
            >
              <Image src={sampleImages[style.id]} alt="" width={42} height={42} sizes="42px" />
              <span>{shortNames[style.id]}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
