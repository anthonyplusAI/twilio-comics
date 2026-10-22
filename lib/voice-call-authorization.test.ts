import { describe, expect, it } from "vitest";
import {
  createVoiceCallAuthorization,
  verifyVoiceCallAuthorization,
} from "@/lib/voice-call-authorization";

const secret = "a-test-auth-secret-that-is-long-and-private";
const call = {
  callSid: `CA${"a".repeat(32)}`,
  from: "+15551234567",
  to: "+18669012028",
};
const now = Date.UTC(2026, 9, 21, 20, 0, 0);

describe("Voice call authorization after SMS verification", () => {
  it("accepts a short-lived token bound to the exact call and addresses", () => {
    const token = createVoiceCallAuthorization(call, secret, now);

    expect(verifyVoiceCallAuthorization(token, call, secret, now + 60_000)).toBe(true);
    expect(verifyVoiceCallAuthorization(token, { ...call, from: "+15550001111" }, secret, now)).toBe(false);
    expect(verifyVoiceCallAuthorization(token, { ...call, callSid: `CA${"b".repeat(32)}` }, secret, now)).toBe(false);
    expect(verifyVoiceCallAuthorization(token, { ...call, to: "+18669012029" }, secret, now)).toBe(false);
  });

  it("rejects tampering, expiry, malformed input, and a different secret", () => {
    const token = createVoiceCallAuthorization(call, secret, now);

    expect(verifyVoiceCallAuthorization(token, call, "another-secret", now)).toBe(false);
    expect(verifyVoiceCallAuthorization(`${token}x`, call, secret, now)).toBe(false);
    expect(verifyVoiceCallAuthorization(token, call, secret, now + 5 * 60_000 + 1)).toBe(false);
    expect(verifyVoiceCallAuthorization(token, call, secret, now - 31_000)).toBe(false);
    expect(verifyVoiceCallAuthorization("bad", call, secret, now)).toBe(false);
    expect(verifyVoiceCallAuthorization("x".repeat(1_000), call, secret, now)).toBe(false);
    expect(verifyVoiceCallAuthorization(token, call, "", now)).toBe(false);
  });
});
