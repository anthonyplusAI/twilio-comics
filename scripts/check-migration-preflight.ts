import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readMigrationFiles } from "drizzle-orm/migrator";
import { Pool } from "pg";
import { createPostgresPoolConfig } from "../lib/db";

type ColumnShape = { type: string; notNull: boolean };
type TableShape = {
  columns: Record<string, ColumnShape>;
  constraints: Record<string, string>;
  indexes: string[];
};

export type SchemaShape = Record<string, TableShape>;

export type MigrationPlanEntry = {
  tag: string;
  when: number;
  hash: string;
  variants: SchemaShape[];
};

export type DatabaseState = {
  journalExists: boolean;
  journalRows: Array<{ hash: string; createdAt: number }>;
  schema: SchemaShape;
  duplicatePageGroups: Array<{ storyId: string; pageNumber: number; count: number }>;
  orphanActiveStoryCount: number;
};

export type PreflightAssessment = {
  ok: boolean;
  message: string;
  pending: number;
  lastApplied?: string;
  baselineCandidates: string[];
};

type SnapshotColumn = {
  type: string;
  notNull: boolean;
  primaryKey?: boolean;
};

type SnapshotTable = {
  name: string;
  columns: Record<string, SnapshotColumn>;
  indexes?: Record<string, unknown>;
  foreignKeys?: Record<string, unknown>;
  compositePrimaryKeys?: Record<string, unknown>;
  uniqueConstraints?: Record<string, unknown>;
  checkConstraints?: Record<string, unknown>;
};

type Snapshot = { tables: Record<string, SnapshotTable> };
type Journal = {
  entries: Array<{ idx: number; tag: string; when: number }>;
};

function normalizeSnapshotType(type: string): string {
  if (type === "serial") return "integer";
  if (type === "timestamp") return "timestamp without time zone";
  return type;
}

function snapshotShape(snapshot: Snapshot): SchemaShape {
  const shape: SchemaShape = {};

  for (const [qualifiedName, table] of Object.entries(snapshot.tables)) {
    if (!qualifiedName.startsWith("public.")) {
      throw new Error(`Unsupported migration snapshot table: ${qualifiedName}`);
    }

    const columns: TableShape["columns"] = {};
    for (const [name, column] of Object.entries(table.columns)) {
      columns[name] = {
        type: normalizeSnapshotType(column.type),
        notNull: column.notNull,
      };
    }

    const constraints: TableShape["constraints"] = {};
    for (const name of Object.keys(table.compositePrimaryKeys ?? {})) {
      constraints[name] = "p";
    }
    if (
      !Object.keys(table.compositePrimaryKeys ?? {}).length &&
      Object.values(table.columns).some((column) => column.primaryKey)
    ) {
      constraints[`${table.name}_pkey`] = "p";
    }
    for (const name of Object.keys(table.foreignKeys ?? {})) {
      constraints[name] = "f";
    }
    for (const name of Object.keys(table.uniqueConstraints ?? {})) {
      constraints[name] = "u";
    }
    for (const name of Object.keys(table.checkConstraints ?? {})) {
      constraints[name] = "c";
    }

    shape[table.name] = {
      columns,
      constraints,
      indexes: Object.keys(table.indexes ?? {}).sort(),
    };
  }

  return shape;
}

