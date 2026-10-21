import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({
  select: vi.fn(), insert: vi.fn(), update: vi.fn(),
}));

// Chainable drizzle query-builder stub
function chain(result: any) {
  const c: any = {};
  for (const m of ["from", "where", "limit", "set", "values", "returning", "onConflictDoUpdate", "onConflictDoNothing"]) c[m] = vi.fn(() => c);
  c.then = (res: any) => Promise.resolve(result).then(res); // awaitable
  return c;
}

vi.mock("@/lib/db", () => ({
  db: {
    select: (...a: any[]) => h.select(...a),
    insert: (...a: any[]) => h.insert(...a),
    update: (...a: any[]) => h.update(...a),
  },
}));

import {
  completeConversationForGeneration,
  failConversationForGeneration,
  getOrCreateConversation,
} from "@/lib/db-actions";

const dialect = new PgDialect();

beforeEach(() => {
  h.select.mockReset(); h.insert.mockReset(); h.update.mockReset();
});

describe("getOrCreateConversation", () => {
  it("creates a channel conversation in collecting state", async () => {
    const created = { id: "c2", phoneNumber: "+2", state: "collecting", collected: {} };
    h.insert.mockReturnValue(chain([created])); // returning() -> [created]
    const r = await getOrCreateConversation("+2", "whatsapp");
    expect(r).toEqual(created);
    expect(h.insert).toHaveBeenCalledOnce();
  });

  it("returns an existing conversation without updating its timestamp", async () => {
    const existing = { id: "c2", phoneNumber: "+2", state: "confirming", collected: {} };
    h.insert.mockReturnValue(chain([]));
    h.select.mockReturnValue(chain([existing]));

    const r = await getOrCreateConversation("+2", "whatsapp");
    expect(r).toEqual(existing);
    expect(h.select).toHaveBeenCalledOnce();
    expect(h.update).not.toHaveBeenCalled();
  });
});

describe("generation conversation checkpoints", () => {
  const job = {
    recipientAddress: "+15551230000",
    source: "voice",
    idempotencyKey: "voice-call:CA123",
    prompt: "The dragon visits Mars",
  };

  it("only completes the draft that submitted this generation request", async () => {
    const query = chain([{ id: "conversation-1" }]);
    h.update.mockReturnValue(query);

    const changed = await completeConversationForGeneration(job, "story-1");

    expect(changed).toBe(true);
    expect(query.set).toHaveBeenCalledWith(
      expect.objectContaining({ state: "done", activeStoryId: "story-1" }),
    );
    const where = dialect.sqlToQuery(query.where.mock.calls[0][0]);
    expect(where.sql).toContain("generationRequestKey");
    expect(where.params).toContain("generating");
    expect(where.params).toContain("voice-call:CA123");
  });

  it("does not treat a newer draft as a failed generation", async () => {
    const query = chain([]);
    h.update.mockReturnValue(query);

    const changed = await failConversationForGeneration(job);

    expect(changed).toBe(false);
    expect(query.set).toHaveBeenCalledWith(expect.objectContaining({ state: "confirming" }));
    const sql = dialect.sqlToQuery(query.where.mock.calls[0][0]).sql;
    expect(sql).toContain("generationRequestKey");
  });
});
