import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const h = vi.hoisted(() => ({
  insert: vi.fn(),
  select: vi.fn(),
  update: vi.fn(),
  execute: vi.fn(),
  sendInboundMessage: vi.fn(),
  recordActivityEvent: vi.fn(),
  fetchTwilioMessageStatus: vi.fn(),
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
vi.mock("@/lib/twilio", () => ({ fetchTwilioMessageStatus: h.fetchTwilioMessageStatus }));

import {
  claimConversationLease,
  checkpointInboundTurn,
  completeInboundOptedOutReply,
  completeInboundWithoutReply,
  getInboundMessagePosition,
  recordInboundMessage,
  recoverPendingInboundMessages,
  recoverStalledAgentReplies,
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
  h.execute.mockResolvedValue({ rows: [{
    message_sid: "SM123",
    updated_at: new Date("2026-10-01T00:00:02.000Z"),
  }] });
  h.sendInboundMessage.mockResolvedValue(undefined);
  h.recordActivityEvent.mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("stalled SMS agent reply monitoring", () => {
  const candidate = {
    inbound_sid: "SMinbound",
    outbound_sid: "SMoutbound",
    sent_at: new Date(Date.now() - 12 * 60_000),
  };

  it("checks only bounded, saved, stale SMS replies and alerts once for a nonterminal Twilio status", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [candidate] })
      .mockResolvedValueOnce({ rows: [{ id: "alert-id" }] });
    h.fetchTwilioMessageStatus.mockResolvedValue("scheduled");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(recoverStalledAgentReplies(700)).resolves.toEqual({
      checked: 1,
      alerted: 1,
      terminalObserved: 0,
      lookupErrors: 0,
    });

    const candidates = dialect.sqlToQuery(h.execute.mock.calls[0][0] as SQL);
    expect(candidates.sql).toMatch(/FROM twilio_inbound_messages/i);
    expect(candidates.sql).toMatch(/LEFT JOIN activity_events sent_event/i);
    expect(candidates.sql).toMatch(/COALESCE\(sent_event\.occurred_at, receipt\.updated_at\) <=/i);
    expect(candidates.sql).toMatch(/channel = 'sms'/i);
    expect(candidates.sql).toMatch(/status = 'completed'/i);
    expect(candidates.sql).toMatch(/outbound_sid IS NOT NULL/i);
    expect(candidates.sql).toMatch(/updated_at <=/i);
    expect(candidates.sql).toMatch(/created_at >=/i);
    expect(candidates.sql).toMatch(/NOT EXISTS[\s\S]*activity_events/i);
    expect(candidates.params).toContain(600);
    expect(h.fetchTwilioMessageStatus).toHaveBeenCalledExactlyOnceWith("SMoutbound");

    const alert = dialect.sqlToQuery(h.execute.mock.calls[1][0] as SQL);
    expect(alert.sql).toMatch(/INSERT INTO activity_events/i);
    expect(alert.sql).toContain("message.delivery.alert");
    expect(alert.sql).toContain("stalled");
    expect(alert.sql).toContain("ON CONFLICT (event_key) DO NOTHING");
    expect(alert.sql).toMatch(/NOT EXISTS[\s\S]*activity_events/i);
    expect(alert.sql).toMatch(/COALESCE\(sent_event\.occurred_at, receipt\.updated_at\) <=/i);
    expect(alert.params).toContain("message:SMoutbound:stalled");
    expect(alert.params).toContain("scheduled");
    expect(JSON.stringify(alert)).not.toContain(input.fromAddress);
    expect(JSON.stringify(alert)).not.toContain(input.body);
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(input.fromAddress);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(input.body);
    expect(h.sendInboundMessage).not.toHaveBeenCalled();
  });

  it("records a terminal lookup marker without reporting delivery or resending", async () => {
    h.execute
      .mockResolvedValueOnce({ rows: [candidate] })
      .mockResolvedValueOnce({ rows: [{ id: "terminal-id" }] });
    h.fetchTwilioMessageStatus.mockResolvedValue("delivered");

    await expect(recoverStalledAgentReplies()).resolves.toEqual({
      checked: 1,
      alerted: 0,
      terminalObserved: 1,
      lookupErrors: 0,
    });

    const marker = dialect.sqlToQuery(h.execute.mock.calls[1][0] as SQL);
    expect(marker.sql).toContain("message.delivery.audit");
    expect(marker.sql).not.toContain("message.delivery.alert");
    expect(marker.params).toContain("message:SMoutbound:terminal-observed");
    expect(marker.params).toContain("delivered");
    expect(h.sendInboundMessage).not.toHaveBeenCalled();
    expect(h.recordActivityEvent).not.toHaveBeenCalled();
  });

  it("does not retry a failed Twilio lookup or create an alert from an unknown status", async () => {
    h.execute.mockResolvedValueOnce({ rows: [
      candidate,
      { ...candidate, inbound_sid: "SMinbound2", outbound_sid: "SMoutbound2" },
    ] });
    h.fetchTwilioMessageStatus
      .mockRejectedValueOnce(new Error("Twilio unavailable: +15551112222"))
      .mockResolvedValueOnce("future-status");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(recoverStalledAgentReplies(2)).resolves.toEqual({
      checked: 2,
      alerted: 0,
      terminalObserved: 0,
      lookupErrors: 2,
    });

    expect(h.fetchTwilioMessageStatus).toHaveBeenCalledTimes(2);
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.sendInboundMessage).not.toHaveBeenCalled();
    expect(h.recordActivityEvent).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    expect(JSON.stringify(error.mock.calls)).not.toContain("+15551112222");
    expect(JSON.stringify(error.mock.calls)).not.toContain(input.body);
  });

  it("stops a failing status sweep after ten lookups and reports deferred work", async () => {
    h.execute.mockResolvedValueOnce({ rows: Array.from({ length: 15 }, (_, index) => ({
      inbound_sid: `SMinbound${index}`,
      outbound_sid: `SMoutbound${index}`,
      sent_at: candidate.sent_at,
    })) });
    h.fetchTwilioMessageStatus.mockRejectedValue(new Error("Twilio API unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(recoverStalledAgentReplies(15)).resolves.toEqual({
      checked: 10,
      alerted: 0,
      terminalObserved: 0,
      lookupErrors: 10,
    });

    expect(h.fetchTwilioMessageStatus).toHaveBeenCalledTimes(10);
    expect(error).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("Agent reply status sweep deferred candidates", { count: 5 });
  });

  it("keeps a slow status sweep within a two-minute work budget", async () => {
    h.execute.mockResolvedValueOnce({ rows: Array.from({ length: 15 }, (_, index) => ({
      inbound_sid: `SMinbound${index}`,
      outbound_sid: `SMoutbound${index}`,
      sent_at: candidate.sent_at,
    })) }).mockResolvedValue({ rows: [{ id: "terminal-id" }] });
    h.fetchTwilioMessageStatus.mockResolvedValue("delivered");
    const now = Date.now();
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(now)
      .mockReturnValueOnce(now)
      .mockReturnValueOnce(now + 120_001);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(recoverStalledAgentReplies(15)).resolves.toEqual({
      checked: 10,
      alerted: 0,
      terminalObserved: 10,
      lookupErrors: 0,
    });

    expect(h.fetchTwilioMessageStatus).toHaveBeenCalledTimes(10);
    expect(warn).toHaveBeenCalledWith("Agent reply status sweep deferred candidates", { count: 5 });
  });
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
      expectedUpdatedAt: new Date("2026-10-01T00:00:00.000Z"),
    })).rejects.toThrow(/lease/i);
  });

  it("guards a generating NEW against job completion and restarts the same-number Voice draft", async () => {
    const updatedAt = await checkpointInboundTurn({
      messageSid: "SM123",
      conversationId: "00000000-0000-0000-0000-000000000001",
      leaseOwner: "worker-1",
      state: "generating",
      collected: {
        prompt: "Old comic",
        generationRequestKey: "twilio-message:SM-old",
        newDraftRequestedAt: "2026-10-01T00:00:01.000Z",
      },
      activeStoryId: null,
      replyBody: "A new comic will start after this one finishes. Send fresh photos.",
      submission: null,
      expectedUpdatedAt: new Date("2026-10-01T00:00:00.000Z"),
      expectedGeneratingRequestKey: "twilio-message:SM-old",
      restartVoice: {
        phoneNumber: "+15551112222",
        requestedAt: "2026-10-01T00:00:01.000Z",
      },
    });

    expect(updatedAt).toEqual(new Date("2026-10-01T00:00:02.000Z"));

    const query = dialect.sqlToQuery(h.execute.mock.calls[0][0] as SQL);
    expect(query.sql).toMatch(/state\s*=\s*'generating'/);
    expect(query.sql).toMatch(/generationRequestKey'\s+IS NOT DISTINCT FROM/);
    expect(query.sql).toMatch(/updated_at\s*=\s*\$\d+/);
    expect(query.sql).toMatch(/date_trunc\('milliseconds', updated_at\)/);
    expect(query.sql).toMatch(/voice_reset AS\s*\(\s*UPDATE conversations/s);
    expect(query.sql).toMatch(/WHEN state = 'generating'[\s\S]*newDraftRequestedAt/);
    expect(query.sql).toMatch(/photoHandoffResetAt/);
    expect(query.sql).toMatch(/EXISTS \(SELECT 1 FROM checkpointed_message\)/);
    expect(query.params).toEqual(expect.arrayContaining([
      "twilio-message:SM-old", "+15551112222", "2026-10-01T00:00:01.000Z",
    ]));
  });

  it("keeps ordinary turn checkpoints free of the NEW-only guard and Voice reset", async () => {
    await checkpointInboundTurn({
      messageSid: "SM123",
      conversationId: "00000000-0000-0000-0000-000000000001",
      leaseOwner: "worker-1",
      state: "collecting",
      collected: { prompt: "A fresh comic" },
      activeStoryId: null,
      replyBody: "Tell me more.",
      submission: null,
      expectedUpdatedAt: new Date("2026-10-01T00:00:00.000Z"),
    });

    const query = dialect.sqlToQuery(h.execute.mock.calls[0][0] as SQL).sql;
    expect(query).not.toContain("IS NOT DISTINCT FROM");
    expect(query).not.toContain("voice_reset");
    expect(query).toMatch(/updated_at\s*=\s*\$\d+/);
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