/** Use Drizzle's own file reader so journal hashes match `drizzle-kit migrate`. */
export function loadMigrationPlan(): MigrationPlanEntry[] {
  const migrationFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle");
  const journal = JSON.parse(
    readFileSync(resolve(migrationFolder, "meta/_journal.json"), "utf8"),
  ) as Journal;
  const files = readMigrationFiles({ migrationsFolder: migrationFolder });

  if (!Array.isArray(journal.entries) || journal.entries.length !== files.length) {
    throw new Error("Checked-in Drizzle journal and migration files do not match");
  }

  return journal.entries.map((entry, index) => {
    if (
      entry.idx !== index ||
      !Number.isSafeInteger(entry.when) ||
      (index > 0 && entry.when <= journal.entries[index - 1].when)
    ) {
      throw new Error(`Invalid Drizzle journal entry at position ${index}`);
    }

    const snapshot = JSON.parse(
      readFileSync(resolve(migrationFolder, `meta/${entry.tag.split("_")[0]}_snapshot.json`), "utf8"),
    ) as Snapshot;
    if (!snapshot.tables || typeof snapshot.tables !== "object") {
      throw new Error(`Invalid Drizzle snapshot for ${entry.tag}`);
    }
    const publishedShape = snapshotShape(snapshot);
    let variants = [publishedShape];

    // The committed 0005 snapshot included two earlier `drizzle-kit push`
    // changes that its committed SQL did not create. 0006 repairs both with
    // IF NOT EXISTS. Either change may also have been pushed independently.
    if (entry.tag === "0005_premium_speed") {
      if (!publishedShape.feedback || !publishedShape.stories?.columns.uses_own_api_key) {
        throw new Error("Historical 0005 snapshot exception no longer matches the files");
      }
      variants = [];
      for (const includeFeedback of [false, true]) {
        for (const includeOwnKeyColumn of [false, true]) {
          const variant = structuredClone(publishedShape);
          if (!includeFeedback) delete variant.feedback;
          if (!includeOwnKeyColumn) delete variant.stories.columns.uses_own_api_key;
          variants.push(variant);
        }
      }
    }

    return {
      tag: entry.tag,
      when: entry.when,
      hash: files[index].hash,
      variants,
    };
  });
}

function compareShapes(expected: SchemaShape, actual: SchemaShape): string[] {
  const issues: string[] = [];

  for (const tableName of Object.keys(expected).sort()) {
    const wanted = expected[tableName];
    const found = actual[tableName];
    if (!found) {
      issues.push(`public.${tableName} table is missing`);
      continue;
    }

    for (const columnName of Object.keys(wanted.columns).sort()) {
      const expectedColumn = wanted.columns[columnName];
      const actualColumn = found.columns[columnName];
      if (!actualColumn) {
        issues.push(`public.${tableName}.${columnName} is missing`);
      } else if (
        actualColumn.type !== expectedColumn.type ||
        actualColumn.notNull !== expectedColumn.notNull
      ) {
        issues.push(
          `public.${tableName}.${columnName} has ${actualColumn.type}${actualColumn.notNull ? " NOT NULL" : " nullable"}; expected ${expectedColumn.type}${expectedColumn.notNull ? " NOT NULL" : " nullable"}`,
        );
      }
    }
    for (const columnName of Object.keys(found.columns).sort()) {
      if (!wanted.columns[columnName]) {
        issues.push(`public.${tableName}.${columnName} is unexpected`);
      }
    }

    for (const [name, kind] of Object.entries(wanted.constraints)) {
      if (found.constraints[name] !== kind) {
        issues.push(`public.${tableName} constraint ${name} is missing or changed`);
      }
    }
    for (const name of Object.keys(found.constraints)) {
      if (!wanted.constraints[name]) {
        issues.push(`public.${tableName} constraint ${name} is unexpected`);
      }
    }
    for (const name of wanted.indexes) {
      if (!found.indexes.includes(name)) {
        issues.push(`public.${tableName} index ${name} is missing`);
      }
    }
    for (const name of found.indexes) {
      if (!wanted.indexes.includes(name)) {
        issues.push(`public.${tableName} index ${name} is unexpected`);
      }
    }
  }

  for (const tableName of Object.keys(actual).sort()) {
    if (!expected[tableName]) issues.push(`public.${tableName} table is unexpected`);
  }

  return issues;
}

function conciseIssues(issues: string[]): string {
  const shown = issues.slice(0, 12).join("; ");
  return issues.length > 12 ? `${shown}; and ${issues.length - 12} more differences` : shown;
}

const earliestSafeBaseline = 5;

function canOfferBaseline(plan: MigrationPlanEntry[], index: number): boolean {
  const tag = plan[index]?.tag;
  const migrationNumber = tag && /^(\d{4})_/.exec(tag)?.[1];
  return index >= earliestSafeBaseline && Number(migrationNumber) >= earliestSafeBaseline;
}

function pendingMigration0006(plan: MigrationPlanEntry[], appliedCount: number): boolean {
  return plan.slice(appliedCount).some((entry) => entry.tag === "0006_loose_midnight");
}

