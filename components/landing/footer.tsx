"use client";

import { useState } from "react";
import { OPENAI_LINK } from "@/lib/utils";
import { MessageSquare } from "lucide-react";
import Link from "next/link";
import { FeedbackModal } from "@/components/feedback-modal";

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.942.359.31.678.921.678 1.856 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

export function Footer() {
  const [showFeedback, setShowFeedback] = useState(false);

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
          <button
            onClick={() => setShowFeedback(true)}
            className="flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-border/50 hover:border-border hover:text-white transition-colors cursor-pointer"
          >
            <MessageSquare className="w-3 h-3" />
            Got ideas? Tell us
          </button>
          <Link
            href="https://github.com/anthonyjdella/twilio-comics"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-white transition-colors"
          >
            <GithubIcon className="w-3.5 h-3.5" />
          </Link>
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

      <FeedbackModal isOpen={showFeedback} onClose={() => setShowFeedback(false)} />
    </>
  );
}
