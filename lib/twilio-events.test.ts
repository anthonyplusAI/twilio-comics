import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const h = vi.hoisted(() => ({
  insert: vi.fn(),
  select: vi.fn(),
  update: vi.fn(),
  execute: vi.fn(),
  sendInboundMessage: vi.fn(),
  recordActivityEvent: vi.fn(),
  insertedValues: null as Record<string, unknown> | null,
}));

vi.mock("@/lib/db", () => ({
  db: {
    insert: h.insert,
    select: h.select,
    update: h.update,
    execute: h.execute,
  },
}));
vi.mock("@/lib/generation-queue", () => ({
  sendInboundMessage: h.sendInboundMessage,
}));
vi.mock("@/lib/activity-events", () => ({ recordActivityEvent: h.recordActivityEvent }));

import {
  claimConversationLease,
  checkpointInboundTurn,
  completeInboundOptedOutReply,
  completeInboundWithoutReply,
  getInboundMessagePosition,
  recordInboundMessage,
  recoverPendingInboundMessages,
  recordAgentMessageStatus,
} from "@/lib/twilio-events";

const dialect = new PgDialect();

const input = {
  messageSid: "SM123",
  channel: "sms" as const,
  fromAddress: "+15551112222",
  toAddress: "+15553334444",
  body: "Robot detective",
  mediaUrls: ["https://api.twilio.com/photo"],
  mediaContentTypes: ["image/jpeg"],
};

function setInsertResult(rows: unknown[]) {
  h.insert.mockReturnValue({
    values: (values: Record<string, unknown>) => {
      h.insertedValues = values;
      return {
        onConflictDoNothing: () => ({ returning: async () => rows }),
      };
    },
  });
}

