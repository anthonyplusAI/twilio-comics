import { constants, createPublicKey, publicEncrypt, randomBytes, type KeyObject } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { hashAdminPassword } from "../lib/admin-auth";
import { createPostgresPoolConfig } from "../lib/db";

const ACKNOWLEDGEMENT = "REPLACE_ACTIVE_ADMIN_LOGIN";
const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export type RecoveryEnvelope = {
  version: 1;
  username: string;
  algorithm: "RSA-OAEP-SHA256";
  ciphertext: string;
};

type RecoveryEnvironment = Readonly<Record<string, string | undefined>>;

function recoveryInput(environment: RecoveryEnvironment): { username: string; publicKey: KeyObject } {
  if (environment.ADMIN_RECOVERY_ACK !== ACKNOWLEDGEMENT) {
    throw new Error("Admin recovery acknowledgement is required");
  }

  const databaseUrlText = environment.DATABASE_URL;
  if (!databaseUrlText) throw new Error("Admin recovery database URL is required");
  let databaseUrl: URL;
  try {
    databaseUrl = new URL(databaseUrlText);
  } catch {
    throw new Error("Admin recovery database URL is invalid");
  }
  if (databaseUrl.protocol !== "postgresql:" ||
      databaseUrl.hostname !== "twilio-comics-pg-1a1d98.postgres.database.azure.com" ||
      databaseUrl.username !== "comics_migrator" ||
      databaseUrl.pathname !== "/twilio_comics" ||
      databaseUrl.port || databaseUrl.hash ||
      databaseUrl.searchParams.size !== 1 ||
      databaseUrl.searchParams.get("sslmode") !== "verify-full") {
    throw new Error("Admin recovery requires the approved private migration database");
  }

  const username = environment.ADMIN_RECOVERY_USERNAME;
  if (!username || !USERNAME_PATTERN.test(username)) {
    throw new Error("Admin recovery username is invalid");
  }

  const encoded = environment.ADMIN_RECOVERY_PUBLIC_KEY_BASE64;
  if (!encoded || encoded.length > 4096 || !BASE64_PATTERN.test(encoded)) {
    throw new Error("Admin recovery public key is invalid");
  }
  const der = Buffer.from(encoded, "base64");
  if (der.toString("base64") !== encoded) {
    throw new Error("Admin recovery public key is invalid");
  }
  const publicKey = createPublicKey({ key: der, format: "der", type: "spki" });
  const details = publicKey.asymmetricKeyDetails;
  if (publicKey.asymmetricKeyType !== "rsa" ||
      !details || (details.modulusLength ?? 0) < 3072 ||
      details.publicExponent !== 65537n) {
    throw new Error("Admin recovery requires an RSA public key of at least 3072 bits");
  }

  return { username, publicKey };
}

/** Only the private migration Job should call this, using its Key Vault database binding. */
export async function recoverAdminLogin(
  environment: RecoveryEnvironment,
  pool: Pick<Pool, "query">,
): Promise<RecoveryEnvelope> {
  const { username, publicKey } = recoveryInput(environment);
  // The generated secret never enters a CLI argument, environment setting, or log.
  const password = randomBytes(36).toString("base64url");
  const ciphertext = publicEncrypt({
    key: publicKey,
    padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: "sha256",
  }, Buffer.from(password, "utf8")).toString("base64");
  const passwordHash = await hashAdminPassword(password);

  const result = await pool.query<{ id: number }>(`
    INSERT INTO public.admin_credentials
      (id, username, password_hash, created_at, updated_at)
    VALUES (1, $1, $2, NOW(), NOW())
    ON CONFLICT (id) DO UPDATE SET
      username = EXCLUDED.username,
      password_hash = EXCLUDED.password_hash,
      updated_at = NOW()
    RETURNING id
  `, [username, passwordHash]);
  if (result.rows[0]?.id !== 1) {
    throw new Error("Admin recovery did not update the singleton credential row");
  }

  return { version: 1, username, algorithm: "RSA-OAEP-SHA256", ciphertext };
}

async function main(): Promise<void> {
  let pool: Pool | undefined;
  let envelope: RecoveryEnvelope | undefined;
  try {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL is required");
    pool = new Pool(createPostgresPoolConfig(databaseUrl));
    envelope = await recoverAdminLogin(process.env, pool);
  } catch {
    // Error details can contain a database URL or a public key. Never log them.
  } finally {
    if (pool) {
      try {
        await pool.end();
      } catch {
        // A committed recovery remains successful even if connection cleanup
        // fails. The operator still needs its encrypted password envelope.
      }
    }
  }

  if (!envelope) {
    process.stderr.write("Admin recovery failed. Check the private Job configuration and database access.\n");
    process.exitCode = 1;
    return;
  }

  // The private key remains with the operator; this is the sole success output.
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
