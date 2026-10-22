import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dailyGenerationJobLimit,
  isDailyGenerationCapacityRejection,
} from "@/lib/generation-policy";

afterEach(() => vi.unstubAllEnvs());

describe("daily comic generation policy", () => {
  it("defaults to a conservative daily admission limit", () => {
    vi.stubEnv("DAILY_GENERATION_JOB_LIMIT", undefined);
    expect(dailyGenerationJobLimit()).toBe(25);
  });

  it("allows an explicit zero to pause new admissions", () => {
    vi.stubEnv("DAILY_GENERATION_JOB_LIMIT", "0");
    expect(dailyGenerationJobLimit()).toBe(0);
  });

  it.each(["-1", "1.5", "NaN", "10001", " 25 "])(
    "fails closed for invalid configuration %s",
    (value) => {
      vi.stubEnv("DAILY_GENERATION_JOB_LIMIT", value);
      expect(dailyGenerationJobLimit).toThrow(/whole number/);
    },
  );

  it("distinguishes a daily capacity denial from a user's weekly quota", () => {
    expect(isDailyGenerationCapacityRejection({
      status: "quota_rejected",
      lastError: "daily_generation_capacity",
    })).toBe(true);
    expect(isDailyGenerationCapacityRejection({
      status: "quota_rejected",
      lastError: null,
    })).toBe(false);
  });
});
