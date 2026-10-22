import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
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
      "postgresql://user:password@db.example.invalid/comics",
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
  it("verifies an Azure server certificate and hostname even with sslmode in the URL", async () => {
    const { createPostgresPoolConfig } = await import("./db");

    const config = createPostgresPoolConfig(
      "postgresql://app:secret@comics-pg.postgres.database.azure.com/comics?sslmode=verify-full",
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
      "postgresql://app:secret@comics-pg.postgres.database.azure.com/comics?sslmode=require",
    )).toThrow(/verify-full/);
    expect(() => createPostgresPoolConfig(
      "postgresql://app:secret@comics-pg.postgres.database.azure.com/comics?sslmode=disable",
    )).toThrow(/verify-full/);
  });

  it("allows a loopback development database without TLS", async () => {
    const { createPostgresPoolConfig } = await import("./db");

    const config = createPostgresPoolConfig(
      "postgresql://app:secret@127.0.0.1:5432/comics?sslmode=disable",
    );

    expect(config.ssl).toBe(false);
    expect(config.connectionString).not.toContain("sslmode=");
  });

  it("rejects certificate URL parameters that could override TLS verification", async () => {
    const { createPostgresPoolConfig } = await import("./db");

    expect(() => createPostgresPoolConfig(
      "postgresql://app:secret@comics-pg.postgres.database.azure.com/comics?sslmode=verify-full&sslrootcert=/tmp/root.crt",
    )).toThrow(/certificate.*URL|URL.*certificate/i);
  });
});
