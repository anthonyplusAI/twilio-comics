/** Legacy reason saved on jobs denied by the former shared daily cap. */
export const DAILY_GENERATION_CAPACITY_REASON = "daily_generation_capacity";

/** Interpret capacity rejections saved before the shared cap was removed. */
export function isDailyGenerationCapacityRejection(job: {
  status: string;
  lastError?: string | null;
}): boolean {
  return job.status === "quota_rejected" &&
    job.lastError === DAILY_GENERATION_CAPACITY_REASON;
}
