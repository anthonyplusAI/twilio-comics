import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { activityEvents, users } from "@/lib/schema";
import { getStudioTextSourceId } from "@/lib/studio-comic-text-budget";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_ID = /^[0-9a-f]{32}$/;
const SESSION_KIND = "studio.guest.session.issued";
const SOURCE_HOUR_LIMIT = 300;
const SOURCE_DAY_LIMIT = 2400;
const GLOBAL_HOUR_LIMIT = 3000;
const GLOBAL_DAY_LIMIT = 24000;
const UPLOAD_KIND = "studio.guest.photo_upload.requested";
const SOURCE_UPLOAD_HOUR_LIMIT = 600;
const SOURCE_UPLOAD_DAY_LIMIT = 4800;
const GLOBAL_UPLOAD_HOUR_LIMIT = 6000;
const GLOBAL_UPLOAD_DAY_LIMIT = 48000;

export const getStudioGuestSourceId = getStudioTextSourceId;

type SessionAdmission =
  | { reason: "accepted" }
  | { reason: "rate_limit" }
  | { reason: "unavailable" };

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result &&
      Array.isArray(result.rows)) return result.rows as T[];
  throw new Error("Unexpected Studio guest budget result");
}

function count(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error("Invalid Studio guest budget count");
}

/** Atomically create a guest user and charge the source/global issuance budget. */
export async function issueStudioGuestSession(userId: string, sourceId: string): Promise<SessionAdmission> {
  if (!UUID_V4.test(userId) || !SOURCE_ID.test(sourceId)) return { reason: "unavailable" };
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(hashtext('twilio-comics:studio-guest-session'), 1)
      `);
      const [usage] = rowsOf<{
        source_hour: number | string;
        source_day: number | string;
        global_hour: number | string;
        global_day: number | string;
      }>(await tx.execute(sql`
        SELECT
          COUNT(*) FILTER (
            WHERE details ->> 'sourceId' = ${sourceId}
              AND occurred_at >= statement_timestamp() - INTERVAL '1 hour'
          )::integer AS source_hour,
          COUNT(*) FILTER (WHERE details ->> 'sourceId' = ${sourceId})::integer AS source_day,
          COUNT(*) FILTER (
            WHERE occurred_at >= statement_timestamp() - INTERVAL '1 hour'
          )::integer AS global_hour,
          COUNT(*)::integer AS global_day
        FROM activity_events
        WHERE kind = ${SESSION_KIND}
          AND occurred_at >= statement_timestamp() - INTERVAL '24 hours'
      `));
      if (!usage) throw new Error("Missing Studio guest session counts");
      if (count(usage.source_hour) >= SOURCE_HOUR_LIMIT ||
          count(usage.source_day) >= SOURCE_DAY_LIMIT ||
          count(usage.global_hour) >= GLOBAL_HOUR_LIMIT ||
          count(usage.global_day) >= GLOBAL_DAY_LIMIT) {
        return { reason: "rate_limit" as const };
      }

      await tx.insert(users).values({
        id: userId,
        kind: "browser_guest",
        generationQuotaLimit: -1,
      });
      await tx.insert(activityEvents).values({
        eventKey: `studio-guest-session:${randomUUID()}`,
        occurredAt: sql`statement_timestamp()`,
        userId,
        channel: "web",
        kind: SESSION_KIND,
        direction: "inbound",
        status: "issued",
        details: { sourceId },
      });
      return { reason: "accepted" as const };
    });
  } catch (error) {
    console.error("Studio guest session budget unavailable", error instanceof Error ? error.name : "unknown");
    return { reason: "unavailable" };
  }
}

/** Charge every guest photo attempt to a trusted source and shared global budget. */
export async function reserveStudioGuestUpload(
  userId: string,
  request: Request,
): Promise<{ allowed: true } | { allowed: false; reason: "rate_limit" | "unavailable" }> {
  const sourceId = getStudioGuestSourceId(request);
  if (!UUID_V4.test(userId) || !sourceId || !SOURCE_ID.test(sourceId)) {
    return { allowed: false, reason: "unavailable" };
  }
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(hashtext('twilio-comics:studio-guest-upload'), 1)
      `);
      const [usage] = rowsOf<{
        source_hour: number | string;
        source_day: number | string;
        global_hour: number | string;
        global_day: number | string;
      }>(await tx.execute(sql`
        SELECT
          COUNT(*) FILTER (
            WHERE details ->> 'sourceId' = ${sourceId}
              AND occurred_at >= statement_timestamp() - INTERVAL '1 hour'
          )::integer AS source_hour,
          COUNT(*) FILTER (WHERE details ->> 'sourceId' = ${sourceId})::integer AS source_day,
          COUNT(*) FILTER (
            WHERE occurred_at >= statement_timestamp() - INTERVAL '1 hour'
          )::integer AS global_hour,
          COUNT(*)::integer AS global_day
        FROM activity_events
        WHERE kind = ${UPLOAD_KIND}
          AND occurred_at >= statement_timestamp() - INTERVAL '24 hours'
      `));
      if (!usage) throw new Error("Missing Studio guest upload counts");
      if (count(usage.source_hour) >= SOURCE_UPLOAD_HOUR_LIMIT ||
          count(usage.source_day) >= SOURCE_UPLOAD_DAY_LIMIT ||
          count(usage.global_hour) >= GLOBAL_UPLOAD_HOUR_LIMIT ||
          count(usage.global_day) >= GLOBAL_UPLOAD_DAY_LIMIT) {
        return { allowed: false as const, reason: "rate_limit" as const };
      }

      await tx.insert(activityEvents).values({
        eventKey: `studio-guest-upload:${randomUUID()}`,
        occurredAt: sql`statement_timestamp()`,
        userId,
        channel: "web",
        kind: UPLOAD_KIND,
        direction: "inbound",
        status: "requested",
        details: { sourceId },
      });
      return { allowed: true as const };
    });
  } catch (error) {
    console.error("Studio guest upload budget unavailable", error instanceof Error ? error.name : "unknown");
    return { allowed: false, reason: "unavailable" };
  }
}
