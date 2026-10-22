import { describe, expect, it } from "vitest";
import {
  POSTGRES_BOOTSTRAP,
  bootstrapRoles,
  buildDatabaseUrl,
  generateRolePassword,
  parseStoredRolePassword,
  type SecretStore,
  type SqlClient,
  type SqlClientFactory,
} from "../scripts/bootstrap-azure-postgres-roles";

const adminPassword = "AdminPassword0123456789AdminPassword0123456789";

function fixture(options: {
  adminPassword?: string;
  existingRoles?: boolean;
  foreignPublicObject?: boolean;
  runtimeCanCreate?: boolean;
  existingSecrets?: Record<string, string>;
} = {}) {
  const secrets = new Map<string, string>([
    [POSTGRES_BOOTSTRAP.adminSecret, options.adminPassword ?? adminPassword],
    ...Object.entries(options.existingSecrets ?? {}),
  ]);
  const writes: Array<[string, string]> = [];
  const logins: Array<[string, string]> = [];
  const queries: Array<{ user: string; sql: string; values?: unknown[] }> = [];
  const store: SecretStore = {
    get: async (name) => secrets.get(name),
    put: async (name, value) => {
      secrets.set(name, value);
      writes.push([name, value]);
    },
  };
  const createClient: SqlClientFactory = (user, password): SqlClient => {
    logins.push([user, password]);
    return {
    connect: async () => undefined,
    end: async () => undefined,
    query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      values?: unknown[],
    ): Promise<{ rows: Row[] }> => {
      queries.push({ user, sql, values });
      let rows: Record<string, unknown>[] = [];
      if (sql.startsWith("SELECT rolname FROM pg_roles")) {
        rows = options.existingRoles ? [{ rolname: values?.[0] }] : [];
      } else if (sql.includes("FROM pg_auth_members")) {
        rows = [];
      } else if (sql.includes("FROM pg_class AS cls")) {
        rows = options.foreignPublicObject ? [{ relname: "stories" }] : [];
      } else if (sql.includes("FROM pg_namespace WHERE nspname = 'drizzle'")) {
        rows = [{ owner: POSTGRES_BOOTSTRAP.migratorUser }];
      } else if (sql.startsWith("SELECT current_user AS user_name")) {
        rows = [{
          user_name: user,
          can_create_schema: user === POSTGRES_BOOTSTRAP.migratorUser || !!options.runtimeCanCreate,
          can_create_table: user === POSTGRES_BOOTSTRAP.migratorUser || !!options.runtimeCanCreate,
          can_create_temp: !!options.runtimeCanCreate,
          can_use_public: true,
        }];
      }
      return { rows: rows as Row[] };
    },
    };
  };
  return { store, createClient, secrets, writes, logins, queries };
}

