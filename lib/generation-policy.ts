export const DAILY_GENERATION_CAPACITY_REASON = "daily_generation_capacity";
export const DEFAULT_DAILY_GENERATION_JOB_LIMIT = 25;

/** Zero pauses new comic jobs. Invalid configuration fails closed. */
export function dailyGenerationJobLimit(): number {
  const configured = process.env.DAILY_GENERATION_JOB_LIMIT;
  if (configured === undefined || configured === "") {
    return DEFAULT_DAILY_GENERATION_JOB_LIMIT;
  }
  if (!/^\d+$/.test(configured)) {
    throw new Error("DAILY_GENERATION_JOB_LIMIT must be a whole number from 0 to 10000");
  }
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed > 10_000) {
    throw new Error("DAILY_GENERATION_JOB_LIMIT must be a whole number from 0 to 10000");
  }
  return parsed;
}

export function isDailyGenerationCapacityRejection(job: {
  status: string;
  lastError?: string | null;
}): boolean {
  return job.status === "quota_rejected" &&
    job.lastError === DAILY_GENERATION_CAPACITY_REASON;
}
