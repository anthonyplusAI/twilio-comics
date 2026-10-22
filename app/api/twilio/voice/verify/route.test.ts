import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import twilio from "twilio";
import { POST } from "@/app/api/twilio/voice/verify/route";
import { verifyVoiceCallAuthorization } from "@/lib/voice-call-authorization";

const { checkVoiceVerification } = vi.hoisted(() => ({
  checkVoiceVerification: vi.fn(),
}));
const { reserveVoiceCallBudget } = vi.hoisted(() => ({
  reserveVoiceCallBudget: vi.fn(),
}));
vi.mock("@/lib/voice-verification", () => ({
  isVoiceVerificationConfigured: () => Boolean(process.env.TWILIO_VERIFY_SERVICE_SID),
  checkVoiceVerification,
}));
vi.mock("@/lib/voice-call-budget", () => ({ reserveVoiceCallBudget }));

const BASE = "https://comics.example";
const TOKEN = "test-twilio-auth-token";
const AUTH_SECRET = "test-auth-secret-for-call-token";
const ACCOUNT_SID = `AC${"c".repeat(32)}`;
const CALL_SID = `CA${"a".repeat(32)}`;
const PHONE_NUMBER = "+12025550123";
const CALL_PARAMS = {
  AccountSid: ACCOUNT_SID,
  CallSid: CALL_SID,
  From: "+15551234567",
  To: PHONE_NUMBER,
  Digits: "123456",
};

function signedRequest(attempt: number, params: Record<string, string>, valid = true): NextRequest {
  const url = `${BASE}/api/twilio/voice/verify?attempt=${attempt}`;
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
  checkVoiceVerification.mockResolvedValue(true);
  reserveVoiceCallBudget.mockResolvedValue({ allowed: true, duplicate: false });
  vi.stubEnv("TWILIO_ACCOUNT_SID", ACCOUNT_SID);
  vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
  vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", `VA${"d".repeat(32)}`);
  vi.stubEnv("TWILIO_PHONE_NUMBER", PHONE_NUMBER);
  vi.stubEnv("TWILIO_ENABLED_CHANNELS", "sms,voice");
  vi.stubEnv("AUTH_SECRET", AUTH_SECRET);
  vi.stubEnv("PUBLIC_BASE_URL", BASE);
  vi.stubEnv("CONVERSATION_RELAY_WS_URL", "wss://comics.example/relay");
});

afterEach(() => vi.unstubAllEnvs());

