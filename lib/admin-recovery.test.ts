import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { spawnSync } from "node:child_process";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { verifyAdminPassword } from "@/lib/admin-auth";
import { testPostgresUrl } from "@/lib/test-postgres-url";
import { recoverAdminLogin } from "@/scripts/recover-admin-login";

type RecoveryEnvelope = Awaited<ReturnType<typeof recoverAdminLogin>>;

const username = "recovered-admin";
const acknowledgement = "REPLACE_ACTIVE_ADMIN_LOGIN";
const migrationTarget = {
  host: "twilio-comics-pg-1a1d98.postgres.database.azure.com",
  database: "twilio_comics",
  user: "comics_migrator",
  params: [["sslmode", "verify-full"]] as const,
};
const migrationUrl = testPostgresUrl(migrationTarget);
let publicKeyBase64: string;
let privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];

beforeAll(() => {
  const keyPair = generateKeyPairSync("rsa", { modulusLength: 3072 });
  publicKeyBase64 = keyPair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  privateKey = keyPair.privateKey;
});

function request(overrides: Record<string, string | undefined> = {}) {
  return {
    DATABASE_URL: migrationUrl,
    ADMIN_RECOVERY_USERNAME: username,
    ADMIN_RECOVERY_PUBLIC_KEY_BASE64: publicKeyBase64,
    ADMIN_RECOVERY_ACK: acknowledgement,
    ...overrides,
  };
}

function fakePool(query: (statement: string, values?: unknown[]) => Promise<unknown>): Pick<Pool, "query"> {
  return { query } as unknown as Pick<Pool, "query">;
}

function decryptPassword(envelope: RecoveryEnvelope): string {
  return privateDecrypt({
    key: privateKey,
    padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: "sha256",
  }, Buffer.from(envelope.ciphertext, "base64")).toString("utf8");
}

describe("private admin login recovery", () => {
  it("replaces the singleton row with a hash of the password in the encrypted envelope", async () => {
    let stored: { username: string; passwordHash: string } | undefined;
    const query = vi.fn(async (statement: string, values?: unknown[]) => {
      if (!/INSERT INTO (?:public\.)?admin_credentials\b/i.test(statement) ||
          !/ON CONFLICT \(id\) DO UPDATE/i.test(statement) ||
          !/VALUES \(1,/i.test(statement) || !values || values.length !== 2) {
        throw new Error("Unexpected credential write");
      }
      stored = { username: String(values[0]), passwordHash: String(values[1]) };
      return { rows: [{ id: 1 }] };
    });

    const envelope = await recoverAdminLogin(request(), fakePool(query));
    const password = decryptPassword(envelope);

    expect(password).toMatch(/^[A-Za-z0-9_-]{48}$/);
    expect(stored?.username).toBe(username);
    expect(stored?.passwordHash).toMatch(/^scrypt\$/);
    expect(await verifyAdminPassword(password, stored!.passwordHash)).toBe(true);
    expect(envelope).toEqual({
      version: 1,
      username,
      algorithm: "RSA-OAEP-SHA256",
      ciphertext: expect.any(String),
    });
    expect(JSON.stringify(envelope)).not.toContain(password);
    expect(JSON.stringify(envelope)).not.toContain(stored!.passwordHash);
  });

  it.each([
    ["missing acknowledgement", { ADMIN_RECOVERY_ACK: undefined }],
    ["incorrect acknowledgement", { ADMIN_RECOVERY_ACK: "yes" }],
    ["invalid username", { ADMIN_RECOVERY_USERNAME: "admin name" }],
    ["Unicode username", { ADMIN_RECOVERY_USERNAME: "adminé" }],
    ["missing key", { ADMIN_RECOVERY_PUBLIC_KEY_BASE64: undefined }],
    ["malformed key", { ADMIN_RECOVERY_PUBLIC_KEY_BASE64: "not-a-key" }],
  ])("blocks %s before any database write", async (_caseName, overrides) => {
    const query = vi.fn();
    await expect(recoverAdminLogin(request(overrides), fakePool(query))).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects RSA keys below 3072 bits before changing credentials", async () => {
    const weakKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey
      .export({ format: "der", type: "spki" }).toString("base64");
    const query = vi.fn();
    await expect(recoverAdminLogin(
      request({ ADMIN_RECOVERY_PUBLIC_KEY_BASE64: weakKey }), fakePool(query),
    )).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects a non-RSA public key before changing credentials", async () => {
    const ellipticCurveKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey
      .export({ format: "der", type: "spki" }).toString("base64");
    const query = vi.fn();
    await expect(recoverAdminLogin(
      request({ ADMIN_RECOVERY_PUBLIC_KEY_BASE64: ellipticCurveKey }), fakePool(query),
    )).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ["another server", testPostgresUrl({ ...migrationTarget, host: "other.postgres.database.azure.com" })],
    ["the runtime role", testPostgresUrl({ ...migrationTarget, user: "comics_runtime" })],
    ["another database", testPostgresUrl({ ...migrationTarget, database: "other" })],
    ["a non-verifying TLS mode", testPostgresUrl({ ...migrationTarget, params: [["sslmode", "disable"]] })],
  ])("rejects %s before changing credentials", async (_caseName, databaseUrl) => {
    const query = vi.fn();
    await expect(recoverAdminLogin(request({ DATABASE_URL: databaseUrl }), fakePool(query)))
      .rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it("does not return an envelope when the database update fails", async () => {
    const query = vi.fn().mockRejectedValue(new Error("database unavailable"));
    await expect(recoverAdminLogin(request(), fakePool(query))).rejects.toThrow("database unavailable");
    expect(query).toHaveBeenCalledOnce();
  });

  it("runs as a command and keeps rejected input and database credentials out of logs", () => {
    const sentinel = "DO_NOT_LOG_THIS_DB_PASSWORD";
    const result = spawnSync(process.execPath, [
      "--import", "tsx", "scripts/recover-admin-login.ts",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        ...request({
          DATABASE_URL: testPostgresUrl({ host: "localhost", password: sentinel, params: [["sslmode", "disable"]] }),
          ADMIN_RECOVERY_ACK: `wrong-${sentinel}`,
        }),
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Admin recovery failed");
    expect(result.stderr).not.toContain(sentinel);
  }, 20_000);
});