function duplicatePagesMessage(groups: DatabaseState["duplicatePageGroups"]): string {
  const examples = groups.slice(0, 3).map(
    ({ storyId, pageNumber, count }) =>
      `story ${storyId}, page ${pageNumber} (${count} rows)`,
  ).join("; ");
  return `Duplicate (story_id, page_number) rows in public.pages would make migration 0006's unique index fail: ${examples}. Renumber or remove duplicates after reviewing the affected pages, then rerun this read-only preflight.`;
}

function orphanActiveStoriesMessage(count: number): string {
  return `${count} conversation${count === 1 ? "" : "s"} have active_story_id values that reference missing stories; migration 0006's foreign key would fail. Review and repair those conversations or restore their stories, then rerun this read-only preflight.`;
}

function pending0006DataIssues(state: DatabaseState): string[] {
  const issues: string[] = [];
  if (state.duplicatePageGroups.length) {
    issues.push(duplicatePagesMessage(state.duplicatePageGroups));
  }
  if (state.orphanActiveStoryCount > 0) {
    issues.push(orphanActiveStoriesMessage(state.orphanActiveStoryCount));
  }
  return issues;
}

export function assessMigrationPreflight(
  plan: MigrationPlanEntry[],
  state: DatabaseState,
): PreflightAssessment {
  if (!plan.length) {
    return { ok: false, message: "No checked-in Drizzle migrations found", pending: 0, baselineCandidates: [] };
  }
  if (!state.journalExists && state.journalRows.length) {
    return { ok: false, message: "Migration journal rows were reported without a journal table", pending: plan.length, baselineCandidates: [] };
  }

  if (!state.journalRows.length) {
    if (!Object.keys(state.schema).length) {
      return {
        ok: true,
        message: `Migration preflight passed: database is empty; ${plan.length} migration(s) pending.`,
        pending: plan.length,
        baselineCandidates: [],
      };
    }

    const shapeMatches = plan
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.variants.some((variant) => !compareShapes(variant, state.schema).length));
    const pendingDataIssues = pending0006DataIssues(state);
    const baselineCandidates = shapeMatches
      .filter(({ index }) => canOfferBaseline(plan, index))
      .filter(({ index }) =>
        !pendingDataIssues.length || !pendingMigration0006(plan, index + 1),
      )
      .map(({ entry }) => entry.tag);
    let guidance: string;
    if (baselineCandidates.length === 1) {
      guidance = ` Schema matches ${baselineCandidates[0]}; after a backup and schema review, generate a manual baseline with: node --import tsx scripts/check-migration-preflight.ts --baseline-sql=${baselineCandidates[0]}`;
    } else if (
      pendingDataIssues.length &&
      shapeMatches.some(({ index }) =>
        canOfferBaseline(plan, index) && pendingMigration0006(plan, index + 1),
      )
    ) {
      guidance = ` ${pendingDataIssues.join(" ")}`;
    } else if (baselineCandidates.length > 1) {
      guidance = " Schema matches multiple migration snapshots; review the history and choose a baseline manually.";
    } else if (shapeMatches.length && shapeMatches.every(({ index }) => !canOfferBaseline(plan, index))) {
      guidance = " Schema matches only an early migration. Baseline SQL is unavailable for 0000–0004 because subsequent migrations need data review; reconcile to a supported shape first.";
    } else {
      guidance = " Schema does not exactly match a known migration; reconcile it before creating journal rows.";
    }
    return {
      ok: false,
      message: `Existing public tables have no Drizzle migration history. Running db:migrate here could replay 0000 and fail.${guidance}`,
      pending: plan.length,
      baselineCandidates,
    };
  }

  for (const [index, row] of state.journalRows.entries()) {
    const expected = plan[index];
    if (!expected) {
      return {
        ok: false,
        message: `Drizzle journal has ${state.journalRows.length} row(s), more than the ${plan.length} checked-in migrations. Stop deployment and inspect the database.`,
        pending: 0,
        baselineCandidates: [],
      };
    }
    if (row.createdAt !== expected.when || row.hash !== expected.hash) {
      return {
        ok: false,
        message: `Drizzle journal row ${index + 1} does not match ${expected.tag} (${row.createdAt === expected.when ? "SQL hash" : "timestamp"} differs). Historical SQL may have changed or this database has an incomplete baseline. Stop deployment and inspect the journal.`,
        pending: plan.length - index,
        baselineCandidates: [],
      };
    }
  }

  const lastIndex = state.journalRows.length - 1;
  const lastApplied = plan[lastIndex];
  const variantIssues = lastApplied.variants.map((variant) => compareShapes(variant, state.schema));
  if (!variantIssues.some((issues) => issues.length === 0)) {
    const nearest = variantIssues.sort((a, b) => a.length - b.length)[0];
    return {
      ok: false,
      message: `Public schema differs from journaled ${lastApplied.tag}: ${conciseIssues(nearest)}. Stop deployment and reconcile schema drift.`,
      pending: plan.length - state.journalRows.length,
      lastApplied: lastApplied.tag,
      baselineCandidates: [],
    };
  }

  const pendingDataIssues = pendingMigration0006(plan, state.journalRows.length)
    ? pending0006DataIssues(state)
    : [];
  if (pendingDataIssues.length) {
    return {
      ok: false,
      message: pendingDataIssues.join(" "),
      pending: plan.length - state.journalRows.length,
      lastApplied: lastApplied.tag,
      baselineCandidates: [],
    };
  }

  const pending = plan.length - state.journalRows.length;
  return {
    ok: true,
    message: `Migration preflight passed: ${lastApplied.tag} is journaled with matching SQL and schema; ${pending} migration(s) pending.`,
    pending,
    lastApplied: lastApplied.tag,
    baselineCandidates: [],
  };
}

