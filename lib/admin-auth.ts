import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";

const SCRYPT_COST = 32_768;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELISM = 1;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const HASH_LENGTH = 64;
const SALT_LENGTH = 32;
const MAX_FAILED_LOGINS = 5;
const MAX_UNKNOWN_FAILED_LOGINS = 50;
const ROTATION_ATTEMPT_KEY = "admin:credential-rotation";
export const ADMIN_SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000;

const credentialSchema = z.object({
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(1024),
});

const rotationSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newUsername: z.string().regex(/^[A-Za-z0-9._-]{3,64}$/),
  newPassword: z.string().min(1).max(1024)
    .refine((password) => password.trim().length > 0 &&
      !/[\p{C}\p{Zl}\p{Zp}]/u.test(password)),
});

type AdminUser = {
  id: string;
  name: string;
  role: "admin";
  adminCredentialVersion: string;
};

type ActiveAdminCredentials = { username: string; passwordHash: string; fromDatabase: boolean };

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows?: T[] }).rows ?? (result as T[]);
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, HASH_LENGTH, {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELISM,
      maxmem: SCRYPT_MAX_MEMORY,
    }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** Create a salt per password. Persist only the encoded hash. */
export async function hashAdminPassword(password: string): Promise<string> {
  if (password.length < 1 || password.length > 1024) {
    throw new Error("Administrator password must be 1 to 1024 characters");
  }
  const salt = randomBytes(SALT_LENGTH);
  const key = await deriveKey(password, salt);
  return [
    "scrypt", SCRYPT_COST, SCRYPT_BLOCK_SIZE, SCRYPT_PARALLELISM,
    salt.toString("base64url"), key.toString("base64url"),
  ].join("$");
}

export async function verifyAdminPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  const parts = encodedHash.split("$");
  if (
    parts.length !== 6 ||
    parts[0] !== "scrypt" ||
    parts[1] !== String(SCRYPT_COST) ||
    parts[2] !== String(SCRYPT_BLOCK_SIZE) ||
    parts[3] !== String(SCRYPT_PARALLELISM)
  ) return false;

  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  if (salt.length !== SALT_LENGTH || expected.length !== HASH_LENGTH) return false;

  const actual = await deriveKey(password, salt);
  return timingSafeEqual(actual, expected);
}

function normalizedUsername(username: string): string {
  return username.trim().toLocaleLowerCase("en-US");
}

function usernameMatches(input: string, configured: string): boolean {
  const inputDigest = createHash("sha256").update(normalizedUsername(input)).digest();
  const configuredDigest = createHash("sha256").update(normalizedUsername(configured)).digest();
  return timingSafeEqual(inputDigest, configuredDigest);
}

function trustedSourceId(request: Request | undefined): string | null {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;

  let source: string | undefined;
  if (process.env.CONTAINER_APP_NAME) {
    // ACA appends the actual sender to X-Forwarded-For. Earlier values can be
    // supplied by the caller and must not select a rate-limit bucket.
    const forwardedFor = request?.headers.get("x-forwarded-for") ?? "";
    source = forwardedFor.slice(forwardedFor.lastIndexOf(",") + 1).trim();
    if (!isIP(source)) return null;
  } else if (process.env.NODE_ENV !== "production") {
    // Development has no trusted proxy address in Auth.js's Request.
    source = "local-development";
  } else {
    // A production deployment without ACA needs an explicit trusted ingress
    // integration before admin password sign-in can be safely enabled.
    return null;
  }

  return createHmac("sha256", secret).update(source).digest("hex").slice(0, 32);
}

function accountAttemptKey(configuredUsername: string, sourceId: string): string {
  const accountId = createHash("sha256")
    .update(normalizedUsername(configuredUsername))
    .digest("hex")
    .slice(0, 16);
  return `admin:account:${accountId}:${sourceId}`;
}

async function reserveCredentialAttempt(key: string, limit: number): Promise<boolean> {
  // Reserve before password verification. PostgreSQL serializes upserts for this
  // key, so simultaneous requests cannot all pass an earlier blocked check.
  const result = await db.execute(sql`
    INSERT INTO admin_login_attempts
      (key, window_started_at, failed_count, blocked_until, updated_at)
    VALUES (${key}, NOW(), 1, NULL, NOW())
    ON CONFLICT (key) DO UPDATE SET
      window_started_at = CASE
        WHEN admin_login_attempts.blocked_until > NOW()
          THEN admin_login_attempts.window_started_at
        WHEN admin_login_attempts.window_started_at <= NOW() - INTERVAL '15 minutes'
          THEN NOW()
        ELSE admin_login_attempts.window_started_at
      END,
      failed_count = CASE
        WHEN admin_login_attempts.blocked_until > NOW()
          THEN ${limit + 1}
        WHEN admin_login_attempts.window_started_at <= NOW() - INTERVAL '15 minutes'
          THEN 1
        ELSE LEAST(admin_login_attempts.failed_count + 1, ${limit + 1})
      END,
      blocked_until = CASE
        WHEN admin_login_attempts.blocked_until > NOW()
          THEN admin_login_attempts.blocked_until
        WHEN admin_login_attempts.window_started_at <= NOW() - INTERVAL '15 minutes'
          THEN NULL
        WHEN admin_login_attempts.failed_count + 1 >= ${limit}
          THEN NOW() + INTERVAL '15 minutes'
        ELSE NULL
      END,
      updated_at = NOW()
    RETURNING failed_count
  `);
  const count = rowsOf<{ failed_count: number }>(result)[0]?.failed_count;
  return typeof count === "number" && Number.isInteger(count) && count >= 1 && count <= limit;
}

