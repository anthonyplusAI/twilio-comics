"use client";

import Link from "next/link";
import { BookOpen, LogOut } from "lucide-react";
import { signOut, useSession } from "next-auth/react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

interface AccountMenuProps {
  className?: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
}

export function AccountMenu({
  className,
  side = "bottom",
  align = "end",
}: AccountMenuProps) {
  const { data: session } = useSession();

  if (!session?.user) {
    return null;
  }

  const fallback =
    session.user.name
      ?.split(" ")
      .map((part) => part[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || session.user.email?.[0]?.toUpperCase() || "U";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Open account menu"
          className={cn(
            "flex size-10 items-center justify-center rounded-md glass-panel glass-panel-hover",
            className
          )}
        >
          <Avatar className="size-8 rounded-md">
            {session.user.image && (
              <AvatarImage
                src={session.user.image}
                alt={session.user.name ?? "Account"}
                className="rounded-md"
                referrerPolicy="no-referrer"
              />
            )}
            <AvatarFallback className="rounded-md text-xs">
              {fallback}
            </AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={align} className="w-56">
        <DropdownMenuLabel className="font-normal">
          <div className="flex flex-col gap-0.5">
            {session.user.name && (
              <span className="truncate font-medium">{session.user.name}</span>
            )}
            {session.user.email && (
              <span className="truncate text-xs text-muted-foreground">
                {session.user.email}
              </span>
            )}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/stories">
            <BookOpen />
            My Stories
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => void signOut({ redirectTo: "/" })}
        >
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
