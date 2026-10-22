import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import twilio from "twilio";
import { POST } from "@/app/api/twilio/voice/route";

const { startVoiceVerification, reserveVoiceVerificationStart, finishVoiceVerificationStart } = vi.hoisted(() => ({
  startVoiceVerification: vi.fn(),
  reserveVoiceVerificationStart: vi.fn(),
  finishVoiceVerificationStart: vi.fn(),
}));
vi.mock("@/lib/voice-verification", () => ({
  isVoiceVerificationConfigured: () => Boolean(process.env.TWILIO_VERIFY_SERVICE_SID),
  startVoiceVerification,
}));
vi.mock("@/lib/voice-verification-budget", () => ({
  reserveVoiceVerificationStart,
  finishVoiceVerificationStart,
}));

const BASE = "https://comics.example";
const TOKEN = "test-twilio-auth-token";
const ACCOUNT_SID = `AC${"c".repeat(32)}`;
const CALL_SID = `CA${"a".repeat(32)}`;
const PHONE_NUMBER = "+12025550123";
const CALL_PARAMS = {
  AccountSid: ACCOUNT_SID,
  CallSid: CALL_SID,
  From: "+15551234567",
  To: PHONE_NUMBER,
};

function signedRequest(path: string, params: Record<string, string>, valid = true): NextRequest {
  const url = `${BASE}${path}`;
  const signature = valid
    ? twilio.getExpectedTwilioSignature(TOKEN, url, params)
    : "invalid-signature";
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    body: new URLSearchParams(params).toString(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  startVoiceVerification.mockResolvedValue(undefined);
  reserveVoiceVerificationStart.mockResolvedValue({ allowed: true, sendCode: true });
  finishVoiceVerificationStart.mockResolvedValue(undefined);
  vi.stubEnv("TWILIO_ACCOUNT_SID", ACCOUNT_SID);
  vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
  vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", `VA${"d".repeat(32)}`);
  vi.stubEnv("TWILIO_PHONE_NUMBER", PHONE_NUMBER);
  vi.stubEnv("TWILIO_ENABLED_CHANNELS", "sms,voice");
  vi.stubEnv("AUTH_SECRET", "test-auth-secret");
  vi.stubEnv("PUBLIC_BASE_URL", BASE);
  vi.stubEnv("CONVERSATION_RELAY_WS_URL", "wss://comics.example/relay");
});

afterEach(() => vi.unstubAllEnvs());

