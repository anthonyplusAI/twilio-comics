import NextAuth from "next-auth";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import authConfig from "@/auth.config";
import { db } from "@/lib/db";
import {
  accounts,
  sessions,
  users,
  verificationTokens,
} from "@/lib/schema";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: { strategy: "jwt" },
  callbacks: {
    ...authConfig.callbacks,
    jwt({ token, user }) {
      if (user) {
        token.id = user.id;
      }
      return token;
    },
    session({ session, token }) {
      const userId = typeof token.id === "string" ? token.id : token.sub;
      if (session.user && userId) {
        session.user.id = userId;
      }
      return session;
    },
  },
});
