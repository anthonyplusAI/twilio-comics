import { describe, it, expect } from "vitest";
import { isContentPolicyViolation } from "@/lib/utils";

describe("isContentPolicyViolation", () => {
  it("matches legacy image-provider phrasing", () => {
    expect(isContentPolicyViolation("Invalid content detected")).toBe(true);
  });

  it("does not assume a missing image is a safety block", () => {
    expect(isContentPolicyViolation("NO_IMAGE")).toBe(false);
    expect(isContentPolicyViolation("NO_IMAGE: no image data returned")).toBe(false);
  });

  it("matches OpenAI moderation phrasing", () => {
    expect(isContentPolicyViolation("Your request was rejected as a result of our safety system")).toBe(true);
    expect(isContentPolicyViolation("This request may violate our content policy")).toBe(true);
    expect(isContentPolicyViolation("moderation_blocked")).toBe(true);
    expect(isContentPolicyViolation("CONTENT_POLICY_VIOLATION")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isContentPolicyViolation("connection timeout")).toBe(false);
  });
});
