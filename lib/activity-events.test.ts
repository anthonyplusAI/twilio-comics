import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({
  insert: vi.fn(),
  values: vi.fn(),
  conflict: vi.fn(),
  updateConflict: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
  where: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: { insert: h.insert, update: h.update } }));

import { activityEvents, voiceCalls } from "@/lib/schema";
import {
  recordActivityEvent,
  recordVoiceCallEnd,
  recordVoiceCallStart,
  recordVoiceTurn,
} from "@/lib/activity-events";

beforeEach(() => {
  vi.clearAllMocks();
  h.insert.mockReturnValue({ values: h.values });
  h.values.mockReturnValue({ onConflictDoNothing: h.conflict, onConflictDoUpdate: h.updateConflict });
  h.conflict.mockResolvedValue(undefined);
  h.updateConflict.mockResolvedValue(undefined);
  h.update.mockReturnValue({ set: h.set });
  h.set.mockReturnValue({ where: h.where });
  h.where.mockResolvedValue(undefined);
});

const callSid = `CA${"1".repeat(32)}`;
const fromAddress = "+15551112222";
const toAddress = "+18669012028";
const dialect = new PgDialect();

describe("voice call history", () => {
  it("persists a call start once and stores the caller address", async () => {
    await recordVoiceCallStart({ callSid, fromAddress, toAddress, userId: "user-1" });

    expect(h.insert.mock.calls.map(([table]) => table)).toEqual([voiceCalls, activityEvents]);
    expect(h.values.mock.calls[0][0]).toMatchObject({
      callSid,
      fromAddress,
      toAddress,
      userId: "user-1",
      status: "active",
    });
    expect(h.values.mock.calls[1][0]).toMatchObject({
      eventKey: `call:${callSid}:start`,
      kind: "voice.started",
      channel: "voice",
      address: fromAddress,
    });
    expect(h.updateConflict.mock.calls[0][0].target).toBe(voiceCalls.callSid);
  });

  it("fills the user ID on a reserved active call without changing its original start or status", async () => {
    await recordVoiceCallStart({ callSid, fromAddress, toAddress, userId: "user-1" });

    const conflict = h.updateConflict.mock.calls[0]?.[0];
    expect(conflict).toMatchObject({
      target: voiceCalls.callSid,
      set: { userId: "user-1" },
    });
    expect(conflict.set).not.toHaveProperty("startedAt");
    expect(conflict.set).not.toHaveProperty("status");
    const condition = dialect.sqlToQuery(conflict.setWhere);
    expect(condition.sql).toMatch(/"voice_calls"\."status"\s*=\s*\$\d+/);
    expect(condition.sql).toMatch(/"voice_calls"\."user_id"\s+is null/i);
    expect(condition.params).toEqual(expect.arrayContaining([fromAddress, toAddress, "active"]));
  });

  it("logs finalized caller and agent text with distinct turn keys", async () => {
    await recordVoiceTurn({ callSid, address: fromAddress, sequence: 2, role: "caller", content: "A moon detective" });
    await recordVoiceTurn({ callSid, address: fromAddress, sequence: 2, role: "agent", content: "What style?" });

    expect(h.values.mock.calls.map(([event]) => event.eventKey)).toEqual([
      `call:${callSid}:turn:2:caller`,
      `call:${callSid}:turn:2:agent`,
    ]);
    expect(h.values.mock.calls.map(([event]) => event.kind)).toEqual([
      "voice.caller_turn",
      "voice.agent_turn",
    ]);
    expect(h.values.mock.calls.map(([event]) => event.content)).toEqual([
      "A moon detective",
      "What style?",
    ]);
    expect(h.update).toHaveBeenCalledWith(voiceCalls);
  });

  it("keeps the final action response separate from the last Relay agent turn", async () => {
    await recordVoiceTurn({ callSid, address: fromAddress, sequence: 20, role: "agent", content: "Saved your idea." });
    await recordVoiceTurn({ callSid, address: fromAddress, sequence: 20, role: "agent", phase: "action", content: "This call has reached its time limit." });

    expect(h.values.mock.calls.map(([event]) => event.eventKey)).toEqual([
      `call:${callSid}:turn:20:agent`,
      `call:${callSid}:turn:20:agent:action`,
    ]);
  });

  it("stores the Relay duration, outcome, and error code when the call ends", async () => {
    const endedAt = new Date("2026-10-21T12:00:25.000Z");
    await recordVoiceCallEnd({
      callSid,
      fromAddress,
      toAddress,
      status: "service_error",
      durationSeconds: 25,
      errorCode: "64105",
      endedAt,
      sessionStatus: "failed",
      callStatus: "in-progress",
    });

    expect(h.insert.mock.calls.map(([table]) => table)).toEqual([voiceCalls, activityEvents]);
    expect(h.values.mock.calls[0][0]).toMatchObject({
      callSid,
      status: "service_error",
      durationSeconds: 25,
      errorCode: "64105",
      endedAt,
      startedAt: new Date("2026-10-21T12:00:00.000Z"),
    });
    expect(h.updateConflict.mock.calls[0][0].target).toBe(voiceCalls.callSid);
    expect(h.values.mock.calls[1][0]).toMatchObject({
      eventKey: `call:${callSid}:end`,
      kind: "voice.ended",
      status: "service_error",
      details: {
        durationSeconds: 25,
        durationSource: "conversation_relay",
        errorCode: "64105",
        sessionStatus: "failed",
        callStatus: "in-progress",
      },
    });
  });

  it("does not interrupt the call when the voice summary insert fails", async () => {
    h.conflict.mockRejectedValueOnce(new Error("voice table unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(recordVoiceCallStart({ callSid, fromAddress, toAddress })).resolves.toBeUndefined();
      expect(h.insert).toHaveBeenCalledWith(activityEvents);
    } finally {
      log.mockRestore();
    }
  });
});

describe("append-only activity history", () => {
  it("retries a transient insert failure without duplicating the event", async () => {
    h.conflict.mockRejectedValueOnce(new Error("database connection reset"));
    await recordActivityEvent({
      eventKey: "message:SM-retry:inbound",
      channel: "sms",
      kind: "message.inbound",
    });
    expect(h.conflict).toHaveBeenCalledTimes(2);
    expect(h.values.mock.calls.map(([event]) => event.eventKey)).toEqual([
      "message:SM-retry:inbound",
      "message:SM-retry:inbound",
    ]);
  });

  it("stops a caller turn when its transcript cannot be saved", async () => {
    h.conflict.mockRejectedValue(new Error("database unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(recordVoiceTurn({
        callSid, address: fromAddress, sequence: 3, role: "caller", content: "Create my comic",
      })).rejects.toThrow("database unavailable");
      expect(h.conflict).toHaveBeenCalledTimes(3);
      expect(h.update).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("stores the event under a unique key so a retried webhook has one history entry", async () => {
    await recordActivityEvent({
      eventKey: "message:SM123:inbound",
      channel: "sms",
      kind: "message.inbound",
      direction: "inbound",
      address: "+15551112222",
      messageSid: "SM123",
      content: "Robot detective",
    });

    expect(h.insert).toHaveBeenCalledWith(activityEvents);
    expect(h.values).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: "message:SM123:inbound",
      content: "Robot detective",
      address: "+15551112222",
    }));
    expect(h.conflict).toHaveBeenCalledWith({ target: activityEvents.eventKey });
  });

  it("leaves the signed webhook healthy if the optional history insert fails", async () => {
    h.conflict.mockRejectedValue(new Error("activity table unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(recordActivityEvent({
        eventKey: "message:SM123:inbound",
        channel: "sms",
        kind: "message.inbound",
      })).resolves.toBeUndefined();
    } finally {
      log.mockRestore();
    }
  });
});
