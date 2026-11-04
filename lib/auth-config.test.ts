import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  execute: vi.fn(),
}));

vi.mock("next-auth", () => ({
  default: (config: Record<string, unknown>) => {
    h.config = config;
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  },
}));
vi.mock("@auth/drizzle-adapter", () => ({ DrizzleAdapter: () => ({}) }));
vi.mock("@/lib/db", () => ({ db: { execute: h.execute } }));

import "@/auth";
import { configuredGoogleProviders } from "@/auth.config";
import { adminCredentialVersion, ADMIN_SESSION_MAX_AGE_MS } from "@/lib/admin-auth";

type AuthCallbacks = {
  jwt: (input: Record<string, unknown>) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
  session: (input: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
  signIn: (input: Record<string, unknown>) => Promise<boolean> | boolean;
};

function callbacks(): AuthCallbacks {
  return (h.config as { callbacks: AuthCallbacks }).callbacks;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  h.execute.mockReset();
});

// No database rotation yet: the existing Azure secret remains the initial login.
beforeEach(() => {
  vi.stubEnv("ADMIN_USERNAME", "operator");
  h.execute.mockResolvedValue({ rows: [] });
});

describe("administrator Auth.js role", () => {
  it("keeps Google sign-in unavailable until both OAuth values are configured", () => {
    expect(configuredGoogleProviders(undefined, "secret")).toEqual([]);
    expect(configuredGoogleProviders("client-id", undefined)).toEqual([]);
    expect(configuredGoogleProviders("client-id", "secret")).toHaveLength(1);
  });

  it("issues an admin claim only for a verified Credentials user", async () => {
    vi.stubEnv("ADMIN_PASSWORD_HASH", "scrypt$test-version");
    const cb = callbacks();
    const token = await cb.jwt({
      token: { sub: "admin:operator" },
      user: {
        id: "admin:operator",
        name: "operator",
        role: "admin",
        adminCredentialVersion: adminCredentialVersion("scrypt$test-version"),
      },
      account: { provider: "admin" },
    });

    expect(token).toMatchObject({
      role: "admin",
      adminCredentialVersion: adminCredentialVersion("scrypt$test-version"),
    });
    const session = await cb.session({
      session: { user: { id: "prior", name: "operator" }, expires: "tomorrow" },
      token,
    });
    expect(session.user).toMatchObject({ role: "admin", id: "", studioAuthorized: false });
  });

  it("does not promote an OAuth user that carries an admin-looking field", async () => {
    const token = await callbacks().jwt({
      token: { sub: "google-user" },
      user: { id: "google-user", role: "admin" },
      account: { provider: "google" },
    });
    expect(token).toMatchObject({ role: "user", id: "google-user" });
  });

  it("issues a two-hour admin session for a verified Twilio Workspace account without requiring the admin password", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("STUDIO_TESTER_EMAILS", undefined);
    vi.stubEnv("ADMIN_PASSWORD_HASH", undefined);
    const cb = callbacks();
    const now = new Date("2026-10-21T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const token = await cb.jwt({
      token: { sub: "db-google-user" },
      user: { id: "db-google-user", email: "alice@twilio.com" },
      account: { provider: "google" },
      profile: { email: "Alice@Twilio.com", email_verified: true, hd: "twilio.com", sub: "google-sub" },
    });

    expect(token).toMatchObject({
      role: "admin",
      adminAuthMethod: "google",
      adminGoogleEmail: "alice@twilio.com",
      adminGoogleHostedDomain: "twilio.com",
      adminIssuedAt: now.getTime(),
    });
    expect(await cb.jwt({ token })).toMatchObject({ role: "admin" });
    const session = await cb.session({
      session: { user: { id: "prior", name: "Alice" }, expires: "tomorrow" },
      token,
    });
    expect(session.user).toMatchObject({ role: "admin", id: "" });

    vi.setSystemTime(now.getTime() + ADMIN_SESSION_MAX_AGE_MS);
    expect(await cb.jwt({ token })).toBeNull();
  });

  it("does not promote Google profiles that lack verified Twilio Workspace claims", async () => {
    const cb = callbacks();
    for (const profile of [
      { email: "alice@twilio.com", email_verified: false, hd: "twilio.com" },
      { email: "alice@twilio.com", email_verified: true },
      { email: "alice@twilio.com", email_verified: true, hd: "other.com" },
      { email: "alice@twilio.com.evil.com", email_verified: true, hd: "twilio.com" },
    ]) {
      const token = await cb.jwt({
        token: { sub: "db-google-user" },
        user: { id: "db-google-user", role: "admin" },
        account: { provider: "google" },
        profile,
      });
      expect(token).toMatchObject({ role: "user" });
    }
  });

  it("rejects altered Google admin claims and leaves password rotation independent", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("STUDIO_TESTER_EMAILS", undefined);
    const cb = callbacks();
    const issued = await cb.jwt({
      token: { sub: "db-google-user" },
      user: { id: "db-google-user" },
      account: { provider: "google" },
      profile: { email: "alice@twilio.com", email_verified: true, hd: "twilio.com" },
    });
    expect(issued).toMatchObject({ role: "admin" });
    expect(await cb.jwt({ token: { ...issued, adminGoogleHostedDomain: "other.com" } })).toBeNull();
    expect(await cb.jwt({ token: { ...issued, adminGoogleEmail: "alice@twilio.com.evil.com" } })).toBeNull();

    h.execute.mockRejectedValue(new Error("password database unavailable"));
    expect(await cb.jwt({ token: issued })).toMatchObject({ role: "admin" });
  });

  it("preserves Studio access only for a Twilio admin who is also allowlisted as a Studio tester", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("STUDIO_TESTER_EMAILS", "alice@twilio.com");
    const cb = callbacks();
    const token = await cb.jwt({
      token: { sub: "db-google-user" },
      user: { id: "db-google-user" },
      account: { provider: "google" },
      profile: { email: "alice@twilio.com", email_verified: true, hd: "twilio.com" },
    });
    const sessionFor = () => cb.session({
      session: { user: { id: "prior" }, expires: "tomorrow" },
      token,
    });

    expect((await sessionFor()).user).toMatchObject({ role: "admin", id: "db-google-user", studioAuthorized: true });
    vi.stubEnv("STUDIO_TESTER_EMAILS", "someone-else@example.com");
    expect((await sessionFor()).user).toMatchObject({ role: "admin", id: "", studioAuthorized: false });
  });

  it("rejects expired admin claims and claims signed before password rotation", async () => {
    vi.stubEnv("ADMIN_PASSWORD_HASH", "new-password-hash");
    const now = new Date("2026-10-21T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const cb = callbacks();

    expect(await cb.jwt({ token: {
      role: "admin",
      adminIssuedAt: now.getTime() - ADMIN_SESSION_MAX_AGE_MS,
      adminCredentialVersion: adminCredentialVersion("new-password-hash"),
    } })).toBeNull();
    expect(await cb.jwt({ token: {
      role: "admin",
      adminIssuedAt: now.getTime() - 10_000,
      adminCredentialVersion: adminCredentialVersion("old-password-hash"),
    } })).toBeNull();
  });

  it("invalidates every replica's existing password admin session after a dashboard rotation", async () => {
    const firstHash = "scrypt$initial-version";
    const rotatedHash = "scrypt$database-version";
    vi.stubEnv("ADMIN_PASSWORD_HASH", firstHash);
    h.execute.mockResolvedValue({ rows: [] });

    const cb = callbacks();
    const issued = await cb.jwt({
      token: { sub: "admin:operator" },
      user: {
        id: "admin:operator",
        name: "operator",
        role: "admin",
        adminCredentialVersion: adminCredentialVersion(firstHash),
      },
      account: { provider: "admin" },
    });
    expect(issued).toMatchObject({ role: "admin" });

    h.execute.mockResolvedValue({ rows: [{
      username: "new-admin", password_hash: rotatedHash,
    }] });
    expect(await cb.jwt({ token: issued })).toBeNull();

    const newToken = await cb.jwt({
      token: { sub: "admin:new-admin" },
      user: {
        id: "admin:new-admin",
        name: "new-admin",
        role: "admin",
        adminCredentialVersion: adminCredentialVersion(rotatedHash),
      },
      account: { provider: "admin" },
    });
    expect(newToken).toMatchObject({ role: "admin" });
  });

  it("fails closed when PostgreSQL cannot verify the active admin credentials", async () => {
    vi.stubEnv("ADMIN_PASSWORD_HASH", "scrypt$initial-version");
    h.execute.mockRejectedValue(new Error("database unavailable"));
    const token = await callbacks().jwt({ token: {
      role: "admin",
      adminIssuedAt: Date.now() - 1_000,
      adminCredentialVersion: adminCredentialVersion("scrypt$initial-version"),
    } });
    expect(token).toBeNull();
  });

  it("accepts Google only with a verified email, and admin only through Credentials", async () => {
    const cb = callbacks();
    expect(await cb.signIn({
      account: { provider: "google" },
      profile: { email: "local@example.com", email_verified: true },
      user: { id: "google-user" },
    })).toBe(true);
    expect(await cb.signIn({
      account: { provider: "google" },
      profile: { email: "local@example.com", email_verified: false },
      user: { id: "google-user" },
    })).toBe(false);
    expect(await cb.signIn({
      account: { provider: "admin" },
      user: { id: "admin:operator", role: "admin" },
    })).toBe(true);
    expect(await cb.signIn({
      account: { provider: "admin" },
      user: { id: "admin:operator", role: "user" },
    })).toBe(false);
  });

  it("requires an exact verified tester email for production Google sign-in", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const cb = callbacks();
    const googleSignIn = (email: string, verified = true) => cb.signIn({
      account: { provider: "google" },
      profile: { email, email_verified: verified },
      user: { id: "google-user", email },
    });

    vi.stubEnv("STUDIO_TESTER_EMAILS", undefined);
    expect(await googleSignIn("tester@example.com")).toBe(false);

    vi.stubEnv("STUDIO_TESTER_EMAILS", " first@example.com, TESTER@EXAMPLE.COM ");
    expect(await googleSignIn("tester@example.com")).toBe(true);
    expect(await googleSignIn("other@example.com")).toBe(false);
    expect(await googleSignIn("tester@example.com.evil.com")).toBe(false);
    expect(await googleSignIn("tester@example.com", false)).toBe(false);
    expect(await cb.signIn({
      account: { provider: "admin" },
      user: { id: "admin:operator", role: "admin" },
    })).toBe(true);
  });

  it("admits only verified Twilio Workspace identities to admin Google sign-in", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("STUDIO_TESTER_EMAILS", undefined);
    const cb = callbacks();
    const googleSignIn = (profile: Record<string, unknown>) => cb.signIn({
      account: { provider: "google" },
      profile,
      user: { id: "google-user" },
    });

    expect(await googleSignIn({
      email: "Alice@Twilio.com", email_verified: true, hd: "twilio.com",
    })).toBe(true);
    expect(await googleSignIn({
      email: "alice@twilio.com", email_verified: false, hd: "twilio.com",
    })).toBe(false);
    expect(await googleSignIn({
      email: "alice@twilio.com", email_verified: true,
    })).toBe(false);
    expect(await googleSignIn({
      email: "alice@twilio.com", email_verified: true, hd: "other.com",
    })).toBe(false);
    expect(await googleSignIn({
      email: "alice@twilio.com.evil.com", email_verified: true, hd: "twilio.com",
    })).toBe(false);
    expect(await googleSignIn({
      email: "@twilio.com", email_verified: true, hd: "twilio.com",
    })).toBe(false);
  });

  it("invalidates production Google sessions when the tester allowlist changes", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("STUDIO_TESTER_EMAILS", "tester@example.com");
    const cb = callbacks();
    const token = await cb.jwt({
      token: { sub: "google-user", email: "tester@example.com" },
      user: { id: "google-user", email: "tester@example.com" },
      account: { provider: "google" },
      profile: { email: "TESTER@EXAMPLE.COM", email_verified: true },
    });

    expect(token).toMatchObject({ role: "user", studioEmail: "tester@example.com" });
    expect(await cb.jwt({ token })).toMatchObject({ role: "user" });
    const session = await cb.session({
      session: { user: { id: "prior" }, expires: "tomorrow" },
      token,
    });
    expect(session.user).toMatchObject({ id: "google-user", studioAuthorized: true });

    vi.stubEnv("STUDIO_TESTER_EMAILS", "someone-else@example.com");
    expect(await cb.jwt({ token })).toBeNull();
    expect(await cb.jwt({ token: { sub: "prior-login", role: "user", email: "tester@example.com" } }))
      .toBeNull();

    vi.stubEnv("STUDIO_TESTER_EMAILS", " , ");
    expect(await cb.jwt({ token: { sub: "malformed-login", role: "user", studioEmail: " " } }))
      .toBeNull();
  });
});
