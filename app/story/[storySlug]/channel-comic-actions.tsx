"use client";

import { useRef, useState } from "react";
import { ArrowUpRight, Camera, Check, Copy, Download, Share2 } from "lucide-react";
import { linkedInShareCaption, linkedInShareIntent, resolveComicShareUrl, xShareIntent } from "./comic-share-links";
import styles from "./channel-comic-viewer.module.css";

export function ChannelComicActions({
  title,
  imageUrls,
  shareUrl,
}: {
  title: string;
  imageUrls: string[];
  shareUrl?: string | null;
}) {
  const [notice, setNotice] = useState("");
  const [isDownloading, setIsDownloading] = useState(false);
  const [isShareOpen, setIsShareOpen] = useState(false);
  const downloadInProgress = useRef(false);

  const comicUrl = () => resolveComicShareUrl(shareUrl, window.location.origin, window.location.pathname);

  const copyLink = async (forInstagram = false) => {
    try {
      await navigator.clipboard.writeText(comicUrl());
      setNotice(forInstagram ? "Link copied. Add a Story link sticker and #Twilio." : "Link copied");
    } catch {
      setNotice(forInstagram
        ? "Copy this page's address for a Story link sticker and add #Twilio."
        : "Copy this page's address from your browser.");
    }
  };

  const shareViaDevice = async () => {
    if (!navigator.share) {
      await copyLink(false);
      return;
    }

    try {
      await navigator.share({ title, text: "Made with Twilio Comics #Twilio", url: comicUrl() });
      setNotice("");
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      await copyLink(false);
    }
  };

  const copyLinkedInCaption = async () => {
    try {
      await navigator.clipboard.writeText(linkedInShareCaption());
      setNotice("LinkedIn caption copied. Paste it, then retype @Twilio and select the official Page to make it a tag.");
    } catch {
      setNotice("In LinkedIn, type @Twilio and select its official Page. Add #Twilio too.");
    }
  };

  const downloadPdf = async () => {
    if (downloadInProgress.current || imageUrls.length === 0) return;
    downloadInProgress.current = true;
    setIsDownloading(true);

    try {
      setNotice("Preparing PDF...");
      const { buildComicPdf } = await import("@/lib/client-pdf");
      const { blob, filename } = await buildComicPdf({
        title,
        imageUrls,
        siteUrl: window.location.origin,
        onProgress: ({ page, total }) => setNotice(`Preparing page ${page} of ${total}...`),
      });

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      try {
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
      } finally {
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
      setNotice("PDF downloaded");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "PDF download failed. Please try again.");
    } finally {
      downloadInProgress.current = false;
      setIsDownloading(false);
    }
  };

  return (
    <div className={styles.actions}>
      <div className={styles.actionButtons}>
        <button
          className={`${styles.actionButton} ${styles.shareButton}`}
          onClick={() => setIsShareOpen((open) => !open)}
          type="button"
          aria-expanded={isShareOpen}
          aria-controls={isShareOpen ? "comic-share-options" : undefined}
        >
          <Share2 size={19} aria-hidden="true" /> Share comic
        </button>
        <button className={styles.actionButton} onClick={() => void copyLink(false)} type="button">
          {notice === "Link copied" ? <Check size={19} aria-hidden="true" /> : <Copy size={19} aria-hidden="true" />}
          Copy link
        </button>
        <button
          className={styles.actionButton}
          onClick={downloadPdf}
          type="button"
          disabled={isDownloading || imageUrls.length === 0}
        >
          <Download size={19} aria-hidden="true" />
          {isDownloading ? "Preparing PDF" : "Download PDF"}
        </button>
      </div>
      {isShareOpen && (
        <div className={styles.sharePanel} id="comic-share-options">
          <div className={styles.sharePanelHeading}>
            <strong>Share your comic</strong>
            <span>Choose where to send it.</span>
          </div>
          <div className={styles.shareChoices}>
            <a
              className={styles.shareChoice}
              href={xShareIntent(comicUrl())}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className={styles.shareChoiceMark}>X</span>
              <span className={styles.shareChoiceText}>X<small>Post with @twilio and #Twilio</small></span>
              <ArrowUpRight size={18} aria-hidden="true" />
            </a>
            <a
              className={styles.shareChoice}
              href={linkedInShareIntent(comicUrl())}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => void copyLinkedInCaption()}
            >
              <span className={styles.shareChoiceMark}>in</span>
              <span className={styles.shareChoiceText}>LinkedIn<small>Paste caption; retype @Twilio and select Twilio&apos;s Page</small></span>
              <ArrowUpRight size={18} aria-hidden="true" />
            </a>
            <button className={styles.shareChoice} onClick={() => void copyLink(true)} type="button">
              <Camera size={22} aria-hidden="true" />
              <span className={styles.shareChoiceText}>Instagram<small>Copy link; add #Twilio</small></span>
              <Copy size={18} aria-hidden="true" />
            </button>
            <button className={styles.shareChoice} onClick={() => void shareViaDevice()} type="button">
              <Share2 size={22} aria-hidden="true" />
              <span className={styles.shareChoiceText}>More apps<small>Share sheet or copy link</small></span>
              <ArrowUpRight size={18} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
      <p className={styles.actionNotice} role="status" aria-live="polite">{notice}</p>
    </div>
  );
}
