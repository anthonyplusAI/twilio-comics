import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

const LIMIT = 3;
const WINDOW_DAYS = 7;

interface QuotaRow {
  status: "reserved" | "consumed" | "released" | "rejected";
  used: number | null;
  window_started_at: Date | string | null;
}

interface ReservationRow {
  subject: string;
  status: QuotaRow["status"] | "pending";
  used: number | null;
  window_started_at: Date | string | null;
}

export interface QuotaResult {
  allowed: boolean;
  remaining: number;
  reset: number | null;
  status: QuotaRow["status"];
}

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows?: T[] }).rows ?? (result as T[]);
}

function resultFromRow(row: QuotaRow): QuotaResult {
  const start = row.window_started_at
    ? new Date(row.window_started_at).getTime()
    : null;
  const active = start !== null && start + WINDOW_DAYS * 86_400_000 > Date.now();
  const used = active ? Number(row.used ?? 0) : 0;
  return {
    allowed: row.status === "reserved" || row.status === "consumed",
    remaining: Math.max(0, LIMIT - used),
    reset: active ? start + WINDOW_DAYS * 86_400_000 : null,
    status: row.status,
  };
}

export async function getFreeTierQuota(subject: string): Promise<{
  remaining: number;
  reset: number | null;
}> {
  const result = await db.execute(sql`
    SELECT used, window_started_at
    FROM free_tier_quotas
    WHERE subject = ${subject}
  `);
  const row = rowsOf<{ used: number; window_started_at: Date | string }>(result)[0];
  if (!row) return { remaining: LIMIT, reset: null };

  const start = new Date(row.window_started_at).getTime();
  if (start + WINDOW_DAYS * 86_400_000 <= Date.now()) {
    return { remaining: LIMIT, reset: null };
  }
  return {
    remaining: Math.max(0, LIMIT - Number(row.used)),
    reset: start + WINDOW_DAYS * 86_400_000,
  };
}

export async function reserveFreeTierQuota(
  subject: string,
  claimKey: string,
): Promise<QuotaResult> {
  // PostgreSQL cannot UPDATE a claim inserted by a sibling data-modifying
  // CTE. A separate INSERT makes the claim visible to the reservation query.
  await db.execute(sql`
    INSERT INTO free_tier_quota_claims
      (claim_key, subject, window_started_at, status, created_at, updated_at)
    VALUES (${claimKey}, ${subject}, NOW(), 'pending', NOW(), NOW())
    ON CONFLICT (claim_key) DO NOTHING
  `);

  // Lock the existing claim to serialize retries for one idempotency key.
  // The quota upsert and claim finalization share this statement's transaction.
  const result = await db.execute(sql`
    WITH locked_claim AS MATERIALIZED (
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
      WHERE locked_claim.status = 'pending'
        AND locked_claim.subject = ${subject}
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
         OR free_tier_quotas.used < ${LIMIT}
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
      finalized_claim.window_started_at
    FROM finalized_claim
    LEFT JOIN quota_result ON TRUE
    UNION ALL
    SELECT
      locked_claim.subject,
      locked_claim.status,
      NULL::integer AS used,
      locked_claim.window_started_at
    FROM locked_claim
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
    });
  }

  // A duplicate or rejected claim has no quota_result row. Read in a new
  // statement so its allowance reflects concurrent reservations and releases.
  const quota = await getFreeTierQuota(subject);
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

export async function releaseFreeTierQuota(claimKey: string): Promise<void> {
  await db.execute(sql`
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
