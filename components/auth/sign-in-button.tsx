"use client";

import type { ComponentProps, MouseEvent } from "react";
import { signIn } from "next-auth/react";
import { Button } from "@/components/ui/button";

type SignInButtonProps = ComponentProps<typeof Button> & {
  redirectTo?: string;
};

export function SignInButton({
  children = "Sign in with Google",
  redirectTo,
  onClick,
  ...props
}: SignInButtonProps) {
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (!event.defaultPrevented) {
      void signIn("google", {
        redirectTo: redirectTo ?? window.location.href,
      });
    }
  };

  return (
    <Button type="button" onClick={handleClick} {...props}>
      {children}
    </Button>
  );
}
