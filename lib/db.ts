import { isIP } from "node:net";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import "../envConfig.ts";

// A PostgreSQL driver's error message and attached fields can include the
// connection string. Only fixed, recognized codes may cross into logs.
const reportablePostgresErrorCodes = new Set([
  "08000", "08001", "08003", "08004", "08006", "08P01",
  "28P01", "3D000", "42501", "53300", "57P01", "57P02", "57P03",
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
]);

export function safePostgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    const code = Reflect.get(error, "code");
    return typeof code === "string" && reportablePostgresErrorCodes.has(code)
      ? code
      : undefined;
  } catch {
    return undefined;
  }
}

/** Keep TLS verification explicit; node-postgres URL SSL options override ssl config. */
export function createPostgresPoolConfig(databaseUrl: string): PoolConfig {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a PostgreSQL connection URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    url.pathname.length <= 1
  ) {
    throw new Error("DATABASE_URL must include a PostgreSQL host, user, and database");
  }

  for (const key of url.searchParams.keys()) {
    if (["ssl", "sslcert", "sslkey", "sslrootcert", "sslpassword"].includes(key.toLowerCase())) {
      throw new Error("Put certificate settings in the PostgreSQL client configuration, not the DATABASE_URL");
    }
  }

  const sslModes = url.searchParams.getAll("sslmode");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
  if (
    sslModes.length > 1 ||
    (loopback
      ? sslModes.some((mode) => mode !== "disable" && mode !== "verify-full")
      : sslModes.some((mode) => mode !== "verify-full"))
  ) {
    throw new Error("Remote PostgreSQL connections require sslmode=verify-full (or no sslmode to use the same strict default)");
  }
  url.searchParams.delete("sslmode");

  const tlsRequired = !loopback || sslModes[0] === "verify-full";
  return {
    connectionString: url.toString(),
    ssl: tlsRequired
      ? { rejectUnauthorized: true, ...(isIP(url.hostname) ? {} : { servername: url.hostname }) }
      : false,
    max: 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    allowExitOnIdle: true,
  };
}

// Auth.js and Drizzle inspect db during module evaluation. A Pool instance is
// still required for Drizzle transactions to pin all statements to one client.
// Delay both URL validation and socket creation until the first database call.
class LazyPool extends Pool {
  private actualPool?: Pool;

  private getActualPool(): Pool {
    if (!this.actualPool) {
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) {
        throw new Error("DATABASE_URL environment variable is not set");
      }
      this.actualPool = new Pool(createPostgresPoolConfig(databaseUrl));
      this.actualPool.on("error", (error) => {
        const code = safePostgresErrorCode(error);
        console.error(`PostgreSQL idle connection error${code ? ` (code ${code})` : ""}.`);
      });
    }
    return this.actualPool;
  }

  override query = ((...args: unknown[]) => {
    const pool = this.getActualPool();
    return Reflect.apply(pool.query, pool, args);
  }) as Pool["query"];

  override connect = ((...args: unknown[]) => {
    const pool = this.getActualPool();
    return Reflect.apply(pool.connect, pool, args);
  }) as Pool["connect"];

  override end = async () => {
    await this.actualPool?.end();
  };
}

export const db = drizzle(new LazyPool());
