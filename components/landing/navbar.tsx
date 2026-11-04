"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpen, Plus } from "lucide-react";
import { GitHubStarLink } from "@/components/github-star-link";

/** Browser players have an invisible guest session, not a Google account. */
export function Navbar() {
  const isOnStoriesPage = usePathname() === "/stories";
  return (
    <nav className="w-full min-h-14 sm:min-h-16 border-b border-border/50 flex items-center justify-between gap-3 px-4 sm:px-6 lg:px-8 bg-background/80 backdrop-blur-md">
      <Link href="/" className="flex shrink-0 items-center gap-2 text-white font-heading text-lg sm:text-xl">
        <img src="/images/twilio-bug.svg" alt="" className="size-8 sm:size-10" />
        Twilio Comics
      </Link>
      <div className="flex items-center gap-2 sm:gap-3">
        <GitHubStarLink
          compactLabel="Star"
          className="px-2 sm:px-3 py-1.5 glass-panel glass-panel-hover text-xs rounded-md text-muted-foreground hover:text-white"
        />
        <Link
          href={isOnStoriesPage ? "/studio" : "/stories"}
          className="flex items-center gap-1.5 px-3 py-2 bg-white hover:bg-neutral-200 text-black text-sm rounded-md font-medium"
        >
          {isOnStoriesPage ? <Plus className="size-4" /> : <BookOpen className="size-4" />}
          <span>{isOnStoriesPage ? "Open Studio" : "My comics"}</span>
        </Link>
      </div>
    </nav>
  );
}
