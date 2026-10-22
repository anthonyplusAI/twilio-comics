import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { TwilioMessageChannel } from "@/lib/twilio";

const E164 = /^\+[1-9]\d{6,14}$/;
const MESSAGE_SID = /^(?:SM|MM)[A-Za-z0-9-]{1,62}$/;
const MAX_TURNS_PER_HOUR = 20;
const MAX_TURNS_PER_24_HOURS = 80;
const DEFAULT_GLOBAL_DAILY_LIMIT = 200;

export interface MessageAgentTurnRequest {
  messageSid: string;
  channel: TwilioMessageChannel;
  fromAddress: string;
  toAddress: string;
}

export type MessageAgentTurnReservation =
  | { allowed: true; duplicate: boolean }
  | { allowed: false; reason: "rate_limit"; sendNotice: boolean }
  | { allowed: false; reason: "invalid" | "unavailable" };

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result &&
      Array.isArray(result.rows)) return result.rows as T[];
  throw new Error("Unexpected messaging budget query result");
}

function phoneOf(input: MessageAgentTurnRequest): string | null {
  const prefix = input.channel === "whatsapp" ? "whatsapp:" : "";
  if (input.channel !== "sms" && input.channel !== "whatsapp") return null;
  if (!input.fromAddress.startsWith(prefix) || !input.toAddress.startsWith(prefix)) return null;
  const phone = input.fromAddress.slice(prefix.length);
  const sender = input.toAddress.slice(prefix.length);
  return E164.test(phone) && E164.test(sender) ? phone : null;
}

/** Zero pauses new turns. A malformed limit must never make the budget unlimited. */
function globalDailyLimit(): number {
  const configured = process.env.MESSAGE_AGENT_GLOBAL_DAILY_LIMIT;
  if (configured === undefined) return DEFAULT_GLOBAL_DAILY_LIMIT;
  if (!/^\d+$/.test(configured)) {
    throw new Error("MESSAGE_AGENT_GLOBAL_DAILY_LIMIT must be a nonnegative whole number");
  }
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("MESSAGE_AGENT_GLOBAL_DAILY_LIMIT must be a safe whole number");
  }
  return parsed;
}

/**
 * Reserve before invoking the agent. The global PostgreSQL lock serializes
 * senders before their phone locks, so concurrent senders cannot exceed the
 * app-wide budget. The inbound SID makes worker retries reuse the original
 * decision without consuming another slot.
 */
export async function reserveMessageAgentTurn(
  input: MessageAgentTurnRequest,
): Promise<MessageAgentTurnReservation> {
  const phone = phoneOf(input);
  if (!phone || !MESSAGE_SID.test(input.messageSid)) {
    return { allowed: false, reason: "invalid" };
  }

  try {
    const appDailyLimit = globalDailyLimit();
    return await db.transaction(async (tx): Promise<MessageAgentTurnReservation> => {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtext('twilio-comics:message-agent-global-budget'),
          0
        )
      `);

      // A hash collision only serializes unrelated callers. Usage always
      // matches the full phone address, never the hash.
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtext('twilio-comics:message-agent-budget'),
          hashtext(${phone})
        )
      `);

      const eventKey = `message:${input.messageSid}:agent-turn`;
      const existing = rowsOf<{
        channel: string;
        address: string | null;
        kind: string;
        status: string | null;
        details: { toAddress?: string } | null;
      }>(await tx.execute(sql`
        SELECT channel, address, kind, status, details
        FROM activity_events
        WHERE event_key = ${eventKey}
        LIMIT 1
      `))[0];
      if (existing) {
        if (existing.channel !== input.channel || existing.address !== input.fromAddress ||
            existing.details?.toAddress !== input.toAddress) {
          return { allowed: false, reason: "invalid" };
        }
        if (existing.kind === "message.agent_turn.reserved" && existing.status === "reserved") {
          return { allowed: true, duplicate: true };
        }
        if (existing.kind === "message.agent_turn.denied" &&
            (existing.status === "notice_pending" || existing.status === "silent")) {
          return {
            allowed: false,
            reason: "rate_limit",
            sendNotice: existing.status === "notice_pending",
          };
        }
        throw new Error("Invalid existing messaging budget event");
      }

      const usage = rowsOf<{
        hour_count: number | string;
        day_count: number | string;
        notice_count: number | string;
        global_count: number | string;
      }>(await tx.execute(sql`
        SELECT
          (SELECT COUNT(*)::integer
           FROM activity_events
           WHERE kind = 'message.agent_turn.reserved'
             AND channel IN ('sms', 'whatsapp')
             AND occurred_at >= statement_timestamp() - INTERVAL '24 hours'
          ) AS global_count,
          COUNT(*) FILTER (
            WHERE kind = 'message.agent_turn.reserved'
              AND occurred_at >= statement_timestamp() - INTERVAL '1 hour'
          )::integer AS hour_count,
          COUNT(*) FILTER (
            WHERE kind = 'message.agent_turn.reserved'
          )::integer AS day_count,
          COUNT(*) FILTER (
            WHERE kind = 'message.agent_turn.denied'
              AND status = 'notice_pending'
              AND channel = ${input.channel}
          )::integer AS notice_count
        FROM activity_events
        WHERE kind IN ('message.agent_turn.reserved', 'message.agent_turn.denied')
          AND address IN (${phone}, ${`whatsapp:${phone}`})
          AND occurred_at >= statement_timestamp() - INTERVAL '24 hours'
      `))[0];
      const hourCount = Number(usage?.hour_count);
      const dayCount = Number(usage?.day_count);
      const noticeCount = Number(usage?.notice_count);
      const globalCount = Number(usage?.global_count);
      if (!usage || ![hourCount, dayCount, noticeCount, globalCount].every((count) =>
        Number.isSafeInteger(count) && count >= 0)) {
        throw new Error("Invalid messaging budget count");
      }

      const allowed = hourCount < MAX_TURNS_PER_HOUR &&
        dayCount < MAX_TURNS_PER_24_HOURS && globalCount < appDailyLimit;
      const sendNotice = !allowed && noticeCount === 0;
      const kind = allowed ? "message.agent_turn.reserved" : "message.agent_turn.denied";
      const status = allowed ? "reserved" : sendNotice ? "notice_pending" : "silent";
      const inserted = rowsOf<{ id: string }>(await tx.execute(sql`
        INSERT INTO activity_events
          (event_key, occurred_at, channel, kind, direction, address, message_sid, status, details)
        VALUES (
          ${eventKey}, statement_timestamp(), ${input.channel}, ${kind}, 'inbound',
          ${input.fromAddress}, ${input.messageSid}, ${status},
          jsonb_build_object(
            'toAddress', ${input.toAddress}::text,
            'hourCount', ${hourCount}::integer, 'dayCount', ${dayCount}::integer,
            'globalCount', ${globalCount}::integer, 'globalLimit', ${appDailyLimit}::bigint
          )
        )
        ON CONFLICT (event_key) DO NOTHING
        RETURNING id
      `));
      if (inserted.length !== 1) throw new Error("Messaging budget reservation race");

      return allowed
        ? { allowed: true, duplicate: false }
        : { allowed: false, reason: "rate_limit", sendNotice };
    });
  } catch (error) {
    console.error("Messaging agent budget unavailable", error instanceof Error ? error.name : "unknown");
    return { allowed: false, reason: "unavailable" };
  }
}
