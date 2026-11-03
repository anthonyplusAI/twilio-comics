import { describe, expect, it } from "vitest";
import { isDailyGenerationCapacityRejection } from "@/lib/generation-policy";

describe("historical daily capacity rejections", () => {
  it("distinguishes an old capacity denial from a user's weekly quota", () => {
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
