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
  expireConversationForGeneration,
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
    const update = query.set.mock.calls[0][0];
    expect(dialect.sqlToQuery(update.state).sql).toMatch(/newDraftRequestedAt[\s\S]*'collecting'[\s\S]*'done'/);
    expect(dialect.sqlToQuery(update.activeStoryId).sql).toMatch(/newDraftRequestedAt[\s\S]*THEN NULL/);
    const collected = dialect.sqlToQuery(update.collected);
    expect(collected.sql).toContain("photoHandoffResetAt");
    expect(collected.sql).toContain("ignoredCameraReferences");
    expect(collected.sql).toContain("newDraftRequestedAt");
    expect(collected.sql).toContain("generationRequestKey");
    const where = dialect.sqlToQuery(query.where.mock.calls[0][0]);
    expect(where.sql).toContain("generationRequestKey");
    expect(where.params).toContain("generating");
    expect(where.params).toContain("voice-call:CA123");
  });

  it("keeps the SMS restart boundary when an older job finishes", async () => {
    const query = chain([{ id: "conversation-1" }]);
    h.update.mockReturnValue(query);

    await completeConversationForGeneration({ ...job, source: "sms" }, "story-1");

    const collected = dialect.sqlToQuery(query.set.mock.calls[0][0].collected);
    expect(collected.sql).toContain("phoneRestartedAt");
    expect(collected.sql).toContain("phoneRestartedByMessageSid");
    expect(collected.sql).toContain("newDraftRequestedAt");
    expect(collected.sql).not.toContain("ignoredCameraReferences");
  });

  it("does not treat a newer draft as a failed generation", async () => {
    const query = chain([]);
    h.update.mockReturnValue(query);

    const changed = await failConversationForGeneration(job);

    expect(changed).toBe("unchanged");
    expect(dialect.sqlToQuery(query.set.mock.calls[0][0].state).sql)
      .toMatch(/newDraftRequestedAt[\s\S]*'collecting'[\s\S]*'confirming'/);
    const sql = dialect.sqlToQuery(query.where.mock.calls[0][0]).sql;
    expect(sql).toContain("generationRequestKey");
  });

  it("keeps a blocked prompt and photos in collecting until the idea is revised", async () => {
    const query = chain([{ id: "conversation-1" }]);
    h.update.mockReturnValue(query);

    const changed = await failConversationForGeneration(job, { requireRevision: true });

    expect(changed).toBe("restored");
    const update = query.set.mock.calls[0][0];
    expect(dialect.sqlToQuery(update.state).sql).toContain("'collecting'");
    const collected = dialect.sqlToQuery(update.collected);
    expect(collected.sql).toContain("jsonb_build_object");
    expect(collected.sql).toContain("generationRequestKey");
    expect(collected.sql).toContain("blockedPrompt");
    expect(collected.params).toContain(job.prompt);
    const where = dialect.sqlToQuery(query.where.mock.calls[0][0]);
    expect(where.params).toContain("generating");
    expect(where.params).toContain(job.idempotencyKey);
  });

  it("reports a queued NEW after failure so the worker asks for fresh photos", async () => {
    const query = chain([{ id: "conversation-1", freshDraft: true }]);
    h.update.mockReturnValue(query);

    const changed = await failConversationForGeneration(job, { requireRevision: true });

    expect(changed).toBe("new_draft");
    const update = query.set.mock.calls[0][0];
    expect(dialect.sqlToQuery(update.activeStoryId).sql)
      .toMatch(/newDraftRequestedAt[\s\S]*THEN NULL/);
    const collected = dialect.sqlToQuery(update.collected).sql;
    expect(collected).toContain("photoHandoffResetAt");
    expect(collected).toContain("newDraftRequestedAt");
    expect(collected).toContain("blockedPrompt");
    const returning = dialect.sqlToQuery(query.returning.mock.calls[0][0].freshDraft);
    expect(returning.sql).toMatch(/collected.*prompt.*IS NULL/);
  });

  it("clears only the matching expired draft and active story without touching job history", async () => {
    const query = chain([{ id: "conversation-1" }]);
    h.update.mockReturnValue(query);

    const changed = await expireConversationForGeneration(job);

    expect(changed).toBe(true);
    const update = query.set.mock.calls[0][0];
    expect(update.state).toBe("collecting");
    expect(update.activeStoryId).toBeNull();
    expect(dialect.sqlToQuery(update.collected).sql).toContain("photoHandoffResetAt");
    const where = dialect.sqlToQuery(query.where.mock.calls[0][0]);
    expect(where.params).toContain("generating");
    expect(where.params).toContain(job.idempotencyKey);
    expect(where.params).toContain(job.recipientAddress);
    expect(where.params).toContain(job.source);
  });

  it("leaves a newer conversation alone after an expired job", async () => {
    const query = chain([]);
    h.update.mockReturnValue(query);

    const changed = await expireConversationForGeneration(job);

    expect(changed).toBe(false);
    expect(query.where).toHaveBeenCalledOnce();
  });
});
