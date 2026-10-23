import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const h = vi.hoisted(() => ({
  execute: vi.fn(),
  attempts: new Map<string, number>(),
}));

vi.mock("@/lib/db", () => ({ db: { execute: h.execute } }));

import {
  adminCredentialVersion,
  authenticateAdminCredentials,
  hashAdminPassword,
  isAdminJwtFresh,
  isAdminSession,
  verifyAdminPassword,
} from "@/lib/admin-auth";

const dialect = new PgDialect();
const password = "a long private administrator password";
let encodedHash: string;

beforeEach(async () => {
  vi.clearAllMocks();
  encodedHash = await hashAdminPassword(password);
  vi.stubEnv("ADMIN_USERNAME", "operator");
  vi.stubEnv("ADMIN_PASSWORD_HASH", encodedHash);
  vi.stubEnv("AUTH_SECRET", "stable-admin-test-secret");
  vi.stubEnv("CONTAINER_APP_NAME", "twilio-comics-web");
  h.attempts.clear();
  h.execute.mockImplementation(async (query: SQL) => {
    const statement = dialect.sqlToQuery(query);
    if (statement.sql.includes("INSERT INTO admin_login_attempts")) {
      const key = String(statement.params[0]);
      const limit = Number(statement.params[3]);
      const count = Math.min((h.attempts.get(key) ?? 0) + 1, limit + 1);
      h.attempts.set(key, count);
      return { rows: [{ failed_count: count }] };
    }
    if (statement.sql.includes("DELETE FROM admin_login_attempts")) {
      h.attempts.delete(String(statement.params[0]));
    }
    return { rows: [] };
  });
});

afterEach(() => vi.unstubAllEnvs());

function statements(): Array<{ sql: string; params: unknown[] }> {
  return h.execute.mock.calls.map((args: unknown[]) => dialect.sqlToQuery(args[0] as SQL));
}

function requestFrom(forwardedFor = "203.0.113.42"): Request {
  return new Request("https://comics.example/api/auth/callback/admin", {
    headers: { "x-forwarded-for": forwardedFor },
  });
}

function failedAttemptKeys(): string[] {
  return statements()
    .filter((statement) => statement.sql.includes("INSERT INTO admin_login_attempts"))
    .map((statement) => statement.params[0] as string);
}

describe("administrator password", () => {
  it("uses a fresh salt and accepts only the original password", async () => {
    const secondHash = await hashAdminPassword(password);
    expect(secondHash).not.toBe(encodedHash);
    await expect(verifyAdminPassword(password, encodedHash)).resolves.toBe(true);
    await expect(verifyAdminPassword("a different password", encodedHash)).resolves.toBe(false);
  });

  it("fails closed for malformed and missing hashes", async () => {
    await expect(verifyAdminPassword(password, "scrypt$broken")).resolves.toBe(false);
    await expect(verifyAdminPassword(password, "")).resolves.toBe(false);
  });
});

describe("administrator sign in", () => {
  it("accepts a verified username and password and clears prior failures", async () => {
    await expect(authenticateAdminCredentials({
      username: "operator",
      password,
    }, requestFrom())).resolves.toMatchObject({ name: "operator", role: "admin" });

    const sql = statements();
    expect(sql).toHaveLength(3);
    expect(sql[0].sql).toContain("admin_credentials");
    expect(sql[1].sql).toContain("INSERT INTO admin_login_attempts");
    expect(sql[1].sql).toContain("ON CONFLICT");
    expect(sql[2].sql).toContain("DELETE FROM admin_login_attempts");
  });

  it("reserves failed password attempts with an atomic database upsert", async () => {
    await expect(authenticateAdminCredentials({
      username: "operator",
      password: "wrong password",
    }, requestFrom())).resolves.toBeNull();

    const sql = statements();
    expect(sql).toHaveLength(2);
    expect(sql[1].sql).toContain("ON CONFLICT");
    expect(sql[1].sql).toContain("failed_count");
    expect(sql[1].sql).toContain("blocked_until");
  });

  it("uses the Azure-provided rightmost IP despite spoofed earlier addresses", async () => {
    for (const [username, forwardedFor] of [
      ["stranger-a", "198.51.100.10, 203.0.113.42"],
      ["stranger-b", "198.51.100.11, 203.0.113.42"],
      ["stranger-c", "198.51.100.11, 203.0.113.43"],
    ]) {
      await expect(authenticateAdminCredentials({
        username,
        password: "wrong password",
      }, requestFrom(forwardedFor))).resolves.toBeNull();
    }

    const keys = failedAttemptKeys();
    expect(keys).toHaveLength(3);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
    expect(keys.every((key) => key.startsWith("admin:unknown:"))).toBe(true);
  });

  it("lets the operator sign in when unknown usernames are blocked at the same IP", async () => {
    await authenticateAdminCredentials({ username: "stranger", password: "wrong password" }, requestFrom());
    const [unknownSourceKey] = failedAttemptKeys();
    h.attempts.set(unknownSourceKey, 50);

    await expect(authenticateAdminCredentials({
      username: "operator",
      password,
    }, requestFrom())).resolves.toMatchObject({ name: "operator", role: "admin" });
  });

  it("isolates known-account lockouts by source IP", async () => {
    await authenticateAdminCredentials({ username: "operator", password: "wrong password" }, requestFrom());
    const [blockedAccountKey] = failedAttemptKeys();
    h.attempts.set(blockedAccountKey, 5);

    await expect(authenticateAdminCredentials({ username: "operator", password }, requestFrom()))
      .resolves.toBeNull();
    await expect(authenticateAdminCredentials({ username: "operator", password }, requestFrom("203.0.113.43")))
      .resolves.toMatchObject({ name: "operator", role: "admin" });
  });

  it("fails closed if Azure ingress omits a valid rightmost source IP", async () => {
    await expect(authenticateAdminCredentials({ username: "operator", password },
      new Request("https://comics.example/api/auth/callback/admin"))).resolves.toBeNull();
    await expect(authenticateAdminCredentials({ username: "operator", password },
      requestFrom("203.0.113.42, not-an-ip"))).resolves.toBeNull();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("never signs in when credentials are not configured", async () => {
    vi.stubEnv("ADMIN_PASSWORD_HASH", undefined);
    await expect(authenticateAdminCredentials({
      username: "operator",
      password,
    }, requestFrom())).resolves.toBeNull();
    expect(statements().map((statement) => statement.sql)).toEqual([
      expect.stringContaining("FROM admin_credentials"),
    ]);
  });
});

describe("administrator session boundary", () => {
  it("expires after two hours and when the configured password changes", () => {
    const now = 1_800_000_000_000;
    const issuedAt = now - 30_000;
    const version = adminCredentialVersion(encodedHash);
    expect(isAdminJwtFresh(issuedAt, version, encodedHash, now)).toBe(true);
    expect(isAdminJwtFresh(now - 2 * 60 * 60 * 1000, version, encodedHash, now)).toBe(false);
    expect(isAdminJwtFresh(issuedAt, version, "rotated hash", now)).toBe(false);
  });

  it("does not treat a Google session as an administrator", () => {
    expect(isAdminSession({ user: { id: "google-user", role: "user" } })).toBe(false);
    expect(isAdminSession({ user: { id: "", role: "admin" } })).toBe(true);
    expect(isAdminSession(null)).toBe(false);
  });
});
