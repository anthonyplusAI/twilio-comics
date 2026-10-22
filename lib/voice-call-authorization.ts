import { createHmac, timingSafeEqual } from "node:crypto";

export interface VoiceCallIdentity {
  callSid: string;
  from: string;
  to: string;
}

const CALL_SID = /^CA[0-9a-f]{32}$/i;
const E164 = /^\+[1-9]\d{6,14}$/;
const TOKEN_TTL_MS = 5 * 60_000;
const CLOCK_SKEW_MS = 30_000;

function validCall(call: VoiceCallIdentity): boolean {
  return CALL_SID.test(call.callSid) && E164.test(call.from) && E164.test(call.to);
}

function signature(call: VoiceCallIdentity, issuedAt: number, secret: string): Buffer {
  return createHmac("sha256", secret)
    .update(`twilio-comics:verified-voice:v1\n${call.callSid}\n${call.from}\n${call.to}\n${issuedAt}`)
    .digest();
}

/** Issued only after Twilio Verify approves the caller's SMS code. */
export function createVoiceCallAuthorization(
  call: VoiceCallIdentity,
  secret: string,
  now = Date.now(),
): string {
  if (!validCall(call) || !secret || !Number.isSafeInteger(now) || now < 0) {
    throw new Error("Cannot authorize an invalid Voice call");
  }
  return `${now.toString(36)}.${signature(call, now, secret).toString("base64url")}`;
}

/** A relay setup proves the exact call passed the keypad/SMS check recently. */
export function verifyVoiceCallAuthorization(
  token: string | undefined,
  call: VoiceCallIdentity,
  secret: string | undefined,
  now = Date.now(),
): boolean {
  if (!token || token.length > 100 || !validCall(call) || !secret || !Number.isSafeInteger(now)) {
    return false;
  }
  const match = /^([0-9a-z]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return false;

  const issuedAt = Number.parseInt(match[1], 36);
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0 ||
      issuedAt > now + CLOCK_SKEW_MS || now - issuedAt > TOKEN_TTL_MS) {
    return false;
  }
  const supplied = Buffer.from(match[2], "base64url");
  const expected = signature(call, issuedAt, secret);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
