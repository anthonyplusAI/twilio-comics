import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

const CALL_SID = /^CA[0-9a-f]{32}$/i;
const E164 = /^\+[1-9]\d{6,14}$/;
const MAX_STARTS_PER_HOUR = 4;
const MAX_STARTS_PER_DAY = 10;
const MAX_NUMBER_STARTS_PER_HOUR = 12;
const DEFAULT_MAX_NUMBER_STARTS_PER_DAY = 40;

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

function numericCount(value: unknown): number {
  if (typeof value === "number") return value;
  return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
}

function numberDailyLimit(): number | null {
  const configured = process.env.VOICE_VERIFY_NUMBER_DAILY_LIMIT;
  if (configured === undefined) return DEFAULT_MAX_NUMBER_STARTS_PER_DAY;
  if (!/^(0|[1-9]\d*)$/.test(configured)) return null;
  const limit = Number(configured);
  return Number.isSafeInteger(limit) ? limit : null;
}

/**
 * Bound Verify SMS starts before calling Twilio. Recipient and caller advisory
 * locks serialize both budgets across app replicas. A CallSid key makes webhook
 * retries reuse a code that was already sent instead of creating another SMS.
 */
export async function reserveVoiceVerificationStart(
  input: VoiceVerificationRequest,
): Promise<VoiceVerificationReservation> {
  if (!CALL_SID.test(input.callSid) || !E164.test(input.fromAddress) ||
      !E164.test(input.toAddress)) {
    return { allowed: false, reason: "invalid" };
  }

  const maxNumberStartsPerDay = numberDailyLimit();
  if (maxNumberStartsPerDay === null) {
    console.error("Voice verification budget unavailable: invalid VOICE_VERIFY_NUMBER_DAILY_LIMIT");
    return { allowed: false, reason: "unavailable" };
  }

  try {
    return await db.transaction(async (tx): Promise<VoiceVerificationReservation> => {
      // Acquire in the same order for every call. A hash collision only makes
      // unrelated numbers or callers wait; counts match the full addresses.
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtext('twilio-comics:voice-verify:recipient'),
          hashtext(${input.toAddress})
        )
      `);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtext('twilio-comics:voice-verify:caller'),
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

      const usage = rowsOf<{
        caller_hour_count: number | string;
        caller_day_count: number | string;
        number_hour_count: number | string;
        number_day_count: number | string;
      }>(
        await tx.execute(sql`
          SELECT
            COUNT(*) FILTER (
              WHERE address = ${input.fromAddress}
                AND occurred_at >= statement_timestamp() - INTERVAL '1 hour'
            )::integer AS caller_hour_count,
            COUNT(*) FILTER (
              WHERE address = ${input.fromAddress}
            )::integer AS caller_day_count,
            COUNT(*) FILTER (
              WHERE details->>'toAddress' = ${input.toAddress}
                AND occurred_at >= statement_timestamp() - INTERVAL '1 hour'
            )::integer AS number_hour_count,
            COUNT(*) FILTER (
              WHERE details->>'toAddress' = ${input.toAddress}
            )::integer AS number_day_count
          FROM activity_events
          WHERE kind = 'voice.verification.requested'
            AND occurred_at >= statement_timestamp() - INTERVAL '24 hours'
            AND (address = ${input.fromAddress}
              OR details->>'toAddress' = ${input.toAddress})
        `),
      )[0];
      const callerHourCount = numericCount(usage?.caller_hour_count);
      const callerDayCount = numericCount(usage?.caller_day_count);
      const numberHourCount = numericCount(usage?.number_hour_count);
      const numberDayCount = numericCount(usage?.number_day_count);
      if (!usage || ![
        callerHourCount, callerDayCount, numberHourCount, numberDayCount,
      ].every((count) => Number.isSafeInteger(count) && count >= 0)) {
        throw new Error("Invalid Voice verification usage count");
      }
      let limit: "caller_hour" | "caller_day" | "number_hour" | "number_day" | null = null;
      if (callerHourCount >= MAX_STARTS_PER_HOUR) limit = "caller_hour";
      else if (callerDayCount >= MAX_STARTS_PER_DAY) limit = "caller_day";
      else if (numberHourCount >= MAX_NUMBER_STARTS_PER_HOUR) limit = "number_hour";
      else if (numberDayCount >= maxNumberStartsPerDay) limit = "number_day";
      const allowed = limit === null;
      const kind = allowed ? "voice.verification.requested" : "voice.verification.denied";
      const status = allowed ? "reserved" : "denied";
      const inserted = rowsOf<{ id: string }>(await tx.execute(sql`
        INSERT INTO activity_events
          (event_key, occurred_at, channel, kind, direction, address, call_sid, status, details)
        VALUES (
          ${eventKey}, statement_timestamp(), 'voice', ${kind}, 'inbound', ${input.fromAddress},
          ${input.callSid}, ${status},
          jsonb_strip_nulls(jsonb_build_object(
            'toAddress', ${input.toAddress}, 'budgetLimit', ${limit}
          ))
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
