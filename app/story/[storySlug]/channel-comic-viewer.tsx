import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { ChannelComicActions } from "./channel-comic-actions";
import styles from "./channel-comic-viewer.module.css";

type ComicPage = {
  pageNumber: number;
  imageUrl: string;
};

export function ChannelComicViewer({
  title,
  description,
  pages,
}: {
  title: string;
  description: string | null;
  pages: ComicPage[];
}) {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label="Twilio Comics home">
          <Image src="/images/twilio-bug.svg" alt="" width={38} height={38} />
          <span>Twilio Comics</span>
        </Link>
        <Link href="/start" className={styles.headerLink}>
          Make a comic <ArrowUpRight size={18} aria-hidden="true" />
        </Link>
      </header>

      <main>
        <section className={styles.hero} aria-labelledby="comic-title">
          <div className={styles.heroInner}>
            <p className={styles.eyebrow}>Made with Twilio Comics</p>
            <h1 id="comic-title">{title}</h1>
            {description && <p className={styles.description}>{description}</p>}
            <div className={styles.pageCount}>
              {pages.length === 0
                ? "Your comic is on its way"
                : `${pages.length} ${pages.length === 1 ? "page" : "pages"} to read`}
            </div>
            <ChannelComicActions
              title={title}
              imageUrls={pages.map((page) => page.imageUrl)}
            />
            <p className={styles.linkNotice}>Anyone with this link can view your comic.</p>
          </div>
        </section>

        <section className={styles.reader} aria-label="Comic pages">
          {pages.length === 0 ? (
            <div className={styles.emptyState}>
              <h2>Still drawing...</h2>
              <p>Check the link from your message again in a moment.</p>
            </div>
          ) : (
            <div className={styles.pageStack}>
              {pages.map((page, index) => (
                <figure className={styles.pageCard} key={page.pageNumber}>
                  <figcaption>Page {String(page.pageNumber).padStart(2, "0")}</figcaption>
                  <Image
                    className={styles.comicImage}
                    src={page.imageUrl}
                    alt={`Page ${page.pageNumber} of ${pages.length} from ${title}`}
                    width={1024}
                    height={1536}
                    sizes="(max-width: 840px) 100vw, 780px"
                    unoptimized
                    priority={index === 0}
                  />
                </figure>
              ))}
            </div>
          )}
        </section>

        <section className={styles.makeAnother} aria-labelledby="make-another-title">
          <div>
            <p className={styles.eyebrow}>Your turn</p>
            <h2 id="make-another-title">What happens next?</h2>
          </div>
          <Link href="/start" className={styles.startButton}>
            Make your own comic <ArrowUpRight size={20} aria-hidden="true" />
          </Link>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerTop}>
          <span>Twilio Comics</span>
          <p>Forked from <a href="https://github.com/Nutlope/make-comics">Make Comics</a>.</p>
        </div>
        <nav className={styles.footerLinks} aria-label="Policies">
          <Link href="/privacy">Privacy Policy</Link>
          <Link href="/terms">Terms of Service</Link>
          <a href="https://www.twilio.com/en-us/legal/privacy">Twilio provider privacy</a>
          <a href="https://www.twilio.com/en-us/legal/tos">Twilio provider terms</a>
        </nav>
      </footer>
    </div>
  );
}