async function clearFailedLogins(key: string): Promise<void> {
  await db.execute(sql`DELETE FROM admin_login_attempts WHERE key = ${key}`);
}

/** A database row is authoritative once created, even if Azure env secrets change. */
async function getActiveAdminCredentials(): Promise<ActiveAdminCredentials | null> {
  const result = await db.execute(sql`
    SELECT username, password_hash
    FROM admin_credentials
    WHERE id = 1
    LIMIT 1
  `);
  const row = rowsOf<{ username: string; password_hash: string }>(result)[0];
  if (row) {
    return {
      username: row.username,
      passwordHash: row.password_hash,
      fromDatabase: true,
    };
  }

  const username = process.env.ADMIN_USERNAME?.trim();
  const passwordHash = process.env.ADMIN_PASSWORD_HASH?.trim();
  return username && passwordHash
    ? { username, passwordHash, fromDatabase: false }
    : null;
}

/** Called on each admin JWT use; no cache so rotation invalidates all replicas. */
export async function getActiveAdminPasswordHash(): Promise<string | null> {
  return (await getActiveAdminCredentials())?.passwordHash ?? null;
}

export type RotateAdminCredentialsResult =
  | { ok: true }
  | { ok: false; reason: "invalid-current" | "rate-limited" | "conflict" | "invalid-input" | "password-reused" };

/** The admin server action checks the signed session before calling this. */
export async function rotateAdminCredentials(
  input: { currentPassword: string; newUsername: string; newPassword: string },
): Promise<RotateAdminCredentialsResult> {
  const parsed = rotationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid-input" };
  if (!await reserveCredentialAttempt(ROTATION_ATTEMPT_KEY, MAX_FAILED_LOGINS)) {
    return { ok: false, reason: "rate-limited" };
  }

  const active = await getActiveAdminCredentials();
  if (!active || !await verifyAdminPassword(parsed.data.currentPassword, active.passwordHash)) {
    return { ok: false, reason: "invalid-current" };
  }

  await clearFailedLogins(ROTATION_ATTEMPT_KEY);
  if (parsed.data.newPassword === parsed.data.currentPassword) {
    return { ok: false, reason: "password-reused" };
  }
  const newHash = await hashAdminPassword(parsed.data.newPassword);
  const result = active.fromDatabase
    ? await db.execute(sql`
      UPDATE admin_credentials
      SET username = ${parsed.data.newUsername},
          password_hash = ${newHash},
          updated_at = NOW()
      WHERE id = 1
        AND username = ${active.username}
        AND password_hash = ${active.passwordHash}
      RETURNING id
    `)
    : await db.execute(sql`
      INSERT INTO admin_credentials (id, username, password_hash, created_at, updated_at)
      VALUES (1, ${parsed.data.newUsername}, ${newHash}, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `);

  if (rowsOf(result).length === 0) return { ok: false, reason: "conflict" };
  return { ok: true };
}

/** Credentials provider callback. No administrator row is stored in users. */
export async function authenticateAdminCredentials(
  credentials: unknown,
  request?: Request,
): Promise<AdminUser | null> {
  const parsed = credentialSchema.safeParse(credentials);
  if (!parsed.success) return null;

  const { username, password } = parsed.data;
  const sourceId = trustedSourceId(request);
  if (!sourceId) return null;
  const active = await getActiveAdminCredentials();
  if (!active) return null;
  const configuredUsername = active.username;
  const encodedHash = active.passwordHash;
  const usernameValid = usernameMatches(username, configuredUsername);
  const attemptKey = usernameValid
    ? accountAttemptKey(configuredUsername, sourceId)
    : `admin:unknown:${sourceId}`;
  if (!await reserveCredentialAttempt(
    attemptKey,
    usernameValid ? MAX_FAILED_LOGINS : MAX_UNKNOWN_FAILED_LOGINS,
  )) return null;

  const passwordValid = await verifyAdminPassword(password, encodedHash);
  if (!passwordValid || !usernameValid) return null;

  await clearFailedLogins(attemptKey);
  return {
    id: `admin:${createHash("sha256").update(normalizedUsername(configuredUsername)).digest("hex").slice(0, 32)}`,
    name: configuredUsername,
    role: "admin",
    adminCredentialVersion: adminCredentialVersion(encodedHash),
  };
}

export function adminCredentialVersion(encodedHash: string): string {
  return createHash("sha256").update(encodedHash).digest("hex");
}

/** Admin JWTs stop working after two hours or immediately after hash rotation. */
export function isAdminJwtFresh(
  issuedAt: number | undefined,
  version: string | undefined,
  configuredHash: string | undefined,
  now = Date.now(),
): boolean {
  if (
    !Number.isFinite(issuedAt) ||
    typeof issuedAt !== "number" ||
    issuedAt > now + 30_000 ||
    now - issuedAt >= ADMIN_SESSION_MAX_AGE_MS ||
    !version || !/^[a-f0-9]{64}$/.test(version) ||
    !configuredHash
  ) return false;
  const expected = Buffer.from(adminCredentialVersion(configuredHash), "hex");
  return timingSafeEqual(Buffer.from(version, "hex"), expected);
}

export function isAdminSession(
  session: { user?: { id?: string; role?: string } } | null,
): boolean {
  return session?.user?.role === "admin";
}
