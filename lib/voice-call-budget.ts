import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export interface VoiceCallBudgetInput {
  callSid: string;
  fromAddress: string;
  toAddress: string;
}

export type VoiceCallBudgetResult =
  | { allowed: true; duplicate: boolean }
  | { allowed: false; reason: "rate_limit" | "unavailable" | "invalid" | "identity_mismatch" | "finished" };

const CALL_SID = /^CA[0-9a-f]{32}$/i;
const E164 = /^\+[1-9]\d{6,14}$/;
const MAX_CALLS_PER_24_HOURS = 6;

interface ExistingCallRow {
  from_address: string;
  to_address: string;
  status: string;
  ended_at: Date | string | null;
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result &&
      Array.isArray(result.rows)) {
    return result.rows as T[];
  }
  throw new Error("Unexpected Voice budget query result");
}

/** Reserve one verified AI call for a caller. A transaction lock serializes all callers with the same number. */
export async function reserveVoiceCallBudget(input: VoiceCallBudgetInput): Promise<VoiceCallBudgetResult> {
  if (!CALL_SID.test(input.callSid) || !E164.test(input.fromAddress) || !E164.test(input.toAddress)) {
    return { allowed: false, reason: "invalid" };
  }

  try {
    return await db.transaction(async (tx): Promise<VoiceCallBudgetResult> => {
      // hashtext collisions only serialize unrelated callers; the count itself
      // always uses the full address. The lock lives until this transaction ends.
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtext('twilio-comics:voice-call-budget'),
          hashtext(${input.fromAddress})
        )
      `);

      const existing = rowsOf<ExistingCallRow>(await tx.execute(sql`
        SELECT from_address, to_address, status, ended_at
        FROM voice_calls
        WHERE call_sid = ${input.callSid}
        LIMIT 1
      `))[0];
      if (existing) {
        if (existing.from_address !== input.fromAddress || existing.to_address !== input.toAddress) {
          return { allowed: false, reason: "identity_mismatch" };
        }
        if (existing.status === "rate_limited") return { allowed: false, reason: "rate_limit" };
        if (existing.ended_at !== null) return { allowed: false, reason: "finished" };
        return { allowed: true, duplicate: true };
      }

      const usage = rowsOf<{ used: number | string }>(await tx.execute(sql`
        SELECT COUNT(*)::integer AS used
        FROM voice_calls
        WHERE from_address = ${input.fromAddress}
          AND started_at > statement_timestamp() - INTERVAL '24 hours'
          AND status <> 'rate_limited'
      `))[0];
      const used = Number(usage?.used);
      if (!usage || !Number.isSafeInteger(used) || used < 0) {
        throw new Error("Invalid Voice budget count");
      }

      const allowed = used < MAX_CALLS_PER_24_HOURS;
      const status = allowed ? "active" : "rate_limited";
      const inserted = rowsOf<{ call_sid: string }>(await tx.execute(sql`
        INSERT INTO voice_calls
          (call_sid, from_address, to_address, status, started_at, ended_at, duration_seconds)
        VALUES (
          ${input.callSid}, ${input.fromAddress}, ${input.toAddress}, ${status},
          statement_timestamp(),
          ${allowed ? null : sql`statement_timestamp()`},
          ${allowed ? null : 0}
        )
        ON CONFLICT (call_sid) DO NOTHING
        RETURNING call_sid
      `));
      if (inserted.length !== 1 || inserted[0].call_sid !== input.callSid) {
        throw new Error("Voice call reservation lost a CallSid race");
      }

      return allowed
        ? { allowed: true, duplicate: false }
        : { allowed: false, reason: "rate_limit" };
    });
  } catch (error) {
    console.error("Voice call budget unavailable", error instanceof Error ? error.name : "unknown");
    return { allowed: false, reason: "unavailable" };
  }
}
