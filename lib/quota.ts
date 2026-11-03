import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export const DEFAULT_GENERATION_QUOTA_LIMIT = 3;
export const MAX_GENERATION_QUOTA_OVERRIDE = 10_000;
export const UNLIMITED_GENERATION_QUOTA_OVERRIDE = -1;
const WINDOW_DAYS = 7;
export type QuotaRemaining = number | "unlimited";

interface QuotaRow {
  status: "reserved" | "consumed" | "released" | "rejected";
  used: number | null;
  window_started_at: Date | string | null;
  generation_limit: number | string;
}

interface ReservationRow {
  subject: string;
  status: QuotaRow["status"] | "pending";
  used: number | null;
  window_started_at: Date | string | null;
  generation_limit: number | string;
}

export interface QuotaResult {
  allowed: boolean;
  remaining: QuotaRemaining;
  reset: number | null;
  status: QuotaRow["status"];
}

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows?: T[] }).rows ?? (result as T[]);
}

function effectiveLimit(value: number | string): number {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) ||
      limit < UNLIMITED_GENERATION_QUOTA_OVERRIDE ||
      limit > MAX_GENERATION_QUOTA_OVERRIDE) {
    throw new Error("Invalid generation quota limit");
  }
  return limit;
}

function remainingFor(limit: number, used: number): QuotaRemaining {
  return limit === UNLIMITED_GENERATION_QUOTA_OVERRIDE
    ? "unlimited"
    : Math.max(0, limit - used);
}

function resultFromRow(row: QuotaRow): QuotaResult {
  const limit = effectiveLimit(row.generation_limit);
  const start = row.window_started_at
    ? new Date(row.window_started_at).getTime()
    : null;
  const active = start !== null && start + WINDOW_DAYS * 86_400_000 > Date.now();
  const used = active ? Number(row.used ?? 0) : 0;
  return {
    allowed: row.status === "reserved" || row.status === "consumed",
    remaining: remainingFor(limit, used),
    reset: active && limit !== UNLIMITED_GENERATION_QUOTA_OVERRIDE
      ? start + WINDOW_DAYS * 86_400_000 : null,
    status: row.status,
  };
}

export async function getFreeTierQuota(subject: string, executor: Pick<typeof db, "execute"> = db): Promise<{
  remaining: QuotaRemaining;
  reset: number | null;
}> {
  const result = await executor.execute(sql`
    SELECT quota.used, quota.window_started_at,
      COALESCE((
        SELECT generation_quota_limit FROM users WHERE id = ${subject}
      ), ${DEFAULT_GENERATION_QUOTA_LIMIT}) AS generation_limit
    FROM (SELECT 1) AS singleton
    LEFT JOIN free_tier_quotas AS quota ON quota.subject = ${subject}
  `);
  const row = rowsOf<{
    used: number | null;
    window_started_at: Date | string | null;
    generation_limit: number | string;
  }>(result)[0];
  if (!row) throw new Error("Failed to read generation quota");
  const limit = effectiveLimit(row.generation_limit);
  if (limit === UNLIMITED_GENERATION_QUOTA_OVERRIDE) {
    return { remaining: "unlimited", reset: null };
  }
  if (!row.window_started_at) return { remaining: limit, reset: null };

  const start = new Date(row.window_started_at).getTime();
  if (start + WINDOW_DAYS * 86_400_000 <= Date.now()) {
    return { remaining: limit, reset: null };
  }
  return {
    remaining: remainingFor(limit, Number(row.used ?? 0)),
    reset: start + WINDOW_DAYS * 86_400_000,
  };
}

