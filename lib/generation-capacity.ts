import { db } from "@/lib/db";
import { reserveFreeTierQuota, type QuotaResult } from "@/lib/quota";

export type BrowserGenerationAdmission =
  | { reason: "accepted"; quota: QuotaResult }
  | { reason: "weekly_limit"; quota: QuotaResult };

/** Reserve one app-funded browser credit in the user's seven-day quota. */
export async function reserveBrowserGenerationCapacity(
  userId: string,
  weeklyClaimKey: string,
): Promise<BrowserGenerationAdmission> {
  return db.transaction(async (tx) => {
    const quota = await reserveFreeTierQuota(userId, weeklyClaimKey, tx);
    if (!quota.allowed) return { reason: "weekly_limit", quota };
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
