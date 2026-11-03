import { Star } from "lucide-react";
import { GITHUB_REPO_URL } from "@/lib/github";

type GitHubStarLinkProps = {
  className?: string;
  fullLabel?: string;
  compactLabel?: string | null;
};

export function GitHubStarLink({
  className,
  fullLabel = "Star on GitHub",
  compactLabel = "Star",
}: GitHubStarLinkProps) {
  return (
    <a
      href={GITHUB_REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Star Twilio Comics on GitHub (opens in a new tab)"
      className={`inline-flex items-center gap-1.5 ${className ?? ""}`}
    >
      <Star className="size-4 shrink-0" aria-hidden="true" />
      <span className="hidden sm:inline">{fullLabel}</span>
      {compactLabel !== null && <span className="sm:hidden">{compactLabel}</span>}
    </a>
  );
}