describe("inbound voice verification", () => {
  it("starts SMS verification for the signed caller before collecting keypad digits", async () => {
    const response = await POST(signedRequest("/api/twilio/voice", CALL_PARAMS));
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(startVoiceVerification).toHaveBeenCalledExactlyOnceWith(CALL_PARAMS.From);
    expect(reserveVoiceVerificationStart).toHaveBeenCalledWith({
      callSid: CALL_SID,
      fromAddress: CALL_PARAMS.From,
      toAddress: PHONE_NUMBER,
    });
    expect(finishVoiceVerificationStart).toHaveBeenCalledExactlyOnceWith(CALL_SID, "sent");
    expect(xml).toContain('<Gather action="https://comics.example/api/twilio/voice/verify?attempt=1"');
    expect(xml).toContain('input="dtmf"');
    expect(xml).toContain('numDigits="6"');
    expect(xml).toMatch(/text.+code.+keypad/i);
    expect(xml).not.toContain("<ConversationRelay");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects a forged webhook before sending a code", async () => {
    const response = await POST(signedRequest("/api/twilio/voice", CALL_PARAMS, false));
    expect(response.status).toBe(403);
    expect(startVoiceVerification).not.toHaveBeenCalled();
  });

  it("rejects a signed call from another Twilio account", async () => {
    const response = await POST(signedRequest("/api/twilio/voice", {
      ...CALL_PARAMS,
      AccountSid: `AC${"b".repeat(32)}`,
    }));
    expect(response.status).toBe(403);
    expect(startVoiceVerification).not.toHaveBeenCalled();
  });

  it("refuses a non-TLS or unexpected Relay URL before sending a code", async () => {
    for (const url of ["ws://comics.example/relay", "wss://comics.example/not-relay", "wss://comics.example/relay?token=secret"]) {
      vi.stubEnv("CONVERSATION_RELAY_WS_URL", url);
      const response = await POST(signedRequest("/api/twilio/voice", CALL_PARAMS));
      expect(response.status).toBe(503);
    }
    expect(startVoiceVerification).not.toHaveBeenCalled();
  });

  it("reports missing Twilio signature configuration as unavailable", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    const response = await POST(signedRequest("/api/twilio/voice", CALL_PARAMS));
    expect(response.status).toBe(503);
  });

  it("refuses a signed call when Voice or its verification is not configured", async () => {
    for (const [name, value] of [
      ["TWILIO_PHONE_NUMBER", ""],
      ["TWILIO_ENABLED_CHANNELS", "sms"],
      ["TWILIO_VERIFY_SERVICE_SID", ""],
      ["AUTH_SECRET", ""],
    ]) {
      vi.stubEnv(name, value);
      const response = await POST(signedRequest("/api/twilio/voice", CALL_PARAMS));
      expect(response.status).toBe(503);
      vi.stubEnv(name, name === "TWILIO_PHONE_NUMBER" ? PHONE_NUMBER
        : name === "TWILIO_ENABLED_CHANNELS" ? "sms,voice"
          : name === "TWILIO_VERIFY_SERVICE_SID" ? `VA${"d".repeat(32)}` : "test-auth-secret");
    }
    expect(startVoiceVerification).not.toHaveBeenCalled();
  });

  it("starts a selected Voice call when inbound SMS is disabled", async () => {
    vi.stubEnv("TWILIO_ENABLED_CHANNELS", "voice");
    const response = await POST(signedRequest("/api/twilio/voice", CALL_PARAMS));
    expect(response.status).toBe(200);
    expect(startVoiceVerification).toHaveBeenCalledOnce();
  });

  it("rejects a signed call to an unrelated number or with a malformed caller", async () => {
    const wrongNumber = await POST(signedRequest("/api/twilio/voice", {
      ...CALL_PARAMS,
      To: "+12025550199",
    }));
    expect(wrongNumber.status).toBe(403);

    const noTextAddress = await POST(signedRequest("/api/twilio/voice", {
      ...CALL_PARAMS,
      From: "anonymous",
    }));
    expect(noTextAddress.status).toBe(200);
    expect(await noTextAddress.text()).toMatch(/phone.+text/i);
    expect(startVoiceVerification).not.toHaveBeenCalled();
  });

  it("speaks a retry message and hangs up if Verify cannot send", async () => {
    startVoiceVerification.mockRejectedValueOnce(new Error("Twilio unavailable"));
    const response = await POST(signedRequest("/api/twilio/voice", CALL_PARAMS));
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/try again/i);
    expect(finishVoiceVerificationStart).toHaveBeenCalledExactlyOnceWith(CALL_SID, "failed");
  });

  it("does not send another code for a repeated signed CallSid", async () => {
    reserveVoiceVerificationStart.mockResolvedValueOnce({ allowed: true, sendCode: false });
    const response = await POST(signedRequest("/api/twilio/voice", CALL_PARAMS));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<Gather");
    expect(startVoiceVerification).not.toHaveBeenCalled();
    expect(finishVoiceVerificationStart).not.toHaveBeenCalled();
  });

  it("hangs up before Verify when the per-caller code budget is exhausted", async () => {
    reserveVoiceVerificationStart.mockResolvedValueOnce({
      allowed: false,
      reason: "rate_limit",
    });
    const response = await POST(signedRequest("/api/twilio/voice", CALL_PARAMS));

    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/too many verification codes/i);
    expect(startVoiceVerification).not.toHaveBeenCalled();
  });

  it("caps even chunked signed webhook bodies before parsing", async () => {
    const response = await POST(signedRequest("/api/twilio/voice", {
      ...CALL_PARAMS,
      Padding: "x".repeat(65_536),
    }));
    expect(response.status).toBe(413);
    expect(startVoiceVerification).not.toHaveBeenCalled();
  });
});