export async function reserveFreeTierQuota(
  subject: string,
  claimKey: string,
  executor: Pick<typeof db, "execute"> = db,
): Promise<QuotaResult> {
  // PostgreSQL cannot UPDATE a claim inserted by a sibling data-modifying
  // CTE. A separate INSERT makes the claim visible to the reservation query.
  await executor.execute(sql`
    INSERT INTO free_tier_quota_claims
      (claim_key, subject, window_started_at, status, created_at, updated_at)
    VALUES (${claimKey}, ${subject}, NOW(), 'pending', NOW(), NOW())
    ON CONFLICT (claim_key) DO NOTHING
  `);

  // Lock the existing claim to serialize retries for one idempotency key.
  // The quota upsert and claim finalization share this statement's transaction.
  const result = await executor.execute(sql`
    WITH effective_limit AS MATERIALIZED (
      SELECT COALESCE(generation_quota_limit, ${DEFAULT_GENERATION_QUOTA_LIMIT})
        AS generation_limit
      FROM users
      WHERE id = ${subject}
      FOR SHARE
    ),
    locked_claim AS MATERIALIZED (
      SELECT claim_key, subject, status, window_started_at
      FROM free_tier_quota_claims
      WHERE claim_key = ${claimKey}
      FOR UPDATE
    ),
    quota_result AS (
      INSERT INTO free_tier_quotas
        (subject, window_started_at, used, updated_at)
      SELECT locked_claim.subject, NOW(), 1, NOW()
      FROM locked_claim
      CROSS JOIN effective_limit
      WHERE locked_claim.status = 'pending'
        AND locked_claim.subject = ${subject}
        AND (effective_limit.generation_limit = -1 OR effective_limit.generation_limit > 0)
      ON CONFLICT (subject) DO UPDATE SET
        window_started_at = CASE
          WHEN free_tier_quotas.window_started_at <= NOW() - INTERVAL '7 days'
            THEN NOW()
          ELSE free_tier_quotas.window_started_at
        END,
        used = CASE
          WHEN free_tier_quotas.window_started_at <= NOW() - INTERVAL '7 days'
            THEN 1
          ELSE free_tier_quotas.used + 1
        END,
        updated_at = NOW()
      WHERE free_tier_quotas.window_started_at <= NOW() - INTERVAL '7 days'
         OR (SELECT generation_limit FROM effective_limit) = -1
         OR free_tier_quotas.used < (SELECT generation_limit FROM effective_limit)
      RETURNING used, window_started_at
    ),
    finalized_claim AS (
      UPDATE free_tier_quota_claims claim
      SET
        status = CASE
          WHEN EXISTS (SELECT 1 FROM quota_result) THEN 'reserved'
          ELSE 'rejected'
        END,
        window_started_at = COALESCE(
          (SELECT window_started_at FROM quota_result),
          claim.window_started_at
        ),
        updated_at = NOW()
      FROM locked_claim
      WHERE claim.claim_key = locked_claim.claim_key
        AND locked_claim.status = 'pending'
        AND locked_claim.subject = ${subject}
      RETURNING claim.subject, claim.status, claim.window_started_at
    )
    SELECT
      finalized_claim.subject,
      finalized_claim.status,
      quota_result.used,
      finalized_claim.window_started_at,
      effective_limit.generation_limit
    FROM finalized_claim
    CROSS JOIN effective_limit
    LEFT JOIN quota_result ON TRUE
    UNION ALL
    SELECT
      locked_claim.subject,
      locked_claim.status,
      NULL::integer AS used,
      locked_claim.window_started_at,
      effective_limit.generation_limit
    FROM locked_claim
    CROSS JOIN effective_limit
    WHERE NOT EXISTS (SELECT 1 FROM finalized_claim)
  `);
  const row = rowsOf<ReservationRow>(result)[0];
  if (!row) throw new Error("Failed to reserve generation quota");
  if (row.subject !== subject) {
    throw new Error("Quota claim key belongs to another subject");
  }
  if (row.status === "pending") {
    throw new Error("Failed to finalize generation quota claim");
  }

  if (row.used !== null) {
    return resultFromRow({
      status: row.status,
      used: row.used,
      window_started_at: row.window_started_at,
      generation_limit: row.generation_limit,
    });
  }

  // A duplicate or rejected claim has no quota_result row. Read in a new
  // statement so its allowance reflects concurrent reservations and releases.
  const quota = await getFreeTierQuota(subject, executor);
  return {
    allowed: row.status === "reserved" || row.status === "consumed",
    remaining: quota.remaining,
    reset: quota.reset,
    status: row.status,
  };
}

export async function consumeFreeTierQuota(claimKey: string): Promise<void> {
  await db.execute(sql`
    UPDATE free_tier_quota_claims
    SET status = 'consumed', updated_at = NOW()
    WHERE claim_key = ${claimKey} AND status = 'reserved'
  `);
}

export async function releaseFreeTierQuota(
  claimKey: string,
  executor: Pick<typeof db, "execute"> = db,
): Promise<void> {
  await executor.execute(sql`
    WITH released AS (
      UPDATE free_tier_quota_claims
      SET status = 'released', updated_at = NOW()
      WHERE claim_key = ${claimKey} AND status = 'reserved'
      RETURNING subject, window_started_at
    )
    UPDATE free_tier_quotas quota
    SET used = GREATEST(0, quota.used - 1), updated_at = NOW()
    FROM released
    WHERE quota.subject = released.subject
      AND quota.window_started_at = released.window_started_at
  `);
}
