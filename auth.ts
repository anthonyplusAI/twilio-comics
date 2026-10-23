import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import authConfig, {
  isStudioTesterEmailAllowed,
  verifiedGoogleEmail,
} from "@/auth.config";
import {
  authenticateAdminCredentials,
  getActiveAdminPasswordHash,
  isAdminJwtFresh,
} from "@/lib/admin-auth";
import { db } from "@/lib/db";
import {
  accounts,
  sessions,
  users,
  verificationTokens,
} from "@/lib/schema";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    ...authConfig.providers,
    Credentials({
      id: "admin",
      name: "Administrator",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      authorize: authenticateAdminCredentials,
    }),
  ],
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: { strategy: "jwt" },
  callbacks: {
    ...authConfig.callbacks,
    async jwt({ token, user, account, profile }) {
      if (user) {
        token.id = user.id;
        if (account?.provider === "admin" && user.role === "admin") {
          token.role = "admin";
          delete token.studioEmail;
          token.adminIssuedAt = Date.now();
          token.adminCredentialVersion = user.adminCredentialVersion;
        } else {
          token.role = "user";
          token.studioEmail = account?.provider === "google"
            ? verifiedGoogleEmail(profile)
            : null;
          delete token.adminIssuedAt;
          delete token.adminCredentialVersion;
        }
      }
      if (token.role === "admin") {
        try {
          if (!isAdminJwtFresh(
            typeof token.adminIssuedAt === "number" ? token.adminIssuedAt : undefined,
            typeof token.adminCredentialVersion === "string"
              ? token.adminCredentialVersion
              : undefined,
            await getActiveAdminPasswordHash() ?? undefined,
          )) return null;
        } catch {
          // Session verification must fail closed when PostgreSQL is unavailable.
          return null;
        }
      }
      if (process.env.NODE_ENV === "production" && token.role !== "admin" &&
        !isStudioTesterEmailAllowed(
          typeof token.studioEmail === "string" ? token.studioEmail : null,
          process.env.STUDIO_TESTER_EMAILS,
        )) {
        return null;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.role = token.role === "admin" ? "admin" : "user";
        // Browser creation APIs check for a user ID. Admin sessions have a
        // signed role claim but no browser-studio identity.
        if (token.role === "admin") {
          session.user.id = "";
        } else {
          const userId = typeof token.id === "string" ? token.id : token.sub;
          session.user.id = userId ?? "";
        }
      }
      return session;
    },
  },
});
