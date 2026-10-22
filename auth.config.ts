import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";

export function verifiedGoogleEmail(
  profile: { email?: unknown; email_verified?: unknown } | undefined,
): string | null {
  if (profile?.email_verified !== true || typeof profile.email !== "string") {
    return null;
  }
  return profile.email.trim().toLowerCase() || null;
}

export function isStudioTesterEmailAllowed(
  email: string | null,
  rawAllowlist: string | undefined,
): boolean {
  if (!email) return false;
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) return false;
  return rawAllowlist?.split(",").some((value) => value.trim().toLowerCase() === normalizedEmail)
    ?? false;
}

export function configuredGoogleProviders(
  clientId: string | undefined,
  clientSecret: string | undefined,
) {
  return clientId && clientSecret
    ? [Google({ clientId, clientSecret })]
    : [];
}

export default {
  providers: configuredGoogleProviders(
    process.env.AUTH_GOOGLE_ID,
    process.env.AUTH_GOOGLE_SECRET,
  ),
  callbacks: {
    signIn({ account, profile, user }) {
      if (account?.provider === "admin") {
        return user.role === "admin" && user.id?.startsWith("admin:") === true;
      }
      if (account?.provider !== "google") return false;
      const email = verifiedGoogleEmail(profile);
      return email !== null && (
        process.env.NODE_ENV !== "production"
        || isStudioTesterEmailAllowed(email, process.env.STUDIO_TESTER_EMAILS)
      );
    },
  },
} satisfies NextAuthConfig;
