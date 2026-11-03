"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { Key, User, Plus } from "lucide-react";

import Link from "next/link";
import { ApiKeyModal } from "@/components/api-key-modal";
import { AccountMenu } from "@/components/auth/account-menu";
import { SignInButton } from "@/components/auth/sign-in-button";
import { GitHubStarLink } from "@/components/github-star-link";
import { useApiKey } from "@/hooks/use-api-key";

export function Navbar() {
  const [showApiModal, setShowApiModal] = useState(false);

  const { status } = useSession();
  const isLoaded = status !== "loading";
  const isSignedIn = status === "authenticated";
  const pathname = usePathname();
  const [, setApiKey] = useApiKey();

  const handleApiKeySubmit = (key: string) => {
    setApiKey(key);
    setShowApiModal(false);
  };

  const isOnStoriesPage = pathname === "/stories";

  if (!isLoaded)
    return <div className="h-14 max-[359px]:h-24 sm:h-16 w-full border-b border-border/50" />;

  return (
    <>
      <nav className="w-full h-14 max-[359px]:h-auto sm:h-16 border-b border-border/50 flex max-[359px]:flex-wrap items-center justify-between max-[359px]:gap-y-2 px-4 sm:px-6 lg:px-8 max-[359px]:py-2 z-50 bg-background/80 backdrop-blur-md">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-1 hover:opacity-80 transition-opacity"
        >
          <div className="w-8 h-8 sm:w-10 sm:h-10 flex items-center justify-center">
            <img
              src="/images/twilio-bug.svg"
              alt="Twilio bug logo"
              className="w-full h-full object-contain"
            />
          </div>
          <span className="whitespace-nowrap text-white font-heading tracking-[0.005em] text-lg sm:text-xl">
            Twilio Comics
          </span>
        </Link>

        <div className="flex shrink-0 items-center gap-2 sm:gap-3 max-[359px]:w-full max-[359px]:justify-between">
          {isSignedIn && (
            <button
              onClick={() => setShowApiModal(true)}
              className="flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1.5 glass-panel glass-panel-hover transition-all text-xs rounded-md cursor-pointer"
            >
              <Key className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              <span className="text-muted-foreground text-xs sm:text-sm hidden sm:inline tracking-tight">
                API Key
              </span>
            </button>
          )}

          <GitHubStarLink
            compactLabel={isSignedIn ? null : "Star"}
            className="px-2 sm:px-3 py-1.5 glass-panel glass-panel-hover transition-all text-xs rounded-md text-muted-foreground hover:text-white"
          />

          {!isSignedIn && (
            <SignInButton className="flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1.5 glass-panel glass-panel-hover transition-all text-xs rounded-md cursor-pointer">
              <span className="text-muted-foreground text-xs sm:text-sm tracking-tight">
                Sign In
              </span>
            </SignInButton>
          )}
          {isSignedIn && (
            <>
              {isOnStoriesPage ? (
                <Link href="/studio">
                  <button className="flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1.5 bg-white hover:bg-neutral-200 text-black transition-all text-xs rounded-md cursor-pointer font-medium">
                    <Plus className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                    <span className="text-black text-xs sm:text-sm hidden sm:inline tracking-tight">
                      Open Studio
                    </span>
                  </button>
                </Link>
              ) : (
                <Link href="/stories">
                  <button className="flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1.5 glass-panel glass-panel-hover transition-all text-xs rounded-md cursor-pointer">
                    <User className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                    <span className="text-muted-foreground text-xs sm:text-sm hidden sm:inline tracking-tight">
                      My Stories
                    </span>
                  </button>
                </Link>
              )}
              <AccountMenu />
            </>
          )}
        </div>
      </nav>

      <ApiKeyModal
        isOpen={showApiModal}
        onClose={() => setShowApiModal(false)}
        onSubmit={handleApiKeySubmit}
      />
    </>
  );
}