/** Produce SQL for an operator to review and run; this function never executes it. */
export function buildBaselineSql(plan: MigrationPlanEntry[], tag: string): string {
  const index = plan.findIndex((entry) => entry.tag === tag);
  if (index < 0) throw new Error(`Unknown migration tag: ${tag}`);
  if (!canOfferBaseline(plan, index)) {
    throw new Error(`Baseline SQL is unavailable before migration 0005: ${tag} needs data review before later migrations can run`);
  }
  const entries = plan.slice(0, index + 1);
  for (const entry of entries) {
    if (!/^[a-f0-9]{64}$/.test(entry.hash) || !Number.isSafeInteger(entry.when)) {
      throw new Error(`Invalid checked-in migration metadata for ${entry.tag}`);
    }
  }

  const values = entries.map((entry) => `  ('${entry.hash}', ${entry.when})`).join(",\n");
  return `-- REVIEW BEFORE EXECUTION. This records already-applied migrations; it never applies schema changes.
-- Use only after a database backup and a full review of tables, columns, constraints, indexes, and data.
BEGIN;
CREATE SCHEMA IF NOT EXISTS drizzle;
CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
  id serial PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
);
DO $baseline$
BEGIN
  IF EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations) THEN
    RAISE EXCEPTION 'Refusing to baseline a nonempty Drizzle migration journal';
  END IF;
END
$baseline$;
INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES
${values};
COMMIT;\n`;
}