function setExistingRow(row: Record<string, unknown>) {
  h.select.mockReturnValue({
    from: () => ({
      where: () => ({ limit: async () => [row] }),
    }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  h.insertedValues = null;
  setInsertResult([{ messageSid: "SM123" }]);
  h.execute.mockResolvedValue({ rows: [{ message_sid: "SM123" }] });
  h.sendInboundMessage.mockResolvedValue(undefined);
  h.recordActivityEvent.mockResolvedValue(undefined);
});

describe("durable Twilio receipts", () => {
  it("atomically completes a rejected reply and records Twilio opt-out without clearing submission", async () => {
    h.execute.mockResolvedValueOnce({ rows: [{ message_sid: "SM123" }] });

    await expect(completeInboundOptedOutReply("SM123")).resolves.toBeUndefined();

    const query = dialect.sqlToQuery(h.execute.mock.calls[0][0] as SQL);
    expect(query.sql).toMatch(/UPDATE twilio_inbound_messages[\s\S]*SET status = 'completed'/i);
    expect(query.sql).toMatch(/status = 'reply_pending'/i);
    expect(query.sql).toMatch(/outbound_sid IS NULL/i);
    expect(query.sql).toMatch(/reply_body <> ''/i);
    expect(query.sql).not.toMatch(/submission\s*=/i);
    expect(query.sql).toMatch(/INSERT INTO activity_events[\s\S]*message\.reply\.suppressed/i);
    expect(query.sql).toContain("recipient_opted_out");
    expect(query.sql).toContain("21610");
    expect(query.params).toEqual(expect.arrayContaining([
      "SM123", "message:SM123:reply:suppressed",
    ]));
  });

  it("accepts a retry after an opt-out receipt was already completed", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: "completed", outbound_sid: null }] });

    await expect(completeInboundOptedOutReply("SM123")).resolves.toBeUndefined();
  });

  it("refuses to suppress a reply that has no send checkpoint", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: "processing", outbound_sid: null }] });

    await expect(completeInboundOptedOutReply("SM123")).rejects.toThrow(/suppress/i);
  });

  it("atomically completes a checkpointed silent limit denial without a Twilio SID", async () => {
    h.execute.mockResolvedValueOnce({ rows: [{ message_sid: "SM123" }] });

    await expect(completeInboundWithoutReply("SM123")).resolves.toBeUndefined();

    const update = dialect.sqlToQuery(h.execute.mock.calls[0][0] as SQL);
    expect(update.sql).toMatch(/UPDATE twilio_inbound_messages[\s\S]*SET status = 'completed'/i);
    expect(update.sql).toMatch(/status = 'reply_pending'/i);
    expect(update.sql).toMatch(/reply_body = ''/i);
    expect(update.sql).toMatch(/submission IS NULL/i);
    expect(update.sql).toMatch(/outbound_sid IS NULL/i);
    expect(update.params).toContain("SM123");
  });

  it("treats an already completed silent denial as an idempotent retry", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        status: "completed", reply_body: "", submission: null, outbound_sid: null,
      }] });

    await expect(completeInboundWithoutReply("SM123")).resolves.toBeUndefined();
  });

  it("refuses to suppress an ordinary saved reply", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        status: "reply_pending", reply_body: "Tell me your idea", submission: null, outbound_sid: null,
      }] });

    await expect(completeInboundWithoutReply("SM123")).rejects.toThrow(/silent/i);
  });

  it("reports the daily turn position and whether this is the sender's first stored message", async () => {
    const dailyWhere = vi.fn().mockResolvedValue([{ count: 100 }]);
    const firstLimit = vi.fn().mockResolvedValue([{ messageSid: "SM123" }]);
    h.select
      .mockReturnValueOnce({ from: () => ({ where: dailyWhere }) })
      .mockReturnValueOnce({ from: () => ({
        where: () => ({ orderBy: () => ({ limit: firstLimit }) }),
      }) });

    await expect(getInboundMessagePosition({
      ...input,
      createdAt: new Date("2026-10-21T23:59:59.000Z"),
    })).resolves.toEqual({ dailyCount: 100, firstMessage: true });

    expect(dailyWhere).toHaveBeenCalledOnce();
    expect(firstLimit).toHaveBeenCalledWith(1);
  });

  it("atomically completes an agent reply receipt when its callback beats the send response", async () => {
    h.execute.mockResolvedValueOnce({
      rows: [{ channel: "sms", from_address: "+15551112222" }],
    });

    await expect(recordAgentMessageStatus({
      inboundSid: "SM123",
      messageSid: "SMoutbound",
      status: "delivered",
      errorCode: null,
    })).resolves.toBe(true);

    const update = dialect.sqlToQuery(h.execute.mock.calls[0][0] as SQL);
    expect(update.sql).toMatch(/UPDATE twilio_inbound_messages[\s\S]*SET status = 'completed'/i);
    expect(update.sql).toMatch(/status = 'reply_pending' AND outbound_sid IS NULL/i);
    expect(update.sql).toMatch(/status = 'completed' AND outbound_sid =/i);
    expect(update.params).toEqual(expect.arrayContaining(["SM123", "SMoutbound"]));

    expect(h.recordActivityEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: "message:SMoutbound:status:delivered",
      kind: "message.delivery",
      direction: "outbound",
      address: "+15551112222",
      messageSid: "SMoutbound",
      status: "delivered",
      details: { inReplyTo: "SM123", errorCode: null, purpose: "agent_reply" },
    }));
  });

  it("ignores a callback with a different SID than the saved reply", async () => {
    h.execute.mockResolvedValueOnce({ rows: [] });

    await expect(recordAgentMessageStatus({
      inboundSid: "SM123",
      messageSid: "SMother",
      status: "failed",
      errorCode: "30008",
    })).resolves.toBe(false);

    expect(h.recordActivityEvent).not.toHaveBeenCalled();
  });

  it("persists the inbound body and media before requesting queue publication", async () => {
    const result = await recordInboundMessage(input);

    expect(result).toEqual({ shouldEnqueue: true });
    expect(h.insertedValues).toMatchObject({
      messageSid: "SM123",
      status: "pending",
      body: "Robot detective",
      mediaUrls: ["https://api.twilio.com/photo"],
      mediaContentTypes: ["image/jpeg"],
    });
  });

  it("allows a duplicate pending receipt to be queued again", async () => {
    setInsertResult([]);
    setExistingRow({
      messageSid: "SM123",
      channel: "sms",
      fromAddress: "+15551112222",
      toAddress: "+15553334444",
      status: "pending",
    });

    await expect(recordInboundMessage(input)).resolves.toEqual({ shouldEnqueue: true });
  });

  it("does not requeue a completed duplicate", async () => {
    setInsertResult([]);
    setExistingRow({
      messageSid: "SM123",
      channel: "sms",
      fromAddress: "+15551112222",
      toAddress: "+15553334444",
      status: "completed",
    });

    await expect(recordInboundMessage(input)).resolves.toEqual({ shouldEnqueue: false });
  });

  it("rejects a conflicting SID with different sender metadata", async () => {
    setInsertResult([]);
    setExistingRow({
      messageSid: "SM123",
      channel: "sms",
      fromAddress: "+15559990000",
      toAddress: "+15553334444",
      status: "pending",
    });

    await expect(recordInboundMessage(input)).rejects.toThrow(/conflict/i);
  });

  it("refuses to checkpoint a turn after losing its conversation lease", async () => {
    h.execute.mockResolvedValue({ rows: [] });

    await expect(checkpointInboundTurn({
      messageSid: "SM123",
      conversationId: "00000000-0000-0000-0000-000000000001",
      leaseOwner: "worker-1",
      state: "confirming",
      collected: { prompt: "Robot detective", style: "noir" },
      activeStoryId: null,
      replyBody: "Reply CREATE to approve.",
      submission: null,
    })).rejects.toThrow(/lease/i);
  });

  it("republishes stale receipt IDs in a bounded recovery batch", async () => {
    const limit = vi.fn().mockResolvedValue([
      { messageSid: "SM-old-1" },
      { messageSid: "SM-old-2" },
    ]);
    h.select.mockReturnValue({
      from: () => ({ where: () => ({ orderBy: () => ({ limit }) }) }),
    });

    await expect(recoverPendingInboundMessages(2)).resolves.toBe(2);

    expect(limit).toHaveBeenCalledWith(2);
    expect(h.sendInboundMessage.mock.calls.map(([sid]) => sid)).toEqual([
      "SM-old-1",
      "SM-old-2",
    ]);
  });

  it("reports a recovery publish failure so Azure retries the sweep", async () => {
    h.select.mockReturnValue({
      from: () => ({
        where: () => ({ orderBy: () => ({ limit: async () => [{ messageSid: "SM-old" }] }) }),
      }),
    });
    h.sendInboundMessage.mockRejectedValue(new Error("Azure Queue unavailable"));

    await expect(recoverPendingInboundMessages()).rejects.toThrow("Azure Queue unavailable");
  });
});

