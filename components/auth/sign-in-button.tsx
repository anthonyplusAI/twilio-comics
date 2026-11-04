"use client";

import { useState, type ComponentProps, type MouseEvent } from "react";
import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";

type SignInButtonProps = ComponentProps<typeof Button> & {
  redirectTo?: string;
};

export function SignInButton({
  children = "Sign in with Google",
  redirectTo,
  onClick,
  disabled,
  ...props
}: SignInButtonProps) {
  const [isPending, setIsPending] = useState(false);
  const [hasError, setHasError] = useState(false);

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || isPending) return;

    setIsPending(true);
    setHasError(false);
    void signIn("google", {
      redirectTo: redirectTo ?? window.location.href,
    }).catch(() => {
      setIsPending(false);
      setHasError(true);
    });
  };

  return (
    <Button
      type="button"
      onClick={handleClick}
      disabled={disabled || isPending}
      aria-busy={isPending}
      aria-live="polite"
      {...props}
    >
      {isPending ? "Opening Google…" : hasError ? "Sign-in failed. Try again" : children}
    </Button>
  );
}
