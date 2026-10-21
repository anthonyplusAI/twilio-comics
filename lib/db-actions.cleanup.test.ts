import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({
  delete: vi.fn(),
  where: vi.fn(),
  returning: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { delete: h.delete },
}));

import { deleteBlankContinuationPage } from "@/lib/db-actions";

const pageId = "11111111-1111-4111-8111-111111111111";
const storyId = "22222222-2222-4222-8222-222222222222";
const userId = "phone-user";
const dialect = new PgDialect();

beforeEach(() => {
  vi.resetAllMocks();
  h.where.mockReturnValue({ returning: h.returning });
  h.delete.mockReturnValue({ where: h.where });
});

describe("failed continuation page cleanup", () => {
  it("atomically guards the exact blank page, failed job, story, and owner", async () => {
    h.returning.mockResolvedValue([{ id: pageId }]);

    const deleted = await deleteBlankContinuationPage({ pageId, storyId, userId });

    expect(deleted).toBe(true);
    const where = dialect.sqlToQuery(h.where.mock.calls[0][0]);
    const sql = where.sql.toLowerCase();
    expect(sql).toContain('"pages"."id" =');
    expect(sql).toContain('"pages"."story_id" =');
    expect(sql).toContain('"pages"."page_number" >');
    expect(sql).toContain('"pages"."generated_image_url" is null');
    expect(sql).toContain('"stories"."user_id" =');
    expect(sql).toContain('"generation_jobs"."status" =');
    expect(sql).toContain('"generation_jobs"."target_story_id" =');
    expect(where.params).toEqual(expect.arrayContaining([pageId, storyId, userId, "failed", 1]));
  });

  it("leaves generated or unrelated pages untouched when no guarded row matches", async () => {
    h.returning.mockResolvedValue([]);

    const deleted = await deleteBlankContinuationPage({ pageId, storyId, userId });

    expect(deleted).toBe(false);
  });
});
