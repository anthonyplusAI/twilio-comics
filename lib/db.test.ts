import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { sql } from "drizzle-orm";
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
});
