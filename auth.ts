import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import authConfig, {
  isStudioTesterEmailAllowed,
  verifiedGoogleEmail,
  verifiedTwilioGoogleEmail,
} from "@/auth.config";
import {
  ADMIN_SESSION_MAX_AGE_MS,
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

function isGoogleAdminJwtFresh(
  issuedAt: unknown,
  email: unknown,
  hostedDomain: unknown,
  studioEmail: unknown,
  now = Date.now(),
): boolean {
  return typeof issuedAt === "number" && Number.isFinite(issuedAt) &&
    issuedAt <= now + 30_000 && now - issuedAt < ADMIN_SESSION_MAX_AGE_MS &&
    email === studioEmail &&
    verifiedTwilioGoogleEmail({
      email,
      email_verified: true,
      hd: hostedDomain,
    }) !== null;
}

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
          token.adminAuthMethod = "password";
          delete token.studioEmail;
          token.adminIssuedAt = Date.now();
          token.adminCredentialVersion = user.adminCredentialVersion;
          delete token.adminGoogleEmail;
          delete token.adminGoogleHostedDomain;
        } else {
          const googleEmail = account?.provider === "google"
            ? verifiedGoogleEmail(profile)
            : null;
          const googleAdminEmail = account?.provider === "google"
            ? verifiedTwilioGoogleEmail(profile)
            : null;
          token.studioEmail = googleEmail;
          token.role = googleAdminEmail ? "admin" : "user";
          if (googleAdminEmail) {
            token.adminAuthMethod = "google";
            token.adminIssuedAt = Date.now();
            token.adminGoogleEmail = googleAdminEmail;
            token.adminGoogleHostedDomain = "twilio.com";
          } else {
            delete token.adminAuthMethod;
            delete token.adminIssuedAt;
            delete token.adminGoogleEmail;
            delete token.adminGoogleHostedDomain;
          }
          delete token.adminCredentialVersion;
        }
      }
      if (token.role === "admin") {
        if (token.adminAuthMethod === "google") {
          if (!isGoogleAdminJwtFresh(
            token.adminIssuedAt,
            token.adminGoogleEmail,
            token.adminGoogleHostedDomain,
            token.studioEmail,
          )) return null;
        } else if (token.adminAuthMethod === "password" ||
          (!token.adminAuthMethod && typeof token.adminCredentialVersion === "string")) {
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
        } else {
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
        const studioEmail = typeof token.studioEmail === "string" ? token.studioEmail : null;
        const approvedGoogleAdmin = token.role === "admin" &&
          token.adminAuthMethod === "google" &&
          isGoogleAdminJwtFresh(
            token.adminIssuedAt,
            token.adminGoogleEmail,
            token.adminGoogleHostedDomain,
            studioEmail,
          ) &&
          isStudioTesterEmailAllowed(studioEmail, process.env.STUDIO_TESTER_EMAILS);
        const approvedGoogleUser = token.role !== "admin" && Boolean(studioEmail) &&
          (process.env.NODE_ENV !== "production" ||
            isStudioTesterEmailAllowed(studioEmail, process.env.STUDIO_TESTER_EMAILS));
        // Only a signed Google Studio identity can use the browser composer.
        // Password admin sessions remain admin-only, even with a user ID claim.
        if (token.role === "admin" && !approvedGoogleAdmin) {
          session.user.id = "";
        } else {
          const userId = typeof token.id === "string" ? token.id : token.sub;
          session.user.id = userId ?? "";
        }
        session.user.studioAuthorized = Boolean(session.user.id &&
          (approvedGoogleAdmin || approvedGoogleUser));
      }
      return session;
    },
  },
});
