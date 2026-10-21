import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import twilio from "twilio";

const BASE = "https://comics.example";
const TOKEN = "test-twilio-auth-token";
const CALL_SID = `CA${"a".repeat(32)}`;

function signedAction(params: Record<string, string>, valid = true): NextRequest {
  const url = `${BASE}/api/twilio/voice/action`;
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": valid
        ? twilio.getExpectedTwilioSignature(TOKEN, url, params)
        : "invalid-signature",
    },
    body: new URLSearchParams(params).toString(),
  });
}

beforeEach(() => {
  vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
  vi.stubEnv("PUBLIC_BASE_URL", BASE);
  vi.stubEnv("TWILIO_PHONE_NUMBER", "+14155552671");
  vi.stubEnv("TWILIO_WHATSAPP_NUMBER", undefined);
  vi.stubEnv("TWILIO_ENABLED_CHANNELS", "voice");
});

afterEach(() => vi.unstubAllEnvs());

describe("ConversationRelay action callback", () => {
  it("speaks the queued result before ending an approved call", async () => {
    const { POST } = await import("@/app/api/twilio/voice/action/route");
    const response = await POST(signedAction({
      CallSid: CALL_SID,
      CallStatus: "in-progress",
      SessionStatus: "ended",
      HandoffData: JSON.stringify({ result: "queued" }),
    }));
    const xml = await response.text();
    expect(response.status).toBe(200);
    expect(xml).toMatch(/text.+comic/i);
    expect(xml).toContain("<Hangup/>");
  });

  it("explains an unexpected socket disconnect without promising a new comic", async () => {
    const { POST } = await import("@/app/api/twilio/voice/action/route");
    const response = await POST(signedAction({
      CallSid: CALL_SID,
      CallStatus: "in-progress",
      SessionStatus: "failed",
      ErrorCode: "64105",
    }));
    const xml = await response.text();
    expect(xml).toMatch(/connection|disconnected/i);
    expect(xml).toMatch(/call again|text/i);
    expect(xml).not.toMatch(/text your idea|WhatsApp/i);
    expect(xml).toContain("<Hangup/>");
  });

  it("only suggests another call when voice is the sole entry channel", async () => {
    const { POST } = await import("@/app/api/twilio/voice/action/route");
    const response = await POST(signedAction({
      CallSid: CALL_SID,
      CallStatus: "in-progress",
      HandoffData: JSON.stringify({ result: "service_error" }),
    }));
    const xml = await response.text();
    expect(xml).toMatch(/call again/i);
    expect(xml).not.toMatch(/text your idea|WhatsApp/i);
  });

  it("suggests texting the call number when SMS is enabled", async () => {
    vi.stubEnv("TWILIO_ENABLED_CHANNELS", "voice,sms");
    const { POST } = await import("@/app/api/twilio/voice/action/route");
    const response = await POST(signedAction({
      CallSid: CALL_SID,
      CallStatus: "in-progress",
      HandoffData: JSON.stringify({ result: "service_error" }),
    }));
    expect(await response.text()).toMatch(/text your idea to this number/i);
  });

  it("suggests WhatsApp when that messaging channel is configured instead of SMS", async () => {
    vi.stubEnv("TWILIO_ENABLED_CHANNELS", "voice,whatsapp");
    vi.stubEnv("TWILIO_WHATSAPP_NUMBER", "whatsapp:+447700900123");
    const { POST } = await import("@/app/api/twilio/voice/action/route");
    const response = await POST(signedAction({
      CallSid: CALL_SID,
      CallStatus: "in-progress",
      HandoffData: JSON.stringify({ result: "service_error" }),
    }));
    const xml = await response.text();
    expect(xml).toMatch(/WhatsApp/i);
    expect(xml).not.toMatch(/text your idea/i);
  });

  it("does not suggest WhatsApp without a valid sender", async () => {
    vi.stubEnv("TWILIO_ENABLED_CHANNELS", "voice,whatsapp");
    vi.stubEnv("TWILIO_WHATSAPP_NUMBER", "not-a-whatsapp-sender");
    const { POST } = await import("@/app/api/twilio/voice/action/route");
    const response = await POST(signedAction({
      CallSid: CALL_SID,
      CallStatus: "in-progress",
      HandoffData: JSON.stringify({ result: "service_error" }),
    }));
    const xml = await response.text();
    expect(xml).toMatch(/call again/i);
    expect(xml).not.toMatch(/text your idea|WhatsApp/i);
  });

  it("reports an uncertain queue result without falsely promising delivery", async () => {
    const { POST } = await import("@/app/api/twilio/voice/action/route");
    const response = await POST(signedAction({
      CallSid: CALL_SID,
      CallStatus: "in-progress",
      SessionStatus: "ended",
      HandoffData: JSON.stringify({ result: "checking" }),
    }));
    const xml = await response.text();
    expect(xml).toMatch(/checking/i);
    expect(xml).toMatch(/if.+started/i);
    expect(xml).toContain("<Hangup/>");
  });

  it("does not speak to a caller who has already hung up", async () => {
    const { POST } = await import("@/app/api/twilio/voice/action/route");
    const response = await POST(signedAction({
      CallSid: CALL_SID,
      CallStatus: "completed",
      SessionStatus: "completed",
    }));
    expect(await response.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  });

  it("rejects a forged action callback", async () => {
    const { POST } = await import("@/app/api/twilio/voice/action/route");
    const response = await POST(signedAction({ CallSid: CALL_SID }, false));
    expect(response.status).toBe(403);
  });
});
