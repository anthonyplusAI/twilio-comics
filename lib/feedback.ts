import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { feedback } from "@/lib/schema";

const MAX_FEEDBACK_PER_DAY = 5;

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result &&
      Array.isArray(result.rows)) return result.rows as T[];
  throw new Error("Unexpected feedback query result");
}

/** A signed-in studio tester can save at most five feedback messages per day. */
export async function submitTesterFeedback(userId: string, message: string): Promise<boolean> {
  if (!userId || !message.trim() || message.length > 2_000) {
    throw new Error("Invalid feedback submission");
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtext('twilio-comics:feedback'),
        hashtext(${userId})
      )
    `);
    const usage = rowsOf<{ count: number | string }>(await tx.execute(sql`
      SELECT COUNT(*)::integer AS count
      FROM feedback
      WHERE user_id = ${userId}
        AND created_at >= statement_timestamp() - INTERVAL '24 hours'
    `))[0];
    const count = Number(usage?.count);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("Invalid feedback usage count");
    }
    if (count >= MAX_FEEDBACK_PER_DAY) return false;

    const [created] = await tx.insert(feedback)
      .values({ userId, message })
      .returning({ id: feedback.id });
    if (!created) throw new Error("Feedback insert failed");
    return true;
  });
}
