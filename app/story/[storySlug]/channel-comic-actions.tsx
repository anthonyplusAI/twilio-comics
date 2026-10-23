"use client";

import { useRef, useState } from "react";
import { Check, Copy, Download, Share2 } from "lucide-react";
import styles from "./channel-comic-viewer.module.css";

export function ChannelComicActions({
  title,
  imageUrls,
}: {
  title: string;
  imageUrls: string[];
}) {
  const [notice, setNotice] = useState("");
  const [isDownloading, setIsDownloading] = useState(false);
  const downloadInProgress = useRef(false);

  const comicUrl = () => new URL(window.location.pathname, window.location.origin).toString();

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(comicUrl());
      setNotice("Link copied");
    } catch {
      setNotice("Copy this page's address from your browser.");
    }
  };

  const shareComic = async () => {
    if (!navigator.share) {
      await copyLink();
      return;
    }

    try {
      await navigator.share({ title, url: comicUrl() });
      setNotice("");
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      await copyLink();
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
        <button className={`${styles.actionButton} ${styles.shareButton}`} onClick={shareComic} type="button">
          <Share2 size={19} aria-hidden="true" /> Share comic
        </button>
        <button className={styles.actionButton} onClick={copyLink} type="button">
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
      <p className={styles.actionNotice} role="status" aria-live="polite">{notice}</p>
    </div>
  );
}