describe("Voice keypad verification", () => {
  it("connects an approved caller with a token bound to this call", async () => {
    const response = await POST(signedRequest(1, CALL_PARAMS));
    const xml = await response.text();

    expect(response.status).toBe(200);
    expect(checkVoiceVerification).toHaveBeenCalledExactlyOnceWith(CALL_PARAMS.From, CALL_PARAMS.Digits);
    expect(reserveVoiceCallBudget).toHaveBeenCalledExactlyOnceWith({
      callSid: CALL_SID,
      fromAddress: CALL_PARAMS.From,
      toAddress: PHONE_NUMBER,
    });
    expect(xml).toContain('<Connect action="https://comics.example/api/twilio/voice/action" method="POST">');
    expect(xml).toContain('url="wss://comics.example/relay"');
    expect(xml).toMatch(/comic idea/i);
    expect(xml).toMatch(/AI agent.*transcrib/i);
    expect(xml).toMatch(/text.+(comic|link).+number/i);
    expect(xml).toMatch(/privacy and terms.*website/i);
    expect(xml).toContain('welcomeGreetingInterruptible="none"');
    const authorization = xml.match(/<Parameter name="authorization" value="([^"]+)"\/>/)?.[1];
    expect(authorization).toBeTruthy();
    expect(verifyVoiceCallAuthorization(authorization, {
      callSid: CALL_SID,
      from: CALL_PARAMS.From,
      to: PHONE_NUMBER,
    }, AUTH_SECRET)).toBe(true);
    expect(xml).not.toContain(CALL_PARAMS.Digits);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("reprompts on a wrong code and hangs up after three attempts", async () => {
    checkVoiceVerification.mockResolvedValue(false);
    const first = await POST(signedRequest(1, CALL_PARAMS));
    expect(await first.text()).toContain("verify?attempt=2");

    const second = await POST(signedRequest(2, CALL_PARAMS));
    expect(await second.text()).toContain("verify?attempt=3");

    const third = await POST(signedRequest(3, CALL_PARAMS));
    const xml = await third.text();
    expect(xml).toContain("<Hangup/>");
    expect(xml).not.toContain("<ConversationRelay");
    expect(checkVoiceVerification).toHaveBeenCalledTimes(3);
  });

  it("reprompts for empty or partial keypad input without asking Verify", async () => {
    const first = await POST(signedRequest(1, { ...CALL_PARAMS, Digits: "" }));
    expect(await first.text()).toContain("verify?attempt=2");
    const second = await POST(signedRequest(2, { ...CALL_PARAMS, Digits: "123" }));
    expect(await second.text()).toContain("verify?attempt=3");
    expect(checkVoiceVerification).not.toHaveBeenCalled();
  });

  it("rejects forged or malformed attempts before checking the code", async () => {
    expect((await POST(signedRequest(1, CALL_PARAMS, false))).status).toBe(403);
    expect((await POST(signedRequest(4, CALL_PARAMS))).status).toBe(400);
    expect(checkVoiceVerification).not.toHaveBeenCalled();
  });

  it("refuses a different account, recipient, or invalid call identity", async () => {
    expect((await POST(signedRequest(1, {
      ...CALL_PARAMS,
      AccountSid: `AC${"b".repeat(32)}`,
    }))).status).toBe(403);
    expect((await POST(signedRequest(1, {
      ...CALL_PARAMS,
      To: "+12025550199",
    }))).status).toBe(403);
    expect((await POST(signedRequest(1, {
      ...CALL_PARAMS,
      CallSid: "bad",
    }))).status).toBe(400);
    expect((await POST(signedRequest(1, {
      ...CALL_PARAMS,
      From: "anonymous",
    }))).status).toBe(400);
    expect(checkVoiceVerification).not.toHaveBeenCalled();
  });

  it("fails closed when Voice config or Verify is unavailable", async () => {
    vi.stubEnv("TWILIO_ENABLED_CHANNELS", "sms");
    expect((await POST(signedRequest(1, CALL_PARAMS))).status).toBe(503);
    vi.stubEnv("TWILIO_ENABLED_CHANNELS", "sms,voice");
    vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", "");
    expect((await POST(signedRequest(1, CALL_PARAMS))).status).toBe(503);
    vi.stubEnv("TWILIO_VERIFY_SERVICE_SID", `VA${"d".repeat(32)}`);
    vi.stubEnv("AUTH_SECRET", "");
    expect((await POST(signedRequest(1, CALL_PARAMS))).status).toBe(503);
    expect(checkVoiceVerification).not.toHaveBeenCalled();
  });

  it("hangs up without opening Relay if Verify fails", async () => {
    checkVoiceVerification.mockRejectedValueOnce(new Error("expired verification"));
    const response = await POST(signedRequest(1, CALL_PARAMS));
    expect(response.status).toBe(200);
    const xml = await response.text();
    expect(xml).toContain("<Hangup/>");
    expect(xml).toMatch(/call again/i);
    expect(xml).not.toContain("<ConversationRelay");
  });

  it("denies Relay after the verified caller exceeds the daily Voice budget", async () => {
    reserveVoiceCallBudget.mockResolvedValueOnce({ allowed: false, reason: "rate_limit" });
    const response = await POST(signedRequest(1, CALL_PARAMS));
    const xml = await response.text();
    expect(response.status).toBe(200);
    expect(xml).toContain("<Hangup/>");
    expect(xml).toMatch(/limit.+24 hours/i);
    expect(xml).not.toContain("<ConversationRelay");
  });

  it("denies Relay when the durable Voice budget is unavailable", async () => {
    reserveVoiceCallBudget.mockResolvedValueOnce({ allowed: false, reason: "unavailable" });
    const response = await POST(signedRequest(1, CALL_PARAMS));
    const xml = await response.text();
    expect(response.status).toBe(200);
    expect(xml).toContain("<Hangup/>");
    expect(xml).toMatch(/try again/i);
    expect(xml).not.toContain("<ConversationRelay");
  });

  it("caps oversized bodies before verification", async () => {
    const response = await POST(signedRequest(1, {
      ...CALL_PARAMS,
      Padding: "x".repeat(65_536),
    }));
    expect(response.status).toBe(413);
    expect(checkVoiceVerification).not.toHaveBeenCalled();
  });
});
