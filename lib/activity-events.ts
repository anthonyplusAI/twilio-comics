import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { activityEvents, voiceCalls, type NewActivityEvent } from "@/lib/schema";

function logFailure(operation: string, key: string, error: unknown): void {
  console.error("Activity history write failed", {
    operation,
    key,
    error: error instanceof Error ? error.name : "unknown",
  });
}

/** Retry transient database failures; stable event keys keep retries idempotent. */
export async function recordActivityEvent(
  event: NewActivityEvent,
  options: { required?: boolean } = {},
): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await db
        .insert(activityEvents)
        .values(event)
        .onConflictDoNothing({ target: activityEvents.eventKey });
      return;
    } catch (error) {
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
        continue;
      }
      logFailure(event.kind, event.eventKey, error);
      if (options.required) throw error;
    }
  }
}

export interface VoiceCallStart {
  callSid: string;
  fromAddress: string;
  toAddress: string;
  userId?: string | null;
  startedAt?: Date;
}

export async function recordVoiceCallStart(input: VoiceCallStart): Promise<void> {
  const startedAt = input.startedAt || new Date();
  try {
    const insertion = db
      .insert(voiceCalls)
      .values({
        callSid: input.callSid,
        userId: input.userId || null,
        fromAddress: input.fromAddress,
        toAddress: input.toAddress,
        status: "active",
        startedAt,
      });
    if (input.userId) {
      await insertion.onConflictDoUpdate({
        target: voiceCalls.callSid,
        set: { userId: input.userId, updatedAt: startedAt },
        setWhere: and(
          eq(voiceCalls.fromAddress, input.fromAddress),
          eq(voiceCalls.toAddress, input.toAddress),
          eq(voiceCalls.status, "active"),
          isNull(voiceCalls.endedAt),
          isNull(voiceCalls.userId),
        ),
      });
    } else {
      await insertion.onConflictDoNothing({ target: voiceCalls.callSid });
    }
  } catch (error) {
    logFailure("voice call start", input.callSid, error);
  }

  await recordActivityEvent({
    eventKey: `call:${input.callSid}:start`,
    occurredAt: startedAt,
    userId: input.userId || null,
    channel: "voice",
    kind: "voice.started",
    direction: "inbound",
    address: input.fromAddress,
    callSid: input.callSid,
    status: "active",
    details: { toAddress: input.toAddress },
  });
}

export interface VoiceTurn {
  callSid: string;
  address: string;
  userId?: string | null;
  sequence: number;
  role: "caller" | "agent";
  phase?: "action";
  content: string;
}

export async function recordVoiceTurn(input: VoiceTurn): Promise<void> {
  await recordActivityEvent({
    eventKey: `call:${input.callSid}:turn:${input.sequence}:${input.role}${input.phase === "action" ? ":action" : ""}`,
    userId: input.userId || null,
    channel: "voice",
    kind: input.role === "caller" ? "voice.caller_turn" : "voice.agent_turn",
    direction: input.role === "caller" ? "inbound" : "outbound",
    address: input.address,
    callSid: input.callSid,
    content: input.content,
    details: { turn: input.sequence, phase: input.phase || "relay" },
  }, { required: input.role === "caller" });

  if (input.role === "caller") {
    try {
      await db
        .update(voiceCalls)
        .set({
          turnCount: sql`GREATEST(${voiceCalls.turnCount}, ${input.sequence})`,
          updatedAt: new Date(),
        })
        .where(eq(voiceCalls.callSid, input.callSid));
    } catch (error) {
      logFailure("voice turn count", input.callSid, error);
    }
  }
}

export interface VoiceCallEnd {
  callSid: string;
  fromAddress: string;
  toAddress: string;
  userId?: string | null;
  status: string;
  durationSeconds?: number | null;
  durationSource?: "call" | "conversation_relay" | "measured";
  errorCode?: string | null;
  sessionStatus?: string | null;
  callStatus?: string | null;
  endedAt?: Date;
}

export async function recordVoiceCallEnd(input: VoiceCallEnd): Promise<void> {
  const endedAt = input.endedAt || new Date();
  const durationSeconds = input.durationSeconds ?? null;
  const startedAt = new Date(endedAt.getTime() - (durationSeconds || 0) * 1000);
  const errorCode = input.errorCode || null;
  try {
    await db
      .insert(voiceCalls)
      .values({
        callSid: input.callSid,
        userId: input.userId || null,
        fromAddress: input.fromAddress,
        toAddress: input.toAddress,
        status: input.status,
        startedAt,
        endedAt,
        durationSeconds,
        errorCode,
      })
      .onConflictDoUpdate({
        target: voiceCalls.callSid,
        set: {
          status: sql`CASE WHEN ${voiceCalls.endedAt} IS NULL THEN ${input.status} ELSE ${voiceCalls.status} END`,
          endedAt: sql`COALESCE(${voiceCalls.endedAt}, ${endedAt})`,
          durationSeconds: sql`COALESCE(
            ${voiceCalls.durationSeconds},
            ${durationSeconds},
            GREATEST(0, EXTRACT(EPOCH FROM (${endedAt} - ${voiceCalls.startedAt}))::integer)
          )`,
          errorCode: sql`COALESCE(${voiceCalls.errorCode}, ${errorCode})`,
          updatedAt: endedAt,
        },
      });
  } catch (error) {
    logFailure("voice call end", input.callSid, error);
  }

  await recordActivityEvent({
    eventKey: `call:${input.callSid}:end`,
    occurredAt: endedAt,
    userId: input.userId || null,
    channel: "voice",
    kind: "voice.ended",
    direction: "inbound",
    address: input.fromAddress,
    callSid: input.callSid,
    status: input.status,
    details: {
      durationSeconds,
      durationSource: input.durationSource || (durationSeconds === null ? "measured" : "conversation_relay"),
      errorCode,
      sessionStatus: input.sessionStatus || null,
      callStatus: input.callStatus || null,
    },
  });
}
