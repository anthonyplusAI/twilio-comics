import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { activityEvents } from "@/lib/schema";
import { getStudioGuestSourceId } from "@/lib/studio-guest-budget";
import { getStudioBudgetId, type StudioActor } from "@/lib/studio-guest-session";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_ID = /^[0-9a-f]{32}$/;
const SOURCE_ACTIVE_LIMIT = 8;
const GLOBAL_ACTIVE_LIMIT = 24;
const USER_HOUR_LIMIT = 12;
const USER_DAY_LIMIT = 48;
const SOURCE_HOUR_LIMIT = 240;
const SOURCE_DAY_LIMIT = 1200;
const GLOBAL_HOUR_LIMIT = 1000;
const GLOBAL_DAY_LIMIT = 5000;
const GENERATION_KIND = "studio.app_generation.admitted";
const LEGACY_GENERATION_KIND = "studio.guest.generation.admitted";

type RateScope = "user" | "source" | "global";
type RateWindow = "hour" | "day";

export type StudioAppGenerationAdmission =
  | { reason: "accepted" }
  | { reason: "busy"; scope: "user" | "source" | "global" }
  | { reason: "rate_limit"; scope: RateScope; window: RateWindow; message: string }
  | { reason: "unavailable" };

function rateLimit(scope: RateScope, window: RateWindow): StudioAppGenerationAdmission {
  const subject = scope === "user"
    ? "You've made"
    : scope === "source"
      ? "This network has made"
      : "Browser Studio has handled";
  return {
    reason: "rate_limit",
    scope,
    window,
    message: `${subject} many comic pages in the past ${window}. Please try again later.`,
  };
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result &&
      Array.isArray(result.rows)) return result.rows as T[];
  throw new Error("Unexpected Studio guest capacity result");
}

function count(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error("Invalid Studio guest capacity count");
}

/** Persist the cost boundary before the first app-funded provider request. */
export async function markStudioAppGenerationPaidStarted(claimKey: string): Promise<void> {
  if (!claimKey.startsWith("web-") || claimKey.length > 300) {
    throw new Error("Invalid Studio generation claim key");
  }
  const eventKey = `studio-app-generation:${claimKey}`;
  const updated = rowsOf<{ event_key: string }>(await db.execute(sql`
    UPDATE activity_events
    SET status = 'paid_started'
    WHERE event_key = ${eventKey}
      AND kind = ${GENERATION_KIND}
      AND status = 'admitted'
    RETURNING event_key
  `));
  if (updated.length !== 1 || updated[0].event_key !== eventKey) {
    throw new Error("Studio generation admission was not found");
  }
}

