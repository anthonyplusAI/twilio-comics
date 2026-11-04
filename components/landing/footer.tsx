"use client";

import Image from "next/image";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { ArrowUpRight, MessageSquare } from "lucide-react";
import { useState } from "react";
import { FeedbackModal } from "@/components/feedback-modal";
import { GitHubStarLink } from "@/components/github-star-link";
import styles from "./footer.module.css";

export function Footer() {
  const [showFeedback, setShowFeedback] = useState(false);
  const { data: session } = useSession();
  const canSendFeedback = session?.user?.role === "user" && Boolean(session.user.id);

  return (
    <>
      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <div className={styles.identity}>
            <Image src="/images/twilio-bug.svg" alt="" width={36} height={36} />
            <div>
              <strong>Twilio Comics</strong>
              <p>Built by Twilio.</p>
            </div>
          </div>
          <p className={styles.credit}>
            Forked from <a href="https://github.com/Nutlope/make-comics" target="_blank" rel="noopener noreferrer">Make Comics</a>.
            Thanks to its original creators and contributors.
          </p>
          <nav className={styles.links} aria-label="Studio links">
            <GitHubStarLink fullLabel="Star on GitHub" compactLabel="Star" />
            <a href="https://x.com/anthonyplusAI" target="_blank" rel="noopener noreferrer">
              Anthony on X <ArrowUpRight size={15} aria-hidden="true" />
            </a>
            <Link href="/privacy">Privacy Policy</Link>
            <Link href="/terms">Terms of Service</Link>
            {canSendFeedback && (
              <button type="button" onClick={() => setShowFeedback(true)}>
                <MessageSquare size={15} aria-hidden="true" /> Send feedback
              </button>
            )}
          </nav>
        </div>
      </footer>

      {canSendFeedback && (
        <FeedbackModal isOpen={showFeedback} onClose={() => setShowFeedback(false)} />
      )}
    </>
  );
}
