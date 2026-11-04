import { createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { activityEvents } from "@/lib/schema";

export type StudioTextBudgetKind = "verify_start" | "verify_check" | "link_send";

type Limits = {
  phoneHour: number;
  phoneDay: number;
  actorHour: number;
  actorDay: number;
  sourceDay: number;
  globalDay: number;
};

const LIMITS: Record<StudioTextBudgetKind, Limits> = {
  verify_start: { phoneHour: 3, phoneDay: 6, actorHour: 5, actorDay: 12, sourceDay: 100, globalDay: 1000 },
  verify_check: { phoneHour: 8, phoneDay: 20, actorHour: 12, actorDay: 30, sourceDay: 250, globalDay: 3000 },
  link_send: { phoneHour: 3, phoneDay: 6, actorHour: 5, actorDay: 12, sourceDay: 100, globalDay: 1000 },
};

const EVENT_KEY = /^studio-text:(?:verify_start|verify_check|link_send):[0-9a-f-]{36}$/;
const E164 = /^\+[1-9]\d{6,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result &&
      Array.isArray(result.rows)) return result.rows as T[];
  throw new Error("Unexpected Studio text budget query result");
}

function count(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error("Invalid Studio text budget count");
}

/** Use only ACA's appended forwarding address, never a caller-supplied first hop. */
export function getStudioTextSourceId(request: Request): string | null {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret) return null;

  let source: string;
  if (process.env.CONTAINER_APP_NAME) {
    const forwarded = request.headers.get("x-forwarded-for") || "";
    source = forwarded.slice(forwarded.lastIndexOf(",") + 1).trim();
    if (!isIP(source)) return null;
  } else if (process.env.NODE_ENV !== "production") {
    source = "local-development";
  } else {
    return null;
  }

  return createHmac("sha256", secret)
    .update(`twilio-comics:studio-text:source:${source}`)
    .digest("hex")
    .slice(0, 32);
}

/** Reserve a paid Verify action or comic-link SMS atomically across replicas. */
export async function reserveStudioTextBudget(input: {
  kind: StudioTextBudgetKind;
  userId: string;
  storyId: string;
  phone: string;
  sourceId: string;
}): Promise<{ allowed: true; eventKey: string } | { allowed: false; reason: "rate_limit" | "unavailable" }> {
  if (!input.userId || input.userId.length > 200 || !UUID.test(input.storyId) ||
      !E164.test(input.phone) || !/^[0-9a-f]{32}$/.test(input.sourceId)) {
    return { allowed: false, reason: "unavailable" };
  }
  const limits = LIMITS[input.kind];
  const kind = `studio.comic_text.${input.kind}.requested`;

  try {
    return await db.transaction(async (tx) => {
      // A single lock protects the phone, actor, source, and global budgets.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('twilio-comics:studio-text-budget'), 1)`);
      const [usage] = rowsOf<{
        phone_hour: number | string;
        phone_day: number | string;
        actor_hour: number | string;
        actor_day: number | string;
        source_day: number | string;
        global_day: number | string;
      }>(await tx.execute(sql`
        SELECT
          COUNT(*) FILTER (
            WHERE address = ${input.phone}
              AND occurred_at >= statement_timestamp() - INTERVAL '1 hour'
          )::integer AS phone_hour,
          COUNT(*) FILTER (WHERE address = ${input.phone})::integer AS phone_day,
          COUNT(*) FILTER (
            WHERE user_id = ${input.userId}
              AND occurred_at >= statement_timestamp() - INTERVAL '1 hour'
          )::integer AS actor_hour,
          COUNT(*) FILTER (WHERE user_id = ${input.userId})::integer AS actor_day,
          COUNT(*) FILTER (WHERE details ->> 'sourceId' = ${input.sourceId})::integer AS source_day,
          COUNT(*)::integer AS global_day
        FROM activity_events
        WHERE kind = ${kind}
          AND occurred_at >= statement_timestamp() - INTERVAL '24 hours'
      `));
      if (!usage) throw new Error("Missing Studio text budget counts");
      if (count(usage.phone_hour) >= limits.phoneHour ||
          count(usage.phone_day) >= limits.phoneDay ||
          count(usage.actor_hour) >= limits.actorHour ||
          count(usage.actor_day) >= limits.actorDay ||
          count(usage.source_day) >= limits.sourceDay ||
          count(usage.global_day) >= limits.globalDay) {
        return { allowed: false as const, reason: "rate_limit" as const };
      }

      const eventKey = `studio-text:${input.kind}:${randomUUID()}`;
      await tx.insert(activityEvents).values({
        eventKey,
        occurredAt: sql`statement_timestamp()`,
        userId: input.userId,
        storyId: input.storyId,
        channel: "web",
        kind,
        direction: "outbound",
        address: input.phone,
        status: "reserved",
        details: { sourceId: input.sourceId },
      });
      return { allowed: true as const, eventKey };
    });
  } catch (error) {
    console.error("Studio comic text budget unavailable", error instanceof Error ? error.name : "unknown");
    return { allowed: false, reason: "unavailable" };
  }
}

export async function finishStudioTextBudget(
  eventKey: string,
  status: "sent" | "approved" | "denied" | "failed",
  messageSid?: string,
): Promise<void> {
  if (!EVENT_KEY.test(eventKey)) throw new Error("Invalid Studio text event key");
  await db.update(activityEvents)
    .set({ status, ...(messageSid ? { messageSid } : {}) })
    .where(eq(activityEvents.eventKey, eventKey));
}
