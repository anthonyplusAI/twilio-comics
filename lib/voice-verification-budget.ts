import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

const CALL_SID = /^CA[0-9a-f]{32}$/i;
const E164 = /^\+[1-9]\d{6,14}$/;
const MAX_STARTS_PER_HOUR = 4;
const MAX_STARTS_PER_DAY = 10;

export interface VoiceVerificationRequest {
  callSid: string;
  fromAddress: string;
  toAddress: string;
}

export type VoiceVerificationReservation =
  | { allowed: true; sendCode: boolean }
  | { allowed: false; reason: "invalid" | "rate_limit" | "in_progress" | "unavailable" };

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result &&
      Array.isArray(result.rows)) return result.rows as T[];
  throw new Error("Unexpected Voice verification query result");
}

/**
 * Bound Verify SMS starts before calling Twilio. The PostgreSQL advisory lock
 * serializes calls from one caller, while a CallSid key makes webhook retries
 * reuse a code that was already sent instead of creating another billable SMS.
 */
export async function reserveVoiceVerificationStart(
  input: VoiceVerificationRequest,
): Promise<VoiceVerificationReservation> {
  if (!CALL_SID.test(input.callSid) || !E164.test(input.fromAddress) ||
      !E164.test(input.toAddress)) {
    return { allowed: false, reason: "invalid" };
  }

  try {
    return await db.transaction(async (tx): Promise<VoiceVerificationReservation> => {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtext('twilio-comics:voice-verify'),
          hashtext(${input.fromAddress})
        )
      `);
      const eventKey = `call:${input.callSid}:verification-request`;
      const existing = rowsOf<{
        address: string | null;
        status: string | null;
        details: { toAddress?: string } | null;
      }>(await tx.execute(sql`
        SELECT address, status, details
        FROM activity_events
        WHERE event_key = ${eventKey}
        LIMIT 1
      `))[0];
      if (existing) {
        if (existing.address !== input.fromAddress ||
            existing.details?.toAddress !== input.toAddress) {
          return { allowed: false, reason: "invalid" };
        }
        return existing.status === "sent"
          ? { allowed: true, sendCode: false }
          : existing.status === "denied"
            ? { allowed: false, reason: "rate_limit" }
            : { allowed: false, reason: "in_progress" };
      }

      const usage = rowsOf<{ hour_count: number | string; day_count: number | string }>(
        await tx.execute(sql`
          SELECT
            COUNT(*) FILTER (
              WHERE occurred_at >= statement_timestamp() - INTERVAL '1 hour'
            )::integer AS hour_count,
            COUNT(*)::integer AS day_count
          FROM activity_events
          WHERE kind = 'voice.verification.requested'
            AND address = ${input.fromAddress}
            AND occurred_at >= statement_timestamp() - INTERVAL '24 hours'
        `),
      )[0];
      const hourCount = Number(usage?.hour_count);
      const dayCount = Number(usage?.day_count);
      if (!usage || !Number.isSafeInteger(hourCount) || !Number.isSafeInteger(dayCount)) {
        throw new Error("Invalid Voice verification usage count");
      }
      const allowed = hourCount < MAX_STARTS_PER_HOUR && dayCount < MAX_STARTS_PER_DAY;
      const kind = allowed ? "voice.verification.requested" : "voice.verification.denied";
      const status = allowed ? "reserved" : "denied";
      const inserted = rowsOf<{ id: string }>(await tx.execute(sql`
        INSERT INTO activity_events
          (event_key, channel, kind, direction, address, call_sid, status, details)
        VALUES (
          ${eventKey}, 'voice', ${kind}, 'inbound', ${input.fromAddress},
          ${input.callSid}, ${status},
          jsonb_build_object('toAddress', ${input.toAddress})
        )
        ON CONFLICT (event_key) DO NOTHING
        RETURNING id
      `));
      if (inserted.length !== 1) throw new Error("Voice verification reservation race");
      return allowed
        ? { allowed: true, sendCode: true }
        : { allowed: false, reason: "rate_limit" };
    });
  } catch (error) {
    console.error("Voice verification budget unavailable", error instanceof Error ? error.name : "unknown");
    return { allowed: false, reason: "unavailable" };
  }
}

/** Keep the idempotency record even if Verify is unavailable. */
export async function finishVoiceVerificationStart(
  callSid: string,
  status: "sent" | "failed",
): Promise<void> {
  if (!CALL_SID.test(callSid)) throw new Error("Invalid Voice CallSid");
  const rows = rowsOf<{ id: string }>(await db.execute(sql`
    UPDATE activity_events
    SET status = ${status}
    WHERE event_key = ${`call:${callSid}:verification-request`}
      AND kind = 'voice.verification.requested'
      AND status = 'reserved'
    RETURNING id
  `));
  if (rows.length !== 1) throw new Error("Voice verification reservation was not found");
}
