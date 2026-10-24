import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const h = vi.hoisted(() => ({
  execute: vi.fn(),
  stored: null as null | { username: string; password_hash: string },
  failures: new Map<string, number>(),
  beforeWrite: null as null | (() => void),
  failClear: false,
}));

vi.mock("@/lib/db", () => ({ db: { execute: h.execute } }));

import {
  authenticateAdminCredentials,
  hashAdminPassword,
  rotateAdminCredentials,
} from "@/lib/admin-auth";

const dialect = new PgDialect();
const oldPassword = "an old and sufficiently long password";
const newPassword = "a new and sufficiently long password";
let oldHash: string;

function requestFrom(): Request {
  return new Request("https://comics.example/api/auth/callback/admin", {
    headers: { "x-forwarded-for": "203.0.113.42" },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  h.stored = null;
  h.failures.clear();
  h.beforeWrite = null;
  h.failClear = false;
  oldHash = await hashAdminPassword(oldPassword);
  vi.stubEnv("ADMIN_USERNAME", "old-admin");
  vi.stubEnv("ADMIN_PASSWORD_HASH", oldHash);
  vi.stubEnv("AUTH_SECRET", "stable-admin-test-secret");
  vi.stubEnv("CONTAINER_APP_NAME", "twilio-comics-web");
  h.execute.mockImplementation(async (query: SQL) => {
    const { sql, params } = dialect.sqlToQuery(query);
    if (sql.includes("FROM admin_credentials")) {
      return { rows: h.stored ? [{ ...h.stored }] : [] };
    }
    if (sql.includes("INSERT INTO admin_login_attempts")) {
      const key = String(params[0]);
      const limit = Number(params[3]);
      const count = Math.min((h.failures.get(key) ?? 0) + 1, limit + 1);
      h.failures.set(key, count);
      return { rows: [{ failed_count: count }] };
    }
    if (sql.includes("DELETE FROM admin_login_attempts")) {
      if (h.failClear) throw new Error("rate limit table unavailable");
      h.failures.delete(String(params[0]));
      return { rows: [] };
    }
    if (sql.includes("INSERT INTO admin_credentials")) {
      h.beforeWrite?.();
      if (h.stored) return { rows: [] };
      h.stored = { username: String(params[0]), password_hash: String(params[1]) };
      return { rows: [{ id: 1 }] };
    }
    if (sql.includes("UPDATE admin_credentials")) {
      h.beforeWrite?.();
      if (!h.stored || h.stored.username !== params[2] || h.stored.password_hash !== params[3]) {
        return { rows: [] };
      }
      h.stored = { username: String(params[0]), password_hash: String(params[1]) };
      return { rows: [{ id: 1 }] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
});

afterEach(() => vi.unstubAllEnvs());

describe("dashboard admin credential rotation", () => {
  it("uses the existing Azure credentials until the first database rotation", async () => {
    expect(await authenticateAdminCredentials({
      username: "old-admin", password: oldPassword,
    }, requestFrom())).toMatchObject({ name: "old-admin", role: "admin" });

    expect(await rotateAdminCredentials({
      currentPassword: oldPassword,
      newUsername: "new-admin",
      newPassword,
    })).toEqual({ ok: true });

    expect(h.stored?.username).toBe("new-admin");
    expect(await authenticateAdminCredentials({
      username: "old-admin", password: oldPassword,
    }, requestFrom())).toBeNull();
    expect(await authenticateAdminCredentials({
      username: "new-admin", password: newPassword,
    }, requestFrom())).toMatchObject({ name: "new-admin", role: "admin" });
  });

  it("continues using the database login after Azure secret values change or disappear", async () => {
    h.stored = {
      username: "db-admin",
      password_hash: await hashAdminPassword(newPassword),
    };
    vi.stubEnv("ADMIN_USERNAME", undefined);
    vi.stubEnv("ADMIN_PASSWORD_HASH", undefined);

    expect(await authenticateAdminCredentials({
      username: "db-admin", password: newPassword,
    }, requestFrom())).toMatchObject({ name: "db-admin", role: "admin" });
    expect(await rotateAdminCredentials({
      currentPassword: newPassword,
      newUsername: "second-admin",
      newPassword: "another sufficiently long private password",
    })).toEqual({ ok: true });
    expect(h.stored?.username).toBe("second-admin");
  });

  it("rejects a wrong current password without changing the stored login", async () => {
    expect(await rotateAdminCredentials({
      currentPassword: "incorrect-current-password",
      newUsername: "new-admin",
      newPassword,
    })).toEqual({ ok: false, reason: "invalid-current" });
    expect(h.stored).toBeNull();
  });

  it("rejects reusing the verified current password", async () => {
    expect(await rotateAdminCredentials({
      currentPassword: oldPassword,
      newUsername: "new-admin",
      newPassword: oldPassword,
    })).toEqual({ ok: false, reason: "password-reused" });
    expect(h.stored).toBeNull();
  });

  it("limits simultaneous wrong-password attempts before verifying more than five", async () => {
    const attempts = await Promise.all(Array.from({ length: 8 }, () =>
      rotateAdminCredentials({
        currentPassword: "incorrect-current-password",
        newUsername: "new-admin",
        newPassword,
      })));
    expect(attempts.filter((result) => !result.ok && result.reason === "invalid-current"))
      .toHaveLength(5);
    expect(attempts.filter((result) => !result.ok && result.reason === "rate-limited"))
      .toHaveLength(3);
    expect(h.stored).toBeNull();
  });

  it("blocks a sixth simultaneous login even when its password is correct", async () => {
    const wrong = Array.from({ length: 5 }, () =>
      authenticateAdminCredentials({
        username: "old-admin", password: "incorrect-current-password",
      }, requestFrom()));
    const correct = authenticateAdminCredentials({
      username: "old-admin", password: oldPassword,
    }, requestFrom());
    const results = await Promise.all([...wrong, correct]);
    expect(results[5]).toBeNull();
  });

  it("does not change credentials if clearing the rotation lockout fails", async () => {
    h.failClear = true;
    await expect(rotateAdminCredentials({
      currentPassword: oldPassword,
      newUsername: "new-admin",
      newPassword,
    })).rejects.toThrow("rate limit table unavailable");
    expect(h.stored).toBeNull();
  });

  it("accepts a long printable Unicode password", async () => {
    const unicodePassword = "漫画の管理者 passphrase 2026!";
    expect(await rotateAdminCredentials({
      currentPassword: oldPassword,
      newUsername: "new-admin",
      newPassword: unicodePassword,
    })).toEqual({ ok: true });
    expect(await authenticateAdminCredentials({
      username: "new-admin", password: unicodePassword,
    }, requestFrom())).toMatchObject({ name: "new-admin" });
  });

  it("rotates to a one-character punctuation password that can sign in", async () => {
    expect(await rotateAdminCredentials({
      currentPassword: oldPassword,
      newUsername: "new-admin",
      newPassword: "!",
    })).toEqual({ ok: true });
    expect(await authenticateAdminCredentials({
      username: "new-admin", password: "!",
    }, requestFrom())).toMatchObject({ name: "new-admin", role: "admin" });
  });

  it("locks out repeated wrong current passwords across requests", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await rotateAdminCredentials({
        currentPassword: "incorrect-current-password",
        newUsername: "new-admin",
        newPassword,
      })).toEqual({ ok: false, reason: "invalid-current" });
    }
    expect(await rotateAdminCredentials({
      currentPassword: oldPassword,
      newUsername: "new-admin",
      newPassword,
    })).toEqual({ ok: false, reason: "rate-limited" });
    expect(h.stored).toBeNull();
  });

  it.each([
    ["a", newPassword],
    ["bad username", newPassword],
    ["new-admin", ""],
    ["new-admin", "  "],
    ["new-admin", "a".repeat(1025)],
    ["new-admin", "a\npassword with a control character"],
    ["new-admin", "a\u2028password with a line separator"],
  ])("rejects an invalid new username or password before database access", async (newUsername, candidatePassword) => {
    expect(await rotateAdminCredentials({
      currentPassword: oldPassword,
      newUsername,
      newPassword: candidatePassword,
    })).toEqual({ ok: false, reason: "invalid-input" });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("does not overwrite a credential record inserted by a simultaneous rotation", async () => {
    const competingHash = await hashAdminPassword("competing administrator password");
    h.beforeWrite = () => {
      h.stored = { username: "competitor", password_hash: competingHash };
      h.beforeWrite = null;
    };
    expect(await rotateAdminCredentials({
      currentPassword: oldPassword,
      newUsername: "new-admin",
      newPassword,
    })).toEqual({ ok: false, reason: "conflict" });
    expect(h.stored?.username).toBe("competitor");
  });

  it("does not overwrite a credential record changed by a simultaneous rotation", async () => {
    h.stored = { username: "old-admin", password_hash: oldHash };
    const competingHash = await hashAdminPassword("competing administrator password");
    h.beforeWrite = () => {
      h.stored = { username: "competitor", password_hash: competingHash };
      h.beforeWrite = null;
    };
    expect(await rotateAdminCredentials({
      currentPassword: oldPassword,
      newUsername: "new-admin",
      newPassword,
    })).toEqual({ ok: false, reason: "conflict" });
    expect(h.stored?.username).toBe("competitor");
  });
});
