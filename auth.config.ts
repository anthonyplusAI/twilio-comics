import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";

export default {
  providers: [Google],
  callbacks: {
    signIn({ account, profile }) {
      return (
        account?.provider === "google" && profile?.email_verified === true
      );
    },
  },
} satisfies NextAuthConfig;
