import Image from "next/image";
import { COMIC_STYLES } from "@/lib/constants";
import styles from "./comic-preview.module.css";

const previewImages: Record<(typeof COMIC_STYLES)[number]["id"], string> = {
  "american-modern": "/american.jpg",
  manga: "/manga.png",
  noir: "/noir.jpg",
  vintage: "/vintage-superman.jpg",
};

export function ComicPreview({
  style,
  onSelectStyle,
  disabled = false,
}: {
  style: string;
  onSelectStyle: (style: string) => void;
  disabled?: boolean;
}) {
  const selectedStyle = COMIC_STYLES.find((option) => option.id === style)
    ?? COMIC_STYLES[2];

  return (
    <aside className={styles.preview} aria-labelledby="style-preview-title">
      <div className={styles.previewHeader}>
        <span>02 / Explore</span>
        <h2 id="style-preview-title">See a style.</h2>
        <p>Sample art shows the look. Your photos guide your own characters.</p>
      </div>

      <div className={styles.canvas}>
        <span className={styles.sampleBadge}>Example · {selectedStyle.name}</span>
        <figure className={styles.sheet}>
          <Image
            src={previewImages[selectedStyle.id]}
            alt={`Example comic art in ${selectedStyle.name} style`}
            width={1024}
            height={1024}
            className={styles.sampleImage}
          />
          <figcaption>{selectedStyle.name} / sample page</figcaption>
        </figure>
      </div>

      <div className={styles.styleChoices} role="group" aria-label="Choose a comic style">
        {COMIC_STYLES.map((option, index) => (
          <button
            key={option.id}
            type="button"
            className={styles.styleButton}
            aria-pressed={option.id === selectedStyle.id}
            onClick={() => onSelectStyle(option.id)}
            disabled={disabled}
          >
            <span>{String(index + 1).padStart(2, "0")}</span>
            {option.name}
          </button>
        ))}
      </div>
    </aside>
  );
}
