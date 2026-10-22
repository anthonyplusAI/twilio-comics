import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assessMigrationPreflight,
  buildBaselineSql,
  inspectDatabase,
  loadMigrationPlan,
  type DatabaseState,
  type MigrationPlanEntry,
  type SchemaShape,
} from "../scripts/check-migration-preflight";

afterEach(() => vi.restoreAllMocks());

describe("live PostgreSQL inspection", () => {
  it("uses one read-only snapshot and closes the connection", async () => {
    const commands: string[] = [];
    const release = vi.fn();
    const query = vi.fn(async (text: string) => {
      commands.push(text);
      return { rows: text.includes("to_regclass") ? [{ journal_exists: false }] : [] };
    });
    vi.spyOn(Pool.prototype, "connect").mockResolvedValue({ query, release } as never);
    const end = vi.spyOn(Pool.prototype, "end").mockResolvedValue();

    const state = await inspectDatabase(
      "postgresql://migrator:secret@localhost/comics?sslmode=disable",
    );

    expect(state).toEqual({
      journalExists: false,
      journalRows: [],
      schema: {},
      duplicatePageGroups: [],
      orphanActiveStoryCount: 0,
    });
    expect(commands[0]).toMatch(/BEGIN.*READ ONLY/i);
    expect(commands.at(-1)).toBe("COMMIT");
    expect(release).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it("closes the pool if connecting fails", async () => {
    vi.spyOn(Pool.prototype, "connect").mockRejectedValue(new Error("database unavailable"));
    const end = vi.spyOn(Pool.prototype, "end").mockResolvedValue();

    await expect(inspectDatabase(
      "postgresql://migrator:secret@localhost/comics?sslmode=disable",
    )).rejects.toThrow("database unavailable");
    expect(end).toHaveBeenCalledOnce();
  });
});

const initialShape: SchemaShape = {
  stories: {
    columns: {
      id: { type: "uuid", notNull: true },
      title: { type: "text", notNull: true },
    },
    constraints: { stories_pkey: "p" },
    indexes: [],
  },
};

const laterShape: SchemaShape = {
  stories: {
    columns: {
      id: { type: "uuid", notNull: true },
      title: { type: "text", notNull: true },
      slug: { type: "text", notNull: true },
    },
    constraints: { stories_pkey: "p", stories_slug_unique: "u" },
    indexes: [],
  },
};

const migrations: MigrationPlanEntry[] = [
  { tag: "0000_initial", when: 1000, hash: "a".repeat(64), variants: [initialShape] },
  { tag: "0001_slug", when: 2000, hash: "b".repeat(64), variants: [laterShape] },
];

function state(overrides: Partial<DatabaseState> = {}): DatabaseState {
  return {
    journalExists: false,
    journalRows: [],
    schema: {},
    duplicatePageGroups: [],
    orphanActiveStoryCount: 0,
    ...overrides,
  };
}

describe("migration preflight", () => {
  it("allows first migration only on an empty database", () => {
    const result = assessMigrationPreflight(migrations, state());
    expect(result.ok).toBe(true);
    expect(result.pending).toBe(2);
  });

  it("blocks a push-managed database at an early migration without offering unsafe baseline SQL", () => {
    const result = assessMigrationPreflight(
      migrations,
      state({ schema: initialShape }),
    );
    expect(result.ok).toBe(false);
    expect(result.baselineCandidates).toEqual([]);
    expect(result.message).toMatch(/no Drizzle migration history/i);
    expect(result.message).toMatch(/0000–0004/);
  });

  it("accepts a fully matching journal prefix and counts pending migrations", () => {
    const result = assessMigrationPreflight(
      migrations,
      state({
        journalExists: true,
        journalRows: [{ hash: migrations[0].hash, createdAt: 1000 }],
        schema: initialShape,
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.lastApplied).toBe("0000_initial");
    expect(result.pending).toBe(1);
  });

  it("blocks edited historical SQL even when migration time matches", () => {
    const result = assessMigrationPreflight(
      migrations,
      state({
        journalExists: true,
        journalRows: [{ hash: "c".repeat(64), createdAt: 1000 }],
        schema: initialShape,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/hash/i);
  });

  it("blocks an incomplete journal prefix", () => {
    const result = assessMigrationPreflight(
      migrations,
      state({
        journalExists: true,
        journalRows: [{ hash: migrations[1].hash, createdAt: 2000 }],
        schema: laterShape,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/journal/i);
  });

  it("blocks missing columns, unexpected columns, constraints, and indexes", () => {
    const drifted: SchemaShape = structuredClone(initialShape);
    delete drifted.stories.columns.title;
    drifted.stories.columns.unreviewed = { type: "text", notNull: false };
    drifted.stories.constraints = {};
    drifted.stories.indexes = ["unreviewed_idx"];

    const result = assessMigrationPreflight(
      migrations,
      state({
        journalExists: true,
        journalRows: [{ hash: migrations[0].hash, createdAt: 1000 }],
        schema: drifted,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("stories.title");
    expect(result.message).toContain("stories.unreviewed");
    expect(result.message).toContain("stories_pkey");
    expect(result.message).toContain("unreviewed_idx");
  });

  it("blocks a changed column type or nullability", () => {
    const drifted: SchemaShape = structuredClone(initialShape);
    drifted.stories.columns.title = { type: "integer", notNull: false };

    const result = assessMigrationPreflight(
      migrations,
      state({
        journalExists: true,
        journalRows: [{ hash: migrations[0].hash, createdAt: 1000 }],
        schema: drifted,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("integer nullable");
    expect(result.message).toContain("text NOT NULL");
  });

  it("blocks a table that was partially created by a later migration", () => {
    const result = assessMigrationPreflight(
      migrations,
      state({
        journalExists: true,
        journalRows: [{ hash: migrations[0].hash, createdAt: 1000 }],
        schema: { ...initialShape, stray: { columns: {}, constraints: {}, indexes: [] } },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("stray");
  });

  it("generates a guarded manual baseline from 0005 with Drizzle's hashes and timestamps", () => {
    const plan = loadMigrationPlan();
    const sql = buildBaselineSql(plan, "0005_premium_speed");
    expect(sql).toContain("BEGIN;");
    expect(sql).toContain("IF EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations)");
    for (const entry of plan.slice(0, 6)) {
      expect(sql).toContain(`('${entry.hash}', ${entry.when})`);
    }
    expect(sql).not.toMatch(/DROP TABLE/i);
  });

  it("refuses baseline SQL for migrations 0000–0004", () => {
    const plan = loadMigrationPlan();
    for (const entry of plan.slice(0, 5)) {
      expect(() => buildBaselineSql(plan, entry.tag)).toThrow(/before migration 0005/);
    }
  });

  it("accepts all four 0005 combinations of feedback and uses_own_api_key", () => {
    const plan = loadMigrationPlan();
    const migration = plan.find((entry) => entry.tag === "0005_premium_speed");
    expect(migration?.variants).toHaveLength(4);
    expect(migration?.variants.map((variant) => [
      !!variant.feedback,
      !!variant.stories.columns.uses_own_api_key,
    ])).toEqual([
      [false, false],
      [false, true],
      [true, false],
      [true, true],
    ]);

    const through0005 = plan.slice(0, 6);
    const journalRows = through0005.map((entry) => ({
      hash: entry.hash,
      createdAt: entry.when,
    }));
    for (const schema of migration?.variants ?? []) {
      const result = assessMigrationPreflight(
        plan,
        state({ journalExists: true, journalRows, schema }),
      );
      expect(result.ok).toBe(true);
      expect(result.pending).toBe(plan.length - 6);

      const unjournaled = assessMigrationPreflight(plan, state({ schema }));
      expect(unjournaled.ok).toBe(false);
      expect(unjournaled.baselineCandidates).toEqual(["0005_premium_speed"]);
    }
  });

  it("blocks migration 0006 when pages contain duplicate story and page numbers", () => {
    const plan = loadMigrationPlan();
    const migration = plan.find((entry) => entry.tag === "0005_premium_speed");
    const journalRows = plan.slice(0, 6).map((entry) => ({
      hash: entry.hash,
      createdAt: entry.when,
    }));
    const duplicatePageGroups = [
      { storyId: "f3e5b514-b326-4c40-a7a6-e864554150df", pageNumber: 2, count: 2 },
    ];
    const journaled = assessMigrationPreflight(
      plan,
      state({
        journalExists: true,
        journalRows,
        schema: migration!.variants[0],
        duplicatePageGroups,
      }),
    );
    expect(journaled.ok).toBe(false);
    expect(journaled.message).toMatch(/duplicate.*story_id.*page_number/i);
    expect(journaled.message).toContain(duplicatePageGroups[0].storyId);
    expect(journaled.message).toMatch(/renumber or remove duplicates/i);

    const unjournaled = assessMigrationPreflight(
      plan,
      state({ schema: migration!.variants[0], duplicatePageGroups }),
    );
    expect(unjournaled.ok).toBe(false);
    expect(unjournaled.baselineCandidates).toEqual([]);
    expect(unjournaled.message).toMatch(/duplicate.*story_id.*page_number/i);
  });

  it("blocks migration 0006 and an unjournaled baseline when conversations reference deleted stories", () => {
    const plan = loadMigrationPlan();
    const migration = plan.find((entry) => entry.tag === "0005_premium_speed");
    const journalRows = plan.slice(0, 6).map((entry) => ({
      hash: entry.hash,
      createdAt: entry.when,
    }));

    const journaled = assessMigrationPreflight(
      plan,
      state({
        journalExists: true,
        journalRows,
        schema: migration!.variants[0],
        orphanActiveStoryCount: 2,
      }),
    );
    expect(journaled.ok).toBe(false);
    expect(journaled.message).toMatch(/2 conversations.*active_story_id.*missing stories/i);
    expect(journaled.message).toMatch(/review and repair/i);

    const unjournaled = assessMigrationPreflight(
      plan,
      state({ schema: migration!.variants[0], orphanActiveStoryCount: 2 }),
    );
    expect(unjournaled.ok).toBe(false);
    expect(unjournaled.baselineCandidates).toEqual([]);
    expect(unjournaled.message).toMatch(/active_story_id.*missing stories/i);
  });
});
