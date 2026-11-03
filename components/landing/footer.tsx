"use client";

import { useState } from "react";
import { OPENAI_LINK } from "@/lib/utils";
import { MessageSquare } from "lucide-react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { FeedbackModal } from "@/components/feedback-modal";
import { GitHubStarLink } from "@/components/github-star-link";

function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

export function Footer() {
  const [showFeedback, setShowFeedback] = useState(false);
  const { data: session } = useSession();
  const canSendFeedback = session?.user?.role === "user" && Boolean(session.user.id);

  return (
    <>
      <footer className="min-h-8 border-t border-border/50 bg-background flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-6 py-2 text-[10px] text-muted-foreground select-none">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>
            Made & powered by{" "}
            <Link
              href={OPENAI_LINK}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-white transition-colors text-white"
            >
              OpenAI
            </Link>
          </span>
          <span>
            Forked from{" "}
            <Link
              href="https://github.com/Nutlope/make-comics"
              target="_blank"
              rel="noopener noreferrer"
              className="text-white hover:underline"
            >
              Make Comics
            </Link>
            . Thanks to its original creators and contributors.
          </span>
        </div>
        <div className="flex items-center gap-3">
          {canSendFeedback && (
            <button
              onClick={() => setShowFeedback(true)}
              className="flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-border/50 hover:border-border hover:text-white transition-colors cursor-pointer"
            >
              <MessageSquare className="w-3 h-3" />
              Got ideas? Tell us
            </button>
          )}
          <GitHubStarLink
            compactLabel="Star on GitHub"
            className="hover:text-white transition-colors"
          />
          <Link
            href="https://x.com/nutlope"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-white transition-colors"
          >
            <XIcon className="w-3.5 h-3.5" />
          </Link>
        </div>
      </footer>

      {canSendFeedback && (
        <FeedbackModal isOpen={showFeedback} onClose={() => setShowFeedback(false)} />
      )}
    </>
  );
}
