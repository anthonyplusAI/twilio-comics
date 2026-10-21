import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  insert: vi.fn(),
  select: vi.fn(),
  update: vi.fn(),
  execute: vi.fn(),
  sendInboundMessage: vi.fn(),
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

import {
  checkpointInboundTurn,
  recordInboundMessage,
  recoverPendingInboundMessages,
} from "@/lib/twilio-events";

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
  vi.clearAllMocks();
  h.insertedValues = null;
  setInsertResult([{ messageSid: "SM123" }]);
  h.execute.mockResolvedValue({ rows: [{ message_sid: "SM123" }] });
  h.sendInboundMessage.mockResolvedValue(undefined);
});

describe("durable Twilio receipts", () => {
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