describe("conversation leases", () => {
  it("atomically clears a draft inactive for over 14 days, except while generating", async () => {
    let updateSet: Record<string, unknown> | undefined;
    let updateWhere: SQL | undefined;
    const claimed = { id: "conversation-1", state: "collecting", collected: {}, activeStoryId: null };
    h.update.mockReturnValue({
      set: (values: Record<string, unknown>) => {
        updateSet = values;
        return {
          where: (condition: SQL) => {
            updateWhere = condition;
            return { returning: async () => [claimed] };
          },
        };
      },
    });

    await expect(claimConversationLease("sms", input.fromAddress, "worker-1", 300))
      .resolves.toBe(claimed);

    expect(updateSet).toBeDefined();
    expect(Object.keys(updateSet!)).toEqual(expect.arrayContaining([
      "state", "collected", "activeStoryId", "leaseOwner", "leaseExpiresAt", "updatedAt",
    ]));

    const expression = (key: string) =>
      dialect.sqlToQuery(updateSet![key] as SQL).sql.replace(/\s+/g, " ");
    const staleCondition = /"conversations"\."updated_at" < NOW\(\) - \(\$\d+ \* INTERVAL '1 day'\) AND "conversations"\."state" <> 'generating'/;
    expect(expression("state")).toMatch(staleCondition);
    expect(expression("state")).toContain("THEN 'collecting' ELSE \"conversations\".\"state\" END");
    expect(expression("collected")).toMatch(staleCondition);
    expect(expression("collected")).toContain("THEN '{}'::jsonb ELSE \"conversations\".\"collected\" END");
    expect(expression("activeStoryId")).toMatch(staleCondition);
    expect(expression("activeStoryId")).toContain("THEN NULL ELSE \"conversations\".\"active_story_id\" END");
    expect(dialect.sqlToQuery(updateSet!.state as SQL).params).toContain(14);

    const leasePredicate = dialect.sqlToQuery(updateWhere!).sql.replace(/\s+/g, " ");
    expect(leasePredicate).toContain('"conversations"."lease_expires_at" <= NOW()');
  });
});
