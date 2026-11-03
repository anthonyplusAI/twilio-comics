import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { activityEvents } from "@/lib/schema";

const UPLOAD_KIND = "web.blob_upload.requested";
const MAX_UPLOADS_PER_MINUTE = 20;
const MAX_UPLOADS_PER_DAY = 120;

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result &&
      Array.isArray(result.rows)) return result.rows as T[];
  throw new Error("Unexpected upload budget query result");
}

function count(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new Error("Invalid upload budget count");
}

/** Atomically reserves one upload attempt across Container App replicas. */
export async function reserveBrowserUpload(
  userId: string,
): Promise<{ allowed: true } | { allowed: false; reason: "rate_limit" | "unavailable" }> {
  if (!userId.trim()) return { allowed: false, reason: "unavailable" };

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtext('twilio-comics:web-upload'), hashtext(${userId})
        )
      `);
      const [usage] = rowsOf<{ minute_count: number | string; day_count: number | string }>(
        await tx.execute(sql`
          SELECT
            COUNT(*) FILTER (
              WHERE occurred_at >= statement_timestamp() - INTERVAL '1 minute'
            )::integer AS minute_count,
            COUNT(*)::integer AS day_count
          FROM activity_events
          WHERE user_id = ${userId}
            AND kind = ${UPLOAD_KIND}
            AND occurred_at >= statement_timestamp() - INTERVAL '24 hours'
        `),
      );
      if (!usage) throw new Error("Missing upload budget counts");
      if (count(usage.minute_count) >= MAX_UPLOADS_PER_MINUTE ||
          count(usage.day_count) >= MAX_UPLOADS_PER_DAY) {
        return { allowed: false as const, reason: "rate_limit" as const };
      }

      await tx.insert(activityEvents).values({
        eventKey: `web-upload:${randomUUID()}`,
        occurredAt: sql`statement_timestamp()`,
        userId,
        channel: "web",
        kind: UPLOAD_KIND,
        direction: "inbound",
        status: "requested",
      });
      return { allowed: true as const };
    });
  } catch (error) {
    console.error("Browser upload budget unavailable", error instanceof Error ? error.name : "unknown");
    return { allowed: false, reason: "unavailable" };
  }
}