describe("private PostgreSQL role bootstrap", () => {
  it("accepts an Azure PostgreSQL administrator password with punctuation", async () => {
    const customAdminPassword = "Azure{admin}!password#2026?:longer";
    const { store, createClient, logins } = fixture({ adminPassword: customAdminPassword });
    await bootstrapRoles(store, createClient);
    expect(logins[0]).toEqual([POSTGRES_BOOTSTRAP.adminUser, customAdminPassword]);
  });

  it.each(["A".repeat(23), `${"A".repeat(24)}\n`, `${"A".repeat(24)}\t`, `${"A".repeat(24)}\u2028`])(
    "rejects an administrator password outside the single-line policy",
    async (invalidPassword) => {
      const { store, createClient, logins } = fixture({ adminPassword: invalidPassword });
      await expect(bootstrapRoles(store, createClient)).rejects.toThrow("administrator password is missing or invalid");
      expect(logins).toEqual([]);
    },
  );

  it("creates strong role credentials and strict verify-full URLs", () => {
    const password = generateRolePassword();
    expect(password).toMatch(/^[A-Za-z0-9_-]{64}$/);
    const url = buildDatabaseUrl(POSTGRES_BOOTSTRAP.runtimeUser, password);
    expect(url).toContain("sslmode=verify-full");
    expect(parseStoredRolePassword(url, POSTGRES_BOOTSTRAP.runtimeUser)).toBe(password);
    expect(url).toContain(POSTGRES_BOOTSTRAP.host);
  });

  it.each([
    "postgresql://comics_runtime:abcdefghijklmnopqrstuvwxyzABCDEF@evil.example/twilio_comics?sslmode=verify-full",
    `postgresql://comics_runtime:abcdefghijklmnopqrstuvwxyzABCDEF@${POSTGRES_BOOTSTRAP.host}/other_db?sslmode=verify-full`,
    `postgresql://comics_runtime:abcdefghijklmnopqrstuvwxyzABCDEF@${POSTGRES_BOOTSTRAP.host}/twilio_comics?sslmode=disable`,
    `postgresql://comics_runtime:abcdefghijklmnopqrstuvwxyzABCDEF@${POSTGRES_BOOTSTRAP.host}/twilio_comics?sslmode=verify-full&sslmode=disable`,
  ])("rejects a stored URL that could redirect a role credential: %s", (url) => {
    expect(() => parseStoredRolePassword(url, POSTGRES_BOOTSTRAP.runtimeUser)).toThrow();
  });

  it("creates migration and runtime logins, checks privileges, and writes distinct secrets", async () => {
    const { store, createClient, secrets, writes, queries } = fixture();
    await bootstrapRoles(store, createClient);

    expect(writes.map(([name]) => name)).toEqual([
      POSTGRES_BOOTSTRAP.migratorUrlSecret,
      POSTGRES_BOOTSTRAP.runtimeUrlSecret,
    ]);
    expect(parseStoredRolePassword(secrets.get(POSTGRES_BOOTSTRAP.migratorUrlSecret)!, POSTGRES_BOOTSTRAP.migratorUser)).toHaveLength(64);
    expect(parseStoredRolePassword(secrets.get(POSTGRES_BOOTSTRAP.runtimeUrlSecret)!, POSTGRES_BOOTSTRAP.runtimeUser)).toHaveLength(64);
    expect(queries[0]?.sql).toContain("pg_advisory_lock");
    expect(queries.at(-1)?.sql).toContain("pg_advisory_unlock");
    expect(queries.some(({ user, sql }) => user === POSTGRES_BOOTSTRAP.migratorUser && sql.includes("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE"))).toBe(true);
    expect(queries.some(({ user, sql }) => user === POSTGRES_BOOTSTRAP.migratorUser && sql.includes("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES"))).toBe(true);
    expect(queries.some(({ sql }) => sql === "REVOKE CREATE ON SCHEMA public FROM PUBLIC")).toBe(true);
    expect(queries.some(({ sql }) => sql === "REVOKE CONNECT, CREATE, TEMPORARY ON DATABASE twilio_comics FROM PUBLIC")).toBe(true);
    expect(queries.some(({ sql }) => sql === "GRANT USAGE ON SCHEMA public TO comics_runtime")).toBe(true);
    expect(queries.some(({ sql }) => /GRANT .*CREATE.* TO comics_runtime/.test(sql))).toBe(false);
  });

  it("reuses existing Key Vault credentials without silently rotating them", async () => {
    const migratorUrl = buildDatabaseUrl(POSTGRES_BOOTSTRAP.migratorUser, "M".repeat(48));
    const runtimeUrl = buildDatabaseUrl(POSTGRES_BOOTSTRAP.runtimeUser, "R".repeat(48));
    const { store, createClient, writes, queries } = fixture({
      existingRoles: true,
      existingSecrets: {
        [POSTGRES_BOOTSTRAP.migratorUrlSecret]: migratorUrl,
        [POSTGRES_BOOTSTRAP.runtimeUrlSecret]: runtimeUrl,
      },
    });
    await bootstrapRoles(store, createClient);
    expect(writes).toEqual([]);
    expect(queries.some(({ sql }) => sql.startsWith("ALTER ROLE comics_migrator"))).toBe(true);
    expect(queries.some(({ sql }) => sql.startsWith("ALTER ROLE comics_runtime"))).toBe(true);
  });

  it("fails closed before SQL changes when an existing Key Vault URL points elsewhere", async () => {
    const { store, createClient, queries, writes } = fixture({
      existingSecrets: {
        [POSTGRES_BOOTSTRAP.runtimeUrlSecret]: "postgresql://comics_runtime:abc@evil.example/twilio_comics?sslmode=verify-full",
      },
    });
    await expect(bootstrapRoles(store, createClient)).rejects.toThrow("Stored comics_runtime URL");
    expect(queries.some(({ sql }) => sql.startsWith("CREATE ROLE") || sql.startsWith("ALTER ROLE"))).toBe(false);
    expect(writes).toEqual([]);
  });

  it("rolls back and does not publish URLs if public objects belong to another owner", async () => {
    const { store, createClient, queries, writes } = fixture({ foreignPublicObject: true });
    await expect(bootstrapRoles(store, createClient)).rejects.toThrow("not owned by comics_migrator");
    expect(queries.some(({ sql }) => sql === "ROLLBACK")).toBe(true);
    expect(writes).toEqual([]);
  });

  it("does not publish credentials when runtime can create schema objects", async () => {
    const { store, createClient, writes } = fixture({ runtimeCanCreate: true });
    await expect(bootstrapRoles(store, createClient)).rejects.toThrow("Runtime role login or least-privilege checks");
    expect(writes).toEqual([]);
  });
});
