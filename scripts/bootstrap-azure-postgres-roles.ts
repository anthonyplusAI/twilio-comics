import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { ManagedIdentityCredential } from "@azure/identity";
import { Client } from "pg";

/** This executable runs only in a manual Job inside cae-twilio-comics-v2. */
export const POSTGRES_BOOTSTRAP = {
  host: "twilio-comics-pg-1a1d98.postgres.database.azure.com",
  database: "twilio_comics",
  adminUser: "comics_bootstrap",
  migratorUser: "comics_migrator",
  runtimeUser: "comics_runtime",
  adminSecret: "postgres-bootstrap-password",
  migratorUrlSecret: "postgres-comics-migration-url",
  runtimeUrlSecret: "postgres-comics-runtime-url",
  vaultName: "kv-twilio-comics-1a1d98",
} as const;

type Role = typeof POSTGRES_BOOTSTRAP.migratorUser | typeof POSTGRES_BOOTSTRAP.runtimeUser;

interface QueryResult<Row> {
  rows: Row[];
}

export interface SqlClient {
  connect(): Promise<void>;
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
  end(): Promise<void>;
}

export interface SecretStore {
  get(name: string): Promise<string | undefined>;
  put(name: string, value: string): Promise<void>;
}

export type SqlClientFactory = (user: string, password: string) => SqlClient;

export function generateRolePassword(): string {
  return randomBytes(48).toString("base64url");
}

export function buildDatabaseUrl(user: Role, password: string): string {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(password)) {
    throw new Error("Database role password must be a 32-128 character base64url string");
  }
  const url = new URL(`postgresql://${POSTGRES_BOOTSTRAP.host}/${POSTGRES_BOOTSTRAP.database}`);
  url.username = user;
  url.password = password;
  url.searchParams.set("sslmode", "verify-full");
  return url.toString();
}

