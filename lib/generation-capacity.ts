import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dailyGenerationJobLimit } from "@/lib/generation-policy";
import {
  releaseFreeTierQuota,
  reserveFreeTierQuota,
  type QuotaResult,
} from "@/lib/quota";

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows?: T[] }).rows ?? (result as T[]);
}

/**
 * The nonpersonal ledger survives user deletion. One transaction advisory lock
 * serializes admissions across SMS, Voice, and app-funded browser requests.
 * A claim stays reserved after generation failure because an OpenAI request
 * may already have incurred cost. Reusing a job key does not charge twice.
 */
export async function reserveDailyGenerationCapacity(
  requestKey: string,
  executor: Pick<typeof db, "execute">,
): Promise<boolean> {
  const limit = dailyGenerationJobLimit();
  const claimKey = `generation-capacity:${requestKey}`;
  await executor.execute(sql`
    SELECT pg_advisory_xact_lock(hashtext('twilio-comics:generation-capacity'), 1)
  `);
  const existing = rowsOf<{ subject: string; status: string }>(await executor.execute(sql`
    SELECT subject, status FROM free_tier_quota_claims
    WHERE claim_key = ${claimKey}
    LIMIT 1
  `))[0];
  if (existing) {
    if (!existing.subject.startsWith("system:generation:daily:")) {
      throw new Error("Generation capacity claim belongs to another subject");
    }
    if (existing.status !== "reserved") {
      throw new Error("Generation capacity claim has an invalid status");
    }
    return true;
  }

  const usage = rowsOf<{
    subject: string;
    used: number | string;
  }>(await executor.execute(sql`
    WITH budget_day AS (
      SELECT
        'system:generation:daily:' ||
          to_char(timezone('UTC', transaction_timestamp()), 'YYYY-MM-DD') AS subject
    )
    SELECT budget_day.subject,
      COUNT(claim.claim_key)::integer AS used
    FROM budget_day
    LEFT JOIN free_tier_quota_claims claim
      ON claim.subject = budget_day.subject AND claim.status = 'reserved'
    GROUP BY budget_day.subject
  `))[0];
  const used = Number(usage?.used);
  if (!usage || !Number.isSafeInteger(used) || used < 0 ||
      !/^system:generation:daily:\d{4}-\d{2}-\d{2}$/.test(usage.subject)) {
    throw new Error("Invalid daily generation capacity result");
  }
  if (used >= limit) return false;

  const inserted = rowsOf<{ claim_key: string }>(await executor.execute(sql`
    INSERT INTO free_tier_quota_claims
      (claim_key, subject, window_started_at, status, created_at, updated_at)
    VALUES (
      ${claimKey}, ${usage.subject}, NOW(),
      'reserved', NOW(), NOW()
    )
    ON CONFLICT (claim_key) DO NOTHING
    RETURNING claim_key
  `));
  if (inserted.length !== 1 || inserted[0].claim_key !== claimKey) {
    throw new Error("Generation capacity admission race");
  }
  return true;
}

export type BrowserGenerationAdmission =
  | { reason: "accepted"; quota: QuotaResult }
  | { reason: "weekly_limit" | "daily_capacity"; quota: QuotaResult };

/** Reserves a weekly credit and a global daily slot in the same transaction. */
export async function reserveBrowserGenerationCapacity(
  userId: string,
  weeklyClaimKey: string,
): Promise<BrowserGenerationAdmission> {
  return db.transaction(async (tx) => {
    const quota = await reserveFreeTierQuota(userId, weeklyClaimKey, tx);
    if (!quota.allowed) return { reason: "weekly_limit", quota };
    if (!(await reserveDailyGenerationCapacity(`web:${randomUUID()}`, tx))) {
      if (quota.status !== "reserved") {
        throw new Error("Cannot release a consumed quota claim after capacity denial");
      }
      await releaseFreeTierQuota(weeklyClaimKey, tx);
      return { reason: "daily_capacity", quota };
    }
    return { reason: "accepted", quota };
  });
}

export type GenerationKeyChoice =
  | { valid: true; apiKey: string; appFunded: boolean }
  | { valid: false; reason: "invalid" | "missing" };

/** A present but malformed caller key must never fall back to the app key. */
export function chooseGenerationApiKey(
  provided: unknown,
  configured: string | undefined,
): GenerationKeyChoice {
  const serverKey = configured?.trim();
  if (provided === undefined) {
    return serverKey
      ? { valid: true, apiKey: serverKey, appFunded: true }
      : { valid: false, reason: "missing" };
  }
  if (typeof provided !== "string") return { valid: false, reason: "invalid" };
  const key = provided.trim();
  if (key === serverKey && serverKey) {
    return { valid: true, apiKey: serverKey, appFunded: true };
  }
  if (key.length < 20 || key.length > 512 || /\s|[^\x21-\x7E]/.test(key)) {
    return { valid: false, reason: "invalid" };
  }
  return { valid: true, apiKey: key, appFunded: false };
}
