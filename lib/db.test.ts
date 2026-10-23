import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testPostgresUrl } from "./test-postgres-url";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("database initialization", () => {
  it("lets Auth.js inspect the database without DATABASE_URL", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const { db } = await import("./db");

    expect(() => DrizzleAdapter(db)).not.toThrow();
    expect(() => db.select()).not.toThrow();
  });

  it("fails clearly when a query runs without DATABASE_URL", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const { db } = await import("./db");

    await expect(async () => db.execute(sql`select 1`)).rejects.toMatchObject({
      cause: {
        message: "DATABASE_URL environment variable is not set",
      },
    });
  });

  it("builds a query when DATABASE_URL is configured without connecting early", async () => {
    vi.stubEnv(
      "DATABASE_URL",
      testPostgresUrl({ host: "db.example.invalid" }),
    );
    const { db } = await import("./db");

    expect(typeof db.select().from).toBe("function");
  });

  it("keeps Pool transaction semantics without opening a connection during import", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const { db } = await import("./db");

    expect(db.$client).toBeInstanceOf(Pool);
    await expect(db.transaction(async () => "unreachable")).rejects.toThrow(
      "DATABASE_URL environment variable is not set",
    );
  });
});

describe("PostgreSQL connection security", () => {
  it("does not log credentials from an idle connection error", async () => {
    const secret = "sentinel_" + "driver_password";
    const databaseUrl = testPostgresUrl({
      host: "db.example.invalid",
      password: secret,
    });
    vi.stubEnv("DATABASE_URL", databaseUrl);
    const on = vi.spyOn(Pool.prototype, "on");
    vi.spyOn(Pool.prototype, "connect").mockResolvedValue({ release: vi.fn() } as never);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { db } = await import("./db");
    await db.$client.connect();
    const idleErrorHandler = on.mock.calls.find(([event]) => event === "error")?.[1] as
      | ((error: Error) => void)
      | undefined;
    expect(idleErrorHandler).toBeTypeOf("function");

    const driverError = Object.assign(new Error(`Connection failed for ${databaseUrl}`), {
      code: "28P01",
      detail: `Credential rejected: ${secret}`,
    });
    idleErrorHandler?.(driverError);

    const logged = JSON.stringify(errorLog.mock.calls);
    expect(logged).toContain("PostgreSQL idle connection error");
    expect(logged).toContain("28P01");
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain(databaseUrl);
  });

  it("does not echo an untrusted database error code", async () => {
    const { safePostgresErrorCode } = await import("./db");
    expect(safePostgresErrorCode({ code: "sentinel_" + "driver_password" })).toBeUndefined();
    expect(safePostgresErrorCode({ code: "ECONNREFUSED" })).toBe("ECONNREFUSED");
  });

  it("verifies an Azure server certificate and hostname even with sslmode in the URL", async () => {
    const { createPostgresPoolConfig } = await import("./db");

    const config = createPostgresPoolConfig(
      testPostgresUrl({ host: "comics-pg.postgres.database.azure.com", params: [["sslmode", "verify-full"]] }),
    );

    expect(config.ssl).toEqual({
      rejectUnauthorized: true,
      servername: "comics-pg.postgres.database.azure.com",
    });
    expect(config.connectionString).not.toContain("sslmode=");
    expect(config.max).toBeGreaterThan(0);
    expect(config.max).toBeLessThanOrEqual(4);
    expect(config.connectionTimeoutMillis).toBeGreaterThan(0);
  });

  it("refuses a remote URL that requests weaker TLS", async () => {
    const { createPostgresPoolConfig } = await import("./db");

    expect(() => createPostgresPoolConfig(
      testPostgresUrl({ host: "comics-pg.postgres.database.azure.com", params: [["sslmode", "require"]] }),
    )).toThrow(/verify-full/);
    expect(() => createPostgresPoolConfig(
      testPostgresUrl({ host: "comics-pg.postgres.database.azure.com", params: [["sslmode", "disable"]] }),
    )).toThrow(/verify-full/);
  });

  it("allows a loopback development database without TLS", async () => {
    const { createPostgresPoolConfig } = await import("./db");

    const config = createPostgresPoolConfig(
      testPostgresUrl({ host: "127.0.0.1", port: 5432, params: [["sslmode", "disable"]] }),
    );

    expect(config.ssl).toBe(false);
    expect(config.connectionString).not.toContain("sslmode=");
  });

  it("rejects certificate URL parameters that could override TLS verification", async () => {
    const { createPostgresPoolConfig } = await import("./db");

    expect(() => createPostgresPoolConfig(
      testPostgresUrl({ host: "comics-pg.postgres.database.azure.com", params: [["sslmode", "verify-full"], ["sslrootcert", "/tmp/root.crt"]] }),
    )).toThrow(/certificate.*URL|URL.*certificate/i);
  });
});