export function parseStoredRolePassword(value: string, user: Role): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Stored ${user} URL is invalid`);
  }
  if (
    url.protocol !== "postgresql:" ||
    url.hostname !== POSTGRES_BOOTSTRAP.host ||
    url.port ||
    url.username !== user ||
    url.pathname !== `/${POSTGRES_BOOTSTRAP.database}` ||
    url.hash ||
    url.searchParams.size !== 1 ||
    url.searchParams.get("sslmode") !== "verify-full"
  ) {
    throw new Error(`Stored ${user} URL does not match this private PostgreSQL server`);
  }
  let password: string;
  try {
    password = decodeURIComponent(url.password);
  } catch {
    throw new Error(`Stored ${user} URL has an invalid password encoding`);
  }
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(password)) {
    throw new Error(`Stored ${user} URL has an invalid role password`);
  }
  return password;
}

function rolePasswordStatement(role: Role, password: string, exists: boolean): string {
  // The role is a checked-in identifier and the password is base64url only.
  // PostgreSQL utility commands cannot use a bind parameter for PASSWORD.
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(password)) {
    throw new Error("Invalid role password");
  }
  return `${exists ? "ALTER" : "CREATE"} ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`;
}

async function ensureRole(client: SqlClient, role: Role, password: string): Promise<void> {
  const found = await client.query<{ rolname: string }>(
    "SELECT rolname FROM pg_roles WHERE rolname = $1",
    [role],
  );
  await client.query(rolePasswordStatement(role, password, found.rows.length > 0));
  const memberships = await client.query<{ member_of: string }>(
    "SELECT parent.rolname AS member_of FROM pg_auth_members AS membership JOIN pg_roles AS parent ON parent.oid = membership.roleid JOIN pg_roles AS member ON member.oid = membership.member WHERE member.rolname = $1",
    [role],
  );
  if (memberships.rows.length > 0) {
    throw new Error(`${role} has unexpected role memberships; review its privileges before bootstrap`);
  }
}

async function provisionSqlRoles(admin: SqlClient, migratorPassword: string, runtimePassword: string): Promise<void> {
  await admin.query("BEGIN");
  try {
    const foreignObjects = await admin.query<{ relname: string }>(
      "SELECT cls.relname FROM pg_class AS cls JOIN pg_namespace AS ns ON ns.oid = cls.relnamespace WHERE ns.nspname = 'public' AND cls.relkind IN ('r', 'p', 'S', 'v', 'm', 'f') AND pg_get_userbyid(cls.relowner) <> $1 LIMIT 1",
      [POSTGRES_BOOTSTRAP.migratorUser],
    );
    if (foreignObjects.rows.length > 0) {
      throw new Error("Public database objects are not owned by comics_migrator; review database import and ownership before bootstrap");
    }

    await ensureRole(admin, POSTGRES_BOOTSTRAP.migratorUser, migratorPassword);
    await ensureRole(admin, POSTGRES_BOOTSTRAP.runtimeUser, runtimePassword);
    await admin.query(`REVOKE CONNECT, CREATE, TEMPORARY ON DATABASE ${POSTGRES_BOOTSTRAP.database} FROM PUBLIC`);
    await admin.query(`REVOKE CREATE, TEMPORARY ON DATABASE ${POSTGRES_BOOTSTRAP.database} FROM ${POSTGRES_BOOTSTRAP.runtimeUser}`);
    await admin.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    await admin.query(`REVOKE CREATE ON SCHEMA public FROM ${POSTGRES_BOOTSTRAP.runtimeUser}`);
    await admin.query(`GRANT CONNECT, CREATE ON DATABASE ${POSTGRES_BOOTSTRAP.database} TO ${POSTGRES_BOOTSTRAP.migratorUser}`);
    await admin.query(`GRANT CONNECT ON DATABASE ${POSTGRES_BOOTSTRAP.database} TO ${POSTGRES_BOOTSTRAP.runtimeUser}`);
    await admin.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${POSTGRES_BOOTSTRAP.migratorUser}`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${POSTGRES_BOOTSTRAP.runtimeUser}`);
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

async function configureMigratorGrants(migrator: SqlClient): Promise<void> {
  await migrator.query("CREATE SCHEMA IF NOT EXISTS drizzle");
  const drizzleOwner = await migrator.query<{ owner: string }>(
    "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'drizzle'",
  );
  if (drizzleOwner.rows[0]?.owner !== POSTGRES_BOOTSTRAP.migratorUser) {
    throw new Error("The existing drizzle schema is not owned by comics_migrator");
  }
  // Defaults must be set by the creating role itself. They do not inherit from
  // another role's defaults, even when the creator belongs to that role.
  await migrator.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${POSTGRES_BOOTSTRAP.runtimeUser}`,
  );
  await migrator.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${POSTGRES_BOOTSTRAP.runtimeUser}`,
  );
  await migrator.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${POSTGRES_BOOTSTRAP.runtimeUser}`,
  );
  await migrator.query(
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${POSTGRES_BOOTSTRAP.runtimeUser}`,
  );
  const result = await migrator.query<{
    user_name: string;
    can_create_schema: boolean;
    can_create_table: boolean;
  }>(
    "SELECT current_user AS user_name, has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_schema, has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_table",
  );
  if (
    result.rows[0]?.user_name !== POSTGRES_BOOTSTRAP.migratorUser ||
    result.rows[0]?.can_create_schema !== true ||
    result.rows[0]?.can_create_table !== true
  ) {
    throw new Error("Migration role login or DDL privileges did not verify");
  }
}

async function verifyRuntimePrivileges(runtime: SqlClient): Promise<void> {
  const result = await runtime.query<{
    user_name: string;
    can_create_schema: boolean;
    can_create_table: boolean;
    can_create_temp: boolean;
    can_use_public: boolean;
  }>(
    "SELECT current_user AS user_name, has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_schema, has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_table, has_database_privilege(current_user, current_database(), 'TEMPORARY') AS can_create_temp, has_schema_privilege(current_user, 'public', 'USAGE') AS can_use_public",
  );
  if (
    result.rows[0]?.user_name !== POSTGRES_BOOTSTRAP.runtimeUser ||
    result.rows[0]?.can_create_schema !== false ||
    result.rows[0]?.can_create_table !== false ||
    result.rows[0]?.can_create_temp !== false ||
    result.rows[0]?.can_use_public !== true
  ) {
    throw new Error("Runtime role login or least-privilege checks did not verify");
  }
}

async function withConnectedClient<T>(client: SqlClient, run: (connected: SqlClient) => Promise<T>): Promise<T> {
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

export async function bootstrapRoles(
  store: SecretStore,
  createClient: SqlClientFactory,
  reportStage: (stage: string) => void = () => {},
): Promise<void> {
  reportStage("administrator-secret-read");
  const adminPassword = await store.get(POSTGRES_BOOTSTRAP.adminSecret);
  const adminPasswordLength = adminPassword ? [...adminPassword].length : 0;
  if (
    !adminPassword ||
    adminPasswordLength < 24 ||
    adminPasswordLength > 128 ||
    /[\u0000-\u001f\u007f\u2028\u2029]/u.test(adminPassword ?? "")
  ) {
    throw new Error("The Key Vault PostgreSQL administrator password is missing or invalid");
  }

  const admin = createClient(POSTGRES_BOOTSTRAP.adminUser, adminPassword);
  reportStage("administrator-database-connect");
  await withConnectedClient(admin, async (connectedAdmin) => {
    // A session lock protects SQL changes and Key Vault writes together. If a
    // replica crashes, PostgreSQL releases the lock with its connection.
    reportStage("database-advisory-lock");
    await connectedAdmin.query("SELECT pg_advisory_lock(8669012028)");
    try {
      reportStage("role-secret-read");
      const storedMigrationUrl = await store.get(POSTGRES_BOOTSTRAP.migratorUrlSecret);
      const storedRuntimeUrl = await store.get(POSTGRES_BOOTSTRAP.runtimeUrlSecret);
      const migrationPassword = storedMigrationUrl
        ? parseStoredRolePassword(storedMigrationUrl, POSTGRES_BOOTSTRAP.migratorUser)
        : generateRolePassword();
      const runtimePassword = storedRuntimeUrl
        ? parseStoredRolePassword(storedRuntimeUrl, POSTGRES_BOOTSTRAP.runtimeUser)
        : generateRolePassword();

      reportStage("role-sql-transaction");
      await provisionSqlRoles(connectedAdmin, migrationPassword, runtimePassword);
      reportStage("migrator-database-verification");
      await withConnectedClient(
        createClient(POSTGRES_BOOTSTRAP.migratorUser, migrationPassword),
        configureMigratorGrants,
      );
      reportStage("runtime-database-verification");
      await withConnectedClient(
        createClient(POSTGRES_BOOTSTRAP.runtimeUser, runtimePassword),
        verifyRuntimePrivileges,
      );

      // A retry preserves existing secret values; a crash between SQL commit
      // and the first write simply leads to a new credential on the next run.
      if (!storedMigrationUrl) {
        reportStage("migration-url-secret-write");
        await store.put(
          POSTGRES_BOOTSTRAP.migratorUrlSecret,
          buildDatabaseUrl(POSTGRES_BOOTSTRAP.migratorUser, migrationPassword),
        );
      }
      if (!storedRuntimeUrl) {
        reportStage("runtime-url-secret-write");
        await store.put(
          POSTGRES_BOOTSTRAP.runtimeUrlSecret,
          buildDatabaseUrl(POSTGRES_BOOTSTRAP.runtimeUser, runtimePassword),
        );
      }
    } finally {
      await connectedAdmin.query("SELECT pg_advisory_unlock(8669012028)");
    }
  });
}

const KEY_VAULT_AUTHORIZATION_WINDOW_MS = 12 * 60_000;
const KEY_VAULT_RETRY_INTERVAL_MS = 5_000;
const KEY_VAULT_MAX_OTHER_FAILURES = 12;
const KEY_VAULT_SECRET_TTL_SECONDS = 365 * 24 * 60 * 60;
const RETRYABLE_KEY_VAULT_STATUSES = new Set([403, 408, 429, 500, 502, 503, 504]);
const REPORTABLE_KEY_VAULT_STATUSES = new Set([400, 401, 403, 404, 408, 429, 500, 502, 503, 504]);

export function buildKeyVaultSecretPayload(value: string, now: Date = new Date()) {
  // The vault's governance policy requires an explicit UTC expiry on every
  // new version. Existing secrets are read and reused without changing it.
  return {
    value,
    attributes: { exp: Math.floor(now.getTime() / 1000) + KEY_VAULT_SECRET_TTL_SECONDS },
  };
}

export class KeyVaultHttpError extends Error {
  constructor(readonly status: number) {
    super("Key Vault request failed");
  }
}

/** One RBAC propagation deadline is shared by every secret read and write. */
export class KeyVaultRetryWindow {
  private deadlineMs: number | undefined;

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly sleep: (durationMs: number) => Promise<void> =
      (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
  ) {}

  async request(method: "GET" | "PUT", send: () => Promise<Response>): Promise<Response> {
    const deadlineMs = this.deadlineMs ??= this.now() + KEY_VAULT_AUTHORIZATION_WINDOW_MS;
    let otherTransientFailures = 0;
    for (;;) {
      let response: Response | undefined;
      try {
        response = await send();
      } catch {
        otherTransientFailures++;
        if (otherTransientFailures >= KEY_VAULT_MAX_OTHER_FAILURES || this.now() >= deadlineMs) {
          throw new Error("Key Vault could not be reached from the private Container Apps Job");
        }
      }
      if (response) {
        if (response.ok || (method === "GET" && response.status === 404)) return response;
        if (response.status === 403) {
          const payload: unknown = await response.json().catch(() => undefined);
          const errorCode = typeof payload === "object" && payload !== null && "error" in payload &&
            typeof payload.error === "object" && payload.error !== null && "code" in payload.error
            ? payload.error.code
            : undefined;
          if (errorCode === "ForbiddenByFirewall" || errorCode === "ForbiddenByGovernancePolicy") {
            throw new KeyVaultHttpError(403);
          }
        } else {
          otherTransientFailures++;
        }
        if (
          !RETRYABLE_KEY_VAULT_STATUSES.has(response.status) ||
          this.now() >= deadlineMs ||
          otherTransientFailures >= KEY_VAULT_MAX_OTHER_FAILURES
        ) {
          throw new KeyVaultHttpError(response.status);
        }
      }
      const remainingMs = deadlineMs - this.now();
      if (remainingMs <= 0) {
        throw new Error("Key Vault did not become available");
      }
      await this.sleep(Math.min(KEY_VAULT_RETRY_INTERVAL_MS, remainingMs));
    }
  }
}

class KeyVaultSecrets implements SecretStore {
  private readonly credential: ManagedIdentityCredential;
  private readonly baseUrl = `https://${POSTGRES_BOOTSTRAP.vaultName}.vault.azure.net`;
  private readonly retry = new KeyVaultRetryWindow();

  constructor(clientId: string) {
    this.credential = new ManagedIdentityCredential(clientId);
  }

  private async request(name: string, method: "GET" | "PUT", value?: string): Promise<Response> {
    const endpoint = `${this.baseUrl}/secrets/${name}?api-version=7.4`;
    let body: string | undefined;
    if (method === "PUT") {
      if (value === undefined) throw new Error("Key Vault secret value is required");
      body = JSON.stringify(buildKeyVaultSecretPayload(value));
    }
    // Azure RBAC can take up to 10 minutes to propagate. The first request
    // starts a shared 12-minute monotonic window, including both URL writes.
    return this.retry.request(method, async () => {
      const token = await this.credential.getToken("https://vault.azure.net/.default");
      if (!token) throw new Error("Managed identity token unavailable");
      return fetch(endpoint, {
        method,
        headers: {
          Authorization: `Bearer ${token.token}`,
          ...(method === "PUT" ? { "Content-Type": "application/json" } : {}),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    });
  }

  async get(name: string): Promise<string | undefined> {
    const response = await this.request(name, "GET");
    if (response.status === 404) return undefined;
    const result: unknown = await response.json();
    if (typeof result !== "object" || result === null || !("value" in result) || typeof result.value !== "string") {
      throw new Error(`Key Vault ${name} response did not contain a secret value`);
    }
    return result.value;
  }

  async put(name: string, value: string): Promise<void> {
    const response = await this.request(name, "PUT", value);
    if (!response.ok) throw new Error(`Key Vault ${name} could not be updated`);
  }
}

function createPgClient(user: string, password: string): SqlClient {
  const client = new Client({
    host: POSTGRES_BOOTSTRAP.host,
    database: POSTGRES_BOOTSTRAP.database,
    user,
    password,
    port: 5432,
    ssl: { rejectUnauthorized: true, servername: POSTGRES_BOOTSTRAP.host },
    connectionTimeoutMillis: 10_000,
    application_name: "twilio-comics-role-bootstrap",
  });
  return {
    connect: () => client.connect(),
    query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      values?: unknown[],
    ) => (await client.query(sql, values)) as QueryResult<Row>,
    end: () => client.end(),
  };
}

export function formatBootstrapFailure(stage: string, error: unknown): string {
  // Never surface SDK/HTTP bodies, secret names, URLs, or PostgreSQL messages.
  const httpStatus = error instanceof KeyVaultHttpError && REPORTABLE_KEY_VAULT_STATUSES.has(error.status)
    ? ` (HTTP ${error.status})`
    : "";
  const rawCode = typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
  const code = typeof rawCode === "string" && /^(?:[0-9A-Z]{5}|E[A-Z]{3,12})$/.test(rawCode)
    ? ` (code ${rawCode})`
    : "";
  return `PostgreSQL role bootstrap failed at ${stage}${httpStatus || code}.`;
}

async function main(): Promise<void> {
  let stage = "startup";
  try {
    const clientId = process.env.AZURE_CLIENT_ID;
    if (!clientId || !/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(clientId)) {
      throw new Error("AZURE_CLIENT_ID must identify the bootstrap Job's managed identity");
    }
    await bootstrapRoles(
      new KeyVaultSecrets(clientId),
      createPgClient,
      (currentStage) => { stage = currentStage; },
    );
    console.log("PostgreSQL runtime and migration roles verified; Key Vault connection URLs are ready.");
  } catch (error) {
    console.error(formatBootstrapFailure(stage, error));
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("bootstrap-azure-postgres-roles.ts")) {
  void main();
}
