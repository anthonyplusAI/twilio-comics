import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import twilio from "twilio";
import { POST } from "@/app/api/twilio/voice/route";

const BASE = "https://comics.example";
const TOKEN = "test-twilio-auth-token";
const CALL_SID = `CA${"a".repeat(32)}`;
const PHONE_NUMBER = "+12025550123";
const CALL_PARAMS = {
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
  vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
  vi.stubEnv("TWILIO_PHONE_NUMBER", PHONE_NUMBER);
  vi.stubEnv("TWILIO_ENABLED_CHANNELS", undefined);
  vi.stubEnv("PUBLIC_BASE_URL", BASE);
  vi.stubEnv("CONVERSATION_RELAY_WS_URL", "wss://comics.example/relay");
});

afterEach(() => vi.unstubAllEnvs());

describe("inbound voice TwiML", () => {
  it("connects a signed call to Relay with a signed completion callback and an idea-first greeting", async () => {
    const response = await POST(signedRequest("/api/twilio/voice", {
      ...CALL_PARAMS,
    }));
    const xml = await response.text();
    expect(response.status).toBe(200);
    expect(xml).toContain('<Connect action="https://comics.example/api/twilio/voice/action" method="POST">');
    expect(xml).toContain('url="wss://comics.example/relay"');
    expect(xml).toMatch(/comic idea/i);
    expect(xml).not.toMatch(/what.s your name/i);
  });

  it("rejects a forged webhook", async () => {
    const response = await POST(signedRequest("/api/twilio/voice", { CallSid: CALL_SID }, false));
    expect(response.status).toBe(403);
  });

  it("refuses a non-TLS WebSocket URL", async () => {
    vi.stubEnv("CONVERSATION_RELAY_WS_URL", "ws://comics.example/relay");
    const response = await POST(signedRequest("/api/twilio/voice", CALL_PARAMS));
    expect(response.status).toBe(503);
  });

  it("refuses a WebSocket URL outside the mounted Relay endpoint", async () => {
    vi.stubEnv("CONVERSATION_RELAY_WS_URL", "wss://comics.example/not-relay");
    const response = await POST(signedRequest("/api/twilio/voice", CALL_PARAMS));
    expect(response.status).toBe(503);
  });

  it("reports missing Twilio signature configuration as unavailable", async () => {
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    const response = await POST(signedRequest("/api/twilio/voice", CALL_PARAMS));
    expect(response.status).toBe(503);
  });

  it("refuses signed calls when the SMS and Voice sender is not configured", async () => {
    vi.stubEnv("TWILIO_PHONE_NUMBER", "");

    const response = await POST(signedRequest("/api/twilio/voice", CALL_PARAMS));

    expect(response.status).toBe(503);
  });

  it("refuses signed calls when Voice is not selected despite a valid number", async () => {
    vi.stubEnv("TWILIO_ENABLED_CHANNELS", "sms,whatsapp");

    const response = await POST(signedRequest("/api/twilio/voice", CALL_PARAMS));

    expect(response.status).toBe(503);
  });

  it("connects selected Voice calls even when inbound SMS is disabled", async () => {
    vi.stubEnv("TWILIO_ENABLED_CHANNELS", "voice");

    const response = await POST(signedRequest("/api/twilio/voice", CALL_PARAMS));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<ConversationRelay");
  });

  it("rejects a signed call to an unrelated number", async () => {
    const response = await POST(signedRequest("/api/twilio/voice", {
      ...CALL_PARAMS,
      To: "+12025550199",
    }));

    expect(response.status).toBe(403);
  });
});
