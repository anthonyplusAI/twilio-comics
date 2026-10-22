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
export const ADMIN_SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000;

const credentialSchema = z.object({
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(1024),
});

type AdminUser = { id: string; name: string; role: "admin" };

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

/** Create a salt per password. Store the encoded value as ADMIN_PASSWORD_HASH. */
export async function hashAdminPassword(password: string): Promise<string> {
  if (password.length < 16 || password.length > 1024) {
    throw new Error("Administrator password must be 16 to 1024 characters");
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

async function loginIsBlocked(key: string): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT blocked_until
    FROM admin_login_attempts
    WHERE key = ${key} AND blocked_until > NOW()
    LIMIT 1
  `);
  return rowsOf(result).length > 0;
}

async function recordFailedLogin(key: string, limit: number): Promise<void> {
  // The conflict update serializes failed attempts across every ACA replica.
  await db.execute(sql`
    INSERT INTO admin_login_attempts
      (key, window_started_at, failed_count, blocked_until, updated_at)
    VALUES (${key}, NOW(), 1, NULL, NOW())
    ON CONFLICT (key) DO UPDATE SET
      window_started_at = CASE
        WHEN admin_login_attempts.window_started_at <= NOW() - INTERVAL '15 minutes'
          THEN NOW()
        ELSE admin_login_attempts.window_started_at
      END,
      failed_count = CASE
        WHEN admin_login_attempts.window_started_at <= NOW() - INTERVAL '15 minutes'
          THEN 1
        ELSE admin_login_attempts.failed_count + 1
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
  `);
}

async function clearFailedLogins(key: string): Promise<void> {
  await db.execute(sql`DELETE FROM admin_login_attempts WHERE key = ${key}`);
}

/** Credentials provider callback. No administrator row is stored in users. */
export async function authenticateAdminCredentials(
  credentials: unknown,
  request?: Request,
): Promise<AdminUser | null> {
  const parsed = credentialSchema.safeParse(credentials);
  const configuredUsername = process.env.ADMIN_USERNAME?.trim();
  const encodedHash = process.env.ADMIN_PASSWORD_HASH?.trim();
  if (!parsed.success || !configuredUsername || !encodedHash) return null;

  const { username, password } = parsed.data;
  const sourceId = trustedSourceId(request);
  if (!sourceId) return null;
  const usernameValid = usernameMatches(username, configuredUsername);
  const attemptKey = usernameValid
    ? accountAttemptKey(configuredUsername, sourceId)
    : `admin:unknown:${sourceId}`;
  if (await loginIsBlocked(attemptKey)) return null;

  const passwordValid = await verifyAdminPassword(password, encodedHash);
  if (!passwordValid || !usernameValid) {
    await recordFailedLogin(
      attemptKey,
      usernameValid ? MAX_FAILED_LOGINS : MAX_UNKNOWN_FAILED_LOGINS,
    );
    return null;
  }

  await clearFailedLogins(attemptKey);
  return {
    id: `admin:${createHash("sha256").update(normalizedUsername(configuredUsername)).digest("hex").slice(0, 32)}`,
    name: configuredUsername,
    role: "admin",
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