export async function inspectDatabase(databaseUrl: string): Promise<DatabaseState> {
  const pool = new Pool(createPostgresPoolConfig(databaseUrl));
  try {
    const client = await pool.connect();
    try {
      // Inspect one consistent state; never write from the preflight command.
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        const tableRows = (await client.query<{ table_name: string }>(`SELECT c.relname AS table_name
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`)).rows;
        const columnRows = (await client.query<{
          table_name: string; column_name: string; data_type: string; not_null: boolean;
        }>(`SELECT c.relname AS table_name, a.attname AS column_name,
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
            a.attnotnull AS not_null
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
            AND a.attnum > 0 AND NOT a.attisdropped`)).rows;
        const constraintRows = (await client.query<{
          table_name: string; constraint_name: string; constraint_type: string;
        }>(`SELECT c.relname AS table_name, co.conname AS constraint_name,
            co.contype AS constraint_type
          FROM pg_catalog.pg_constraint co
          JOIN pg_catalog.pg_class c ON c.oid = co.conrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
            AND co.contype IN ('p', 'u', 'f', 'c')`)).rows;
        const indexRows = (await client.query<{
          table_name: string; index_name: string;
        }>(`SELECT t.relname AS table_name, i.relname AS index_name
          FROM pg_catalog.pg_index ix
          JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
          JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
          LEFT JOIN pg_catalog.pg_constraint co ON co.conindid = i.oid
            AND co.contype IN ('p', 'u', 'x')
          WHERE n.nspname = 'public' AND t.relkind IN ('r', 'p') AND co.oid IS NULL`)).rows;
        const journalTableRows = (await client.query<{ journal_exists: boolean }>(
          "SELECT pg_catalog.to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS journal_exists",
        )).rows;

        const schema: SchemaShape = {};
        for (const row of tableRows) {
          schema[row.table_name] = { columns: {}, constraints: {}, indexes: [] };
        }
        for (const row of columnRows) {
          schema[row.table_name].columns[row.column_name] = {
            type: row.data_type,
            notNull: row.not_null,
          };
        }
        for (const row of constraintRows) {
          schema[row.table_name].constraints[row.constraint_name] = row.constraint_type;
        }
        for (const row of indexRows) {
          schema[row.table_name].indexes.push(row.index_name);
        }
        for (const table of Object.values(schema)) table.indexes.sort();

        const duplicatePageGroups: DatabaseState["duplicatePageGroups"] = [];
        if (schema.pages?.columns.story_id && schema.pages.columns.page_number) {
          const rows = (await client.query<{
            story_id: string; page_number: number; duplicate_count: number;
          }>(`SELECT story_id::text AS story_id, page_number,
              COUNT(*)::integer AS duplicate_count
            FROM public.pages
            GROUP BY story_id, page_number
            HAVING COUNT(*) > 1
            ORDER BY duplicate_count DESC, story_id, page_number
            LIMIT 5`)).rows;
          for (const row of rows) {
            duplicatePageGroups.push({
              storyId: row.story_id,
              pageNumber: Number(row.page_number),
              count: Number(row.duplicate_count),
            });
          }
        }

        let orphanActiveStoryCount = 0;
        if (schema.conversations?.columns.active_story_id && schema.stories?.columns.id) {
          const rows = (await client.query<{ orphan_count: number }>(
            `SELECT COUNT(*)::integer AS orphan_count
            FROM public.conversations c
            LEFT JOIN public.stories s ON s.id = c.active_story_id
            WHERE c.active_story_id IS NOT NULL AND s.id IS NULL`,
          )).rows;
          orphanActiveStoryCount = Number(rows[0]?.orphan_count ?? 0);
        }

        const journalExists = journalTableRows[0]?.journal_exists === true;
        const journalRows = journalExists
          ? (await client.query<{ hash: string; created_at: string | number }>(
            "SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at, id",
          )).rows.map((row) => ({ hash: row.hash, createdAt: Number(row.created_at) }))
          : [];

        await client.query("COMMIT");
        return { journalExists, journalRows, schema, duplicatePageGroups, orphanActiveStoryCount };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function main() {
  const arg = process.argv[2];
  if (process.argv.length > 3 || (arg && !arg.startsWith("--baseline-sql="))) {
    throw new Error("Usage: node --import tsx scripts/check-migration-preflight.ts [--baseline-sql=TAG]");
  }

  await import("../envConfig");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for migration preflight");

  const plan = loadMigrationPlan();
  const state = await inspectDatabase(databaseUrl);
  const assessment = assessMigrationPreflight(plan, state);

  if (arg) {
    const tag = arg.slice("--baseline-sql=".length);
    if (state.journalRows.length || !assessment.baselineCandidates.includes(tag)) {
      throw new Error(
        `Cannot generate baseline SQL for ${tag}. The live schema must exactly match that migration, with an empty or absent journal. ${assessment.message}`,
      );
    }
    console.log(buildBaselineSql(plan, tag));
    return;
  }

  if (!assessment.ok) throw new Error(assessment.message);
  console.log(assessment.message);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(`Migration preflight blocked: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
