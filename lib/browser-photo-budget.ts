import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { activityEvents } from "@/lib/schema";

export type CameraBudgetKind = "verification_start" | "verification_check" | "upload";

const DEFAULT_VERIFY_GLOBAL_HOURLY_LIMIT = 30;
const MAX_VERIFY_GLOBAL_HOURLY_LIMIT = 100;
const DEFAULT_VERIFY_GLOBAL_DAILY_LIMIT = 50;
const MAX_VERIFY_GLOBAL_DAILY_LIMIT = 500;

const LIMITS: Record<CameraBudgetKind, {
  phoneHour: number;
  phoneDay: number;
  globalHour: number;
  globalDay: number;
}> = {
  verification_start: {
    phoneHour: 3,
    phoneDay: 5,
    globalHour: DEFAULT_VERIFY_GLOBAL_HOURLY_LIMIT,
    globalDay: DEFAULT_VERIFY_GLOBAL_DAILY_LIMIT,
  },
  verification_check: { phoneHour: 8, phoneDay: 16, globalHour: 80, globalDay: 200 },
  upload: { phoneHour: 6, phoneDay: 12, globalHour: 40, globalDay: 100 },
};

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result &&
      Array.isArray(result.rows)) return result.rows as T[];
  throw new Error("Unexpected camera budget query result");
}

function count(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  throw new Error("Invalid camera budget count");
}

function eventKind(kind: CameraBudgetKind): string {
  return `camera.${kind}.requested`;
}

function configuredVerifyLimit(name: string, defaultLimit: number, maxLimit: number): number {
  const value = process.env[name]?.trim();
  if (!value || !/^[1-9]\d*$/.test(value)) return defaultLimit;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
    ? Math.min(parsed, maxLimit)
    : defaultLimit;
}

/**
 * Reserve before a paid Verify SMS, verification check, or Blob write. One
 * short PostgreSQL advisory lock serializes the global pilot budget across
 * Container App replicas, so parallel browsers cannot exceed it.
 */
export async function reserveCameraBudget(
  kind: CameraBudgetKind,
  phone: string,
): Promise<{ allowed: true; eventKey: string } | { allowed: false; reason: "rate_limit" | "unavailable" }> {
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) return { allowed: false, reason: "unavailable" };
  const limits = LIMITS[kind];
  const globalHourLimit = kind === "verification_start"
    ? configuredVerifyLimit(
        "CAMERA_VERIFY_GLOBAL_HOURLY_LIMIT",
        DEFAULT_VERIFY_GLOBAL_HOURLY_LIMIT,
        MAX_VERIFY_GLOBAL_HOURLY_LIMIT,
      )
    : limits.globalHour;
  const globalDayLimit = kind === "verification_start"
    ? configuredVerifyLimit(
        "CAMERA_VERIFY_GLOBAL_DAILY_LIMIT",
        DEFAULT_VERIFY_GLOBAL_DAILY_LIMIT,
        MAX_VERIFY_GLOBAL_DAILY_LIMIT,
      )
    : limits.globalDay;
  const key = eventKind(kind);
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtext('twilio-comics:camera-budget'), hashtext(${key})
        )
      `);
      const [usage] = rowsOf<{
        phone_hour: number | string;
        phone_day: number | string;
        global_hour: number | string;
        global_day: number | string;
      }>(await tx.execute(sql`
        SELECT
          COUNT(*) FILTER (
            WHERE address = ${phone}
              AND occurred_at >= statement_timestamp() - INTERVAL '1 hour'
          )::integer AS phone_hour,
          COUNT(*) FILTER (WHERE address = ${phone})::integer AS phone_day,
          COUNT(*) FILTER (
            WHERE occurred_at >= statement_timestamp() - INTERVAL '1 hour'
          )::integer AS global_hour,
          COUNT(*)::integer AS global_day
        FROM activity_events
        WHERE kind = ${key}
          AND occurred_at >= statement_timestamp() - INTERVAL '24 hours'
      `));
      if (!usage) throw new Error("Missing camera budget counts");
      if (count(usage.phone_hour) >= limits.phoneHour ||
          count(usage.phone_day) >= limits.phoneDay ||
          count(usage.global_hour) >= globalHourLimit ||
          count(usage.global_day) >= globalDayLimit) {
        return { allowed: false as const, reason: "rate_limit" as const };
      }

      const eventKey = `camera:${kind}:${randomUUID()}`;
      await tx.insert(activityEvents).values({
        eventKey,
        channel: "camera",
        kind: key,
        direction: "inbound",
        address: phone,
        status: "reserved",
      });
      return { allowed: true as const, eventKey };
    });
  } catch (error) {
    console.error("Camera budget unavailable", error instanceof Error ? error.name : "unknown");
    return { allowed: false, reason: "unavailable" };
  }
}

export async function finishCameraBudget(
  eventKey: string,
  status: "sent" | "approved" | "denied" | "stored" | "failed",
): Promise<void> {
  if (!/^camera:(?:verification_start|verification_check|upload):[0-9a-f-]{36}$/.test(eventKey)) {
    throw new Error("Invalid camera event key");
  }
  await db.update(activityEvents)
    .set({ status })
    .where(eq(activityEvents.eventKey, eventKey));
}