/** Reserve a shared app-funded Studio slot without charging the legacy weekly quota. */
export async function reserveStudioAppGenerationCapacity(
  actor: StudioActor,
  claimKey: string,
  request: Request,
): Promise<StudioAppGenerationAdmission> {
  try {
    const userId = actor.userId;
    const sourceId = getStudioGuestSourceId(request);
    const budgetId = getStudioBudgetId(request, actor);
    const subject = `studio:${budgetId}`;
    if (!userId.trim() || userId.length > 200 || !claimKey.startsWith("web-") ||
        !claimKey.includes(`:${userId}:`) || claimKey.length > 300 ||
        !UUID_V4.test(budgetId) || !sourceId || !SOURCE_ID.test(sourceId)) {
      return { reason: "unavailable" };
    }
    return await db.transaction(async (tx) => {
      // One global transaction lock makes source and global counts atomic across replicas.
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(hashtext('twilio-comics:studio-guest-generation'), 1)
      `);
      const [usage] = rowsOf<{
        user_active: boolean;
        source_active: number | string;
        global_active: number | string;
        user_hour: number | string;
        user_day: number | string;
        source_hour: number | string;
        source_day: number | string;
        global_hour: number | string;
        global_day: number | string;
      }>(await tx.execute(sql`
        WITH recent_generations AS (
          SELECT events.occurred_at,
            events.details ->> 'sourceId' AS source_id,
            COALESCE(events.details ->> 'budgetId', events.user_id) AS budget_id,
            (claims.status = 'reserved'
              AND claims.created_at >= statement_timestamp() - INTERVAL '20 minutes') AS is_active
          FROM activity_events events
          JOIN free_tier_quota_claims claims
            ON claims.claim_key = (events.details ->> 'claimKey')
          WHERE events.kind IN (${GENERATION_KIND}, ${LEGACY_GENERATION_KIND})
            AND events.occurred_at >= statement_timestamp() - INTERVAL '24 hours'
            AND (
              claims.status = 'consumed'
              OR claims.status = 'reserved'
              OR events.status = 'paid_started'
            )
        )
        SELECT
          EXISTS (
            SELECT 1 FROM free_tier_quota_claims
            WHERE subject IN (${subject}, ${userId}, ${budgetId})
              AND status = 'reserved'
              AND created_at >= statement_timestamp() - INTERVAL '20 minutes'
          ) AS user_active,
          COUNT(*) FILTER (
            WHERE is_active AND source_id = ${sourceId}
          )::integer AS source_active,
          COUNT(*) FILTER (WHERE is_active)::integer AS global_active,
          COUNT(*) FILTER (
            WHERE budget_id = ${budgetId}
              AND occurred_at >= statement_timestamp() - INTERVAL '1 hour'
          )::integer AS user_hour,
          COUNT(*) FILTER (WHERE budget_id = ${budgetId})::integer AS user_day,
          COUNT(*) FILTER (
            WHERE source_id = ${sourceId}
              AND occurred_at >= statement_timestamp() - INTERVAL '1 hour'
          )::integer AS source_hour,
          COUNT(*) FILTER (WHERE source_id = ${sourceId})::integer AS source_day,
          COUNT(*) FILTER (
            WHERE occurred_at >= statement_timestamp() - INTERVAL '1 hour'
          )::integer AS global_hour,
          COUNT(*)::integer AS global_day
        FROM recent_generations
      `));
      if (!usage || typeof usage.user_active !== "boolean") {
        throw new Error("Missing Studio guest capacity counts");
      }
      if (usage.user_active) return { reason: "busy" as const, scope: "user" as const };
      // Released pre-provider failures are excluded. A paid-start marker and
      // unresolved reservations count for the full rolling window.
      const userHour = count(usage.user_hour);
      const userDay = count(usage.user_day);
      const sourceHour = count(usage.source_hour);
      const sourceDay = count(usage.source_day);
      const globalHour = count(usage.global_hour);
      const globalDay = count(usage.global_day);
      const sourceActive = count(usage.source_active);
      const globalActive = count(usage.global_active);
      if (userDay >= USER_DAY_LIMIT) return rateLimit("user", "day");
      if (userHour >= USER_HOUR_LIMIT) return rateLimit("user", "hour");
      if (sourceDay >= SOURCE_DAY_LIMIT) return rateLimit("source", "day");
      if (sourceHour >= SOURCE_HOUR_LIMIT) return rateLimit("source", "hour");
      if (globalDay >= GLOBAL_DAY_LIMIT) return rateLimit("global", "day");
      if (globalHour >= GLOBAL_HOUR_LIMIT) return rateLimit("global", "hour");
      if (sourceActive >= SOURCE_ACTIVE_LIMIT) {
        return { reason: "busy" as const, scope: "source" as const };
      }
      if (globalActive >= GLOBAL_ACTIVE_LIMIT) {
        return { reason: "busy" as const, scope: "global" as const };
      }

      // Claims use a synthetic subject, so the app-funded Studio path has no
      // seven-day user quota. Existing consume/release helpers still finalize it.
      const inserted = rowsOf<{ claim_key: string }>(await tx.execute(sql`
        INSERT INTO free_tier_quota_claims
          (claim_key, subject, window_started_at, status, created_at, updated_at)
        VALUES (${claimKey}, ${subject}, statement_timestamp(), 'reserved',
          statement_timestamp(), statement_timestamp())
        ON CONFLICT (claim_key) DO NOTHING
        RETURNING claim_key
      `));
      if (inserted[0]?.claim_key !== claimKey) throw new Error("Studio claim key already exists");
      await tx.insert(activityEvents).values({
        eventKey: `studio-app-generation:${claimKey}`,
        occurredAt: sql`statement_timestamp()`,
        userId,
        channel: "web",
        kind: GENERATION_KIND,
        direction: "inbound",
        status: "admitted",
        details: { sourceId, claimKey, budgetId },
      });
      return { reason: "accepted" as const };
    });
  } catch (error) {
    console.error("Studio guest generation capacity unavailable", error instanceof Error ? error.name : "unknown");
    return { reason: "unavailable" };
  }
}
