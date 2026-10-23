import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  validateTwilioSignature: vi.fn(),
  recordInboundMessage: vi.fn(),
  sendInboundMessage: vi.fn(),
  getOldestOpenInboundMessage: vi.fn(),
  processInboundMessage: vi.fn(),
  recordActivityEvent: vi.fn(),
  getOrCreateChannelIdentity: vi.fn(),
}));

vi.mock("@/lib/twilio", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/twilio")>();
  return {
    ...original,
    validateTwilioSignature: h.validateTwilioSignature,
  };
});
vi.mock("@/lib/twilio-events", () => ({
  recordInboundMessage: h.recordInboundMessage,
  getOldestOpenInboundMessage: h.getOldestOpenInboundMessage,
  claimInboundMessage: vi.fn().mockResolvedValue({ claimed: true }),
  completeInboundMessage: vi.fn().mockResolvedValue(undefined),
  releaseInboundMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/generation-queue", () => ({
  sendInboundMessage: h.sendInboundMessage,
}));
vi.mock("@/lib/process-inbound-message", () => ({
  processInboundMessage: h.processInboundMessage,
  ConversationLeaseBusyError: class ConversationLeaseBusyError extends Error {},
}));
vi.mock("@/lib/activity-events", () => ({
  recordActivityEvent: h.recordActivityEvent,
}));
vi.mock("@/lib/channel-identities", () => ({
  getOrCreateChannelIdentity: h.getOrCreateChannelIdentity,
}));
vi.mock("@/lib/db-actions", () => ({
  getOrCreateConversation: vi.fn().mockResolvedValue({
    state: "awaiting_prompt",
    collected: {},
  }),
  updateConversation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/generation-jobs", () => ({
  submitGenerationJob: vi.fn().mockResolvedValue({ accepted: true }),
}));

import { POST } from "@/app/api/twilio/sms/route";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PUBLIC_BASE_URL", "https://comics.example.com");
  vi.stubEnv("TWILIO_PHONE_NUMBER", "+15553334444");
  vi.stubEnv("TWILIO_WHATSAPP_NUMBER", "whatsapp:+14155238886");
  vi.stubEnv("TWILIO_ENABLED_CHANNELS", "sms,voice,whatsapp");
  h.validateTwilioSignature.mockReturnValue(true);
  h.recordInboundMessage.mockResolvedValue({ shouldEnqueue: true });
  h.sendInboundMessage.mockResolvedValue(undefined);
  h.getOldestOpenInboundMessage.mockResolvedValue(null);
  h.processInboundMessage.mockResolvedValue(undefined);
  h.recordActivityEvent.mockResolvedValue(undefined);
  h.getOrCreateChannelIdentity.mockResolvedValue({ userId: "twilio-user" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function request(pathname: string, form = "MessageSid=SM123&From=%2B15551112222&To=%2B15553334444&Body=A+robot+detective") {
  return new NextRequest(`https://internal.example.com${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": "signature",
    },
    body: form,
  });
}

describe("Twilio messaging webhook", () => {
  it("rejects an oversized form before signature validation or persistence", async () => {
    const response = await POST(request(
      "/api/twilio/sms",
      `MessageSid=SM-large&From=%2B15551112222&To=%2B15553334444&Body=${"x".repeat(64 * 1024)}`,
    ));

    expect(response.status).toBe(413);
    expect(h.validateTwilioSignature).not.toHaveBeenCalled();
    expect(h.getOrCreateChannelIdentity).not.toHaveBeenCalled();
    expect(h.recordInboundMessage).not.toHaveBeenCalled();
  });

  it("stores a signed SMS idea, queues its SID, and responds without waiting for an agent", async () => {
    const response = await POST(request("/api/twilio/sms?campaign=fall"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/xml");
    expect(await response.text()).toContain("<Response/>");
    expect(h.validateTwilioSignature).toHaveBeenCalledWith({
      signature: "signature",
      url: "https://comics.example.com/api/twilio/sms?campaign=fall",
      params: {
        MessageSid: "SM123",
        From: "+15551112222",
        To: "+15553334444",
        Body: "A robot detective",
      },
    });
    expect(h.recordInboundMessage).toHaveBeenCalledWith({
      messageSid: "SM123",
      channel: "sms",
      fromAddress: "+15551112222",
      toAddress: "+15553334444",
      body: "A robot detective",
      mediaUrls: [],
      mediaContentTypes: [],
    });
    expect(h.sendInboundMessage).toHaveBeenCalledWith("SM123");
    expect(h.getOrCreateChannelIdentity).toHaveBeenCalledWith("sms", "+15551112222");
    expect(h.recordActivityEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: "message:SM123:inbound",
      channel: "sms",
      kind: "message.inbound",
      direction: "inbound",
      address: "+15551112222",
      messageSid: "SM123",
      content: "A robot detective",
      userId: "twilio-user",
    }));
  });

  it("processes the prefilled SMS opener on the warm web app without starting a queue job", async () => {
    h.getOldestOpenInboundMessage.mockResolvedValue({ messageSid: "SM-start" });

    const response = await POST(request(
      "/api/twilio/sms",
      "MessageSid=SM-start&From=%2B15551112222&To=%2B15553334444&Body=Turn+me+into+a+comic%21",
    ));

    expect(response.status).toBe(200);
    expect(h.getOldestOpenInboundMessage).toHaveBeenCalledWith("sms", "+15551112222");
    expect(h.processInboundMessage).toHaveBeenCalledExactlyOnceWith("SM-start");
    expect(h.sendInboundMessage).not.toHaveBeenCalled();
  });

  it.each(["NEW", "STATUS", "CONTINUE"])(
    "processes the deterministic %s command without waiting for a queue job",
    async (command) => {
      h.getOldestOpenInboundMessage.mockResolvedValue({ messageSid: "SM-command" });

      const response = await POST(request(
        "/api/twilio/sms",
        `MessageSid=SM-command&From=%2B15551112222&To=%2B15553334444&Body=${command}`,
      ));

      expect(response.status).toBe(200);
      expect(h.processInboundMessage).toHaveBeenCalledExactlyOnceWith("SM-command");
      expect(h.sendInboundMessage).not.toHaveBeenCalled();
    },
  );

  it("keeps a later command queued behind an earlier unprocessed idea", async () => {
    h.getOldestOpenInboundMessage.mockResolvedValue({ messageSid: "SM-earlier" });

    const response = await POST(request(
      "/api/twilio/sms",
      "MessageSid=SM-later&From=%2B15551112222&To=%2B15553334444&Body=NEW",
    ));

    expect(response.status).toBe(200);
    expect(h.processInboundMessage).not.toHaveBeenCalled();
    expect(h.sendInboundMessage).toHaveBeenCalledExactlyOnceWith("SM-later");
  });

  it("keeps CREATE and photo messages out of the inline fast path", async () => {
    h.getOldestOpenInboundMessage.mockResolvedValue({ messageSid: "SM-command" });

    const createResponse = await POST(request(
      "/api/twilio/sms",
      "MessageSid=SM-command&From=%2B15551112222&To=%2B15553334444&Body=CREATE",
    ));
    const photoResponse = await POST(request(
      "/api/twilio/sms",
      "MessageSid=SM-photo&From=%2B15551112222&To=%2B15553334444&Body=Turn+me+into+a+comic%21&NumMedia=1&MediaUrl0=https%3A%2F%2Fapi.twilio.com%2Fphoto&MediaContentType0=image%2Fjpeg",
    ));

    expect(createResponse.status).toBe(200);
    expect(photoResponse.status).toBe(200);
    expect(h.processInboundMessage).not.toHaveBeenCalled();
    expect(h.getOldestOpenInboundMessage).not.toHaveBeenCalled();
    expect(h.sendInboundMessage.mock.calls).toEqual([["SM-command"], ["SM-photo"]]);
  });

  it("queues a saved opener if inline processing fails", async () => {
    h.getOldestOpenInboundMessage.mockResolvedValue({ messageSid: "SM-start" });
    h.processInboundMessage.mockRejectedValue(new Error("Twilio temporarily unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await POST(request(
        "/api/twilio/sms",
        "MessageSid=SM-start&From=%2B15551112222&To=%2B15553334444&Body=Turn+me+into+a+comic%21",
      ));

      expect(response.status).toBe(200);
      expect(h.sendInboundMessage).toHaveBeenCalledExactlyOnceWith("SM-start");
    } finally {
      log.mockRestore();
    }
  });

  it("queues a slow inline opener before Twilio's webhook timeout", async () => {
    vi.useFakeTimers();
    h.getOldestOpenInboundMessage.mockResolvedValue({ messageSid: "SM-start" });
    let finishProcessing: (() => void) | undefined;
    h.processInboundMessage.mockReturnValue(new Promise<void>((resolve) => {
      finishProcessing = resolve;
    }));

    const pendingResponse = POST(request(
      "/api/twilio/sms",
      "MessageSid=SM-start&From=%2B15551112222&To=%2B15553334444&Body=Turn+me+into+a+comic%21",
    ));
    await vi.advanceTimersByTimeAsync(8_001);
    const response = await pendingResponse;

    expect(response.status).toBe(200);
    expect(h.processInboundMessage).toHaveBeenCalledExactlyOnceWith("SM-start");
    expect(h.sendInboundMessage).toHaveBeenCalledExactlyOnceWith("SM-start");
    finishProcessing?.();
  });

  it("does not resend or queue a completed duplicate opener", async () => {
    h.recordInboundMessage.mockResolvedValue({ shouldEnqueue: false });

    const response = await POST(request(
      "/api/twilio/sms",
      "MessageSid=SM-start&From=%2B15551112222&To=%2B15553334444&Body=Turn+me+into+a+comic%21",
    ));

    expect(response.status).toBe(200);
    expect(h.processInboundMessage).not.toHaveBeenCalled();
    expect(h.sendInboundMessage).not.toHaveBeenCalled();
  });

  it("keeps WhatsApp image metadata with the durable receipt", async () => {
    const response = await POST(request(
      "/api/twilio/whatsapp",
      "MessageSid=SM-photo&From=whatsapp%3A%2B15551112222&To=whatsapp%3A%2B14155238886&Body=&NumMedia=1&MediaUrl0=https%3A%2F%2Fapi.twilio.com%2Fphoto&MediaContentType0=image%2Fjpeg",
    ));

    expect(response.status).toBe(200);
    expect(h.recordInboundMessage).toHaveBeenCalledWith({
      messageSid: "SM-photo",
      channel: "whatsapp",
      fromAddress: "whatsapp:+15551112222",
      toAddress: "whatsapp:+14155238886",
      body: "",
      mediaUrls: ["https://api.twilio.com/photo"],
      mediaContentTypes: ["image/jpeg"],
    });
    expect(h.sendInboundMessage).toHaveBeenCalledWith("SM-photo");
  });

  it("accepts a configured WhatsApp sender when SMS and Voice are unavailable", async () => {
    vi.stubEnv("TWILIO_PHONE_NUMBER", "");

    const response = await POST(request(
      "/api/twilio/whatsapp",
      "MessageSid=SM-whatsapp&From=whatsapp%3A%2B15551112222&To=whatsapp%3A%2B14155238886&Body=A+moon+detective",
    ));

    expect(response.status).toBe(200);
    expect(h.recordInboundMessage).toHaveBeenCalledOnce();
    expect(h.sendInboundMessage).toHaveBeenCalledWith("SM-whatsapp");
  });

  it("rejects signed SMS when only WhatsApp and Voice are selected", async () => {
    vi.stubEnv("TWILIO_ENABLED_CHANNELS", "whatsapp,voice");

    const response = await POST(request("/api/twilio/sms"));

    expect(response.status).toBe(503);
    expect(h.recordInboundMessage).not.toHaveBeenCalled();
    expect(h.sendInboundMessage).not.toHaveBeenCalled();
  });

  it("rejects signed WhatsApp when only SMS is selected", async () => {
    vi.stubEnv("TWILIO_ENABLED_CHANNELS", "sms");

    const response = await POST(request(
      "/api/twilio/whatsapp",
      "MessageSid=SM-whatsapp&From=whatsapp%3A%2B15551112222&To=whatsapp%3A%2B14155238886&Body=A+moon+detective",
    ));

    expect(response.status).toBe(503);
    expect(h.recordInboundMessage).not.toHaveBeenCalled();
    expect(h.sendInboundMessage).not.toHaveBeenCalled();
  });

  it("accepts a selected WhatsApp channel even when SMS is disabled", async () => {
    vi.stubEnv("TWILIO_ENABLED_CHANNELS", "whatsapp");

    const response = await POST(request(
      "/api/twilio/whatsapp",
      "MessageSid=SM-whatsapp&From=whatsapp%3A%2B15551112222&To=whatsapp%3A%2B14155238886&Body=A+moon+detective",
    ));

    expect(response.status).toBe(200);
    expect(h.recordInboundMessage).toHaveBeenCalledOnce();
  });

  it("rejects SMS when its sender is not configured", async () => {
    vi.stubEnv("TWILIO_PHONE_NUMBER", "");

    const response = await POST(request("/api/twilio/sms"));

    expect(response.status).toBe(503);
    expect(h.recordInboundMessage).not.toHaveBeenCalled();
    expect(h.sendInboundMessage).not.toHaveBeenCalled();
  });

  it("rejects the example SMS sender used in setup documentation", async () => {
    vi.stubEnv("TWILIO_PHONE_NUMBER", "+15551234567");

    const response = await POST(request(
      "/api/twilio/sms",
      "MessageSid=SM-example&From=%2B15551112222&To=%2B15551234567&Body=A+moon+detective",
    ));

    expect(response.status).toBe(503);
    expect(h.recordInboundMessage).not.toHaveBeenCalled();
  });

  it("rejects WhatsApp when its sender is not configured", async () => {
    vi.stubEnv("TWILIO_WHATSAPP_NUMBER", "");

    const response = await POST(request(
      "/api/twilio/whatsapp",
      "MessageSid=SM-whatsapp&From=whatsapp%3A%2B15551112222&To=whatsapp%3A%2B14155238886&Body=A+moon+detective",
    ));

    expect(response.status).toBe(503);
    expect(h.recordInboundMessage).not.toHaveBeenCalled();
    expect(h.sendInboundMessage).not.toHaveBeenCalled();
  });

  it("rejects an inbound message addressed to a different sender", async () => {
    const response = await POST(request(
      "/api/twilio/sms",
      "MessageSid=SM-other&From=%2B15551112222&To=%2B12025550199&Body=A+moon+detective",
    ));

    expect(response.status).toBe(403);
    expect(h.recordInboundMessage).not.toHaveBeenCalled();
    expect(h.sendInboundMessage).not.toHaveBeenCalled();
  });

  it("does not let a WhatsApp message enter through the SMS webhook", async () => {
    const response = await POST(request(
      "/api/twilio/sms",
      "MessageSid=SM-misrouted&From=whatsapp%3A%2B15551112222&To=whatsapp%3A%2B14155238886&Body=A+moon+detective",
    ));

    expect(response.status).toBe(400);
    expect(h.recordInboundMessage).not.toHaveBeenCalled();
  });

  it.each([
    "STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE", "OPTOUT",
    "START", "UNSTOP", "YES", "HELP", "INFO",
  ])("acknowledges Twilio's %s keyword without saving or replying", async (keyword) => {
    const response = await POST(request(
      "/api/twilio/sms",
      `MessageSid=SM-keyword&From=%2B15551112222&To=%2B15553334444&Body=${keyword.toLowerCase()}`,
    ));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<Response/>");
    expect(h.validateTwilioSignature).toHaveBeenCalledOnce();
    expect(h.recordInboundMessage).not.toHaveBeenCalled();
    expect(h.sendInboundMessage).not.toHaveBeenCalled();
    expect(h.getOrCreateChannelIdentity).toHaveBeenCalledWith("sms", "+15551112222");
    expect(h.recordActivityEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: "message:SM-keyword:inbound",
      kind: "message.inbound",
      status: "control",
      content: keyword.toLowerCase(),
      userId: "twilio-user",
    }));
  });

  it("acknowledges a custom Advanced Opt-Out keyword identified by OptOutType", async () => {
    const response = await POST(request(
      "/api/twilio/sms",
      "MessageSid=SM-keyword&From=%2B15551112222&To=%2B15553334444&Body=BAJA&OptOutType=STOP",
    ));

    expect(response.status).toBe(200);
    expect(h.validateTwilioSignature).toHaveBeenCalledOnce();
    expect(h.recordInboundMessage).not.toHaveBeenCalled();
    expect(h.sendInboundMessage).not.toHaveBeenCalled();
  });

  it("keeps a comic idea containing a keyword in the normal queue", async () => {
    const response = await POST(request(
      "/api/twilio/sms",
      "MessageSid=SM-idea&From=%2B15551112222&To=%2B15553334444&Body=Stop+the+robot+before+it+escapes",
    ));

    expect(response.status).toBe(200);
    expect(h.recordInboundMessage).toHaveBeenCalledOnce();
    expect(h.sendInboundMessage).toHaveBeenCalledWith("SM-idea");
  });

  it("validates the signature before acknowledging opt-out keywords", async () => {
    h.validateTwilioSignature.mockReturnValue(false);

    const response = await POST(request(
      "/api/twilio/sms",
      "MessageSid=SM-keyword&From=%2B15551112222&To=%2B15553334444&Body=STOP&OptOutType=STOP",
    ));

    expect(response.status).toBe(403);
    expect(h.recordInboundMessage).not.toHaveBeenCalled();
    expect(h.sendInboundMessage).not.toHaveBeenCalled();
    expect(h.recordActivityEvent).not.toHaveBeenCalled();
  });

  it("acknowledges an accepted message when activity history is unavailable", async () => {
    h.recordActivityEvent.mockRejectedValue(new Error("analytics unavailable"));

    const response = await POST(request("/api/twilio/sms"));

    expect(response.status).toBe(200);
    expect(h.recordInboundMessage).toHaveBeenCalledOnce();
    expect(h.sendInboundMessage).toHaveBeenCalledWith("SM123");
  });

  it("does not queue a completed duplicate", async () => {
    h.recordInboundMessage.mockResolvedValue({ shouldEnqueue: false });

    const response = await POST(request("/api/twilio/sms"));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<Response/>");
    expect(h.sendInboundMessage).not.toHaveBeenCalled();
  });

  it("requeues a persisted duplicate that is still pending", async () => {
    h.recordInboundMessage.mockResolvedValue({ shouldEnqueue: true });

    const response = await POST(request("/api/twilio/sms"));

    expect(response.status).toBe(200);
    expect(h.sendInboundMessage).toHaveBeenCalledWith("SM123");
  });

  it("returns a retryable error on queue publication failure without deleting the receipt", async () => {
    h.sendInboundMessage.mockRejectedValue(new Error("Azure Queue unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await POST(request("/api/twilio/sms"));

      expect(response.status).toBe(503);
      expect(h.recordInboundMessage).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });

  it("rejects a forged webhook before storing a message", async () => {
    h.validateTwilioSignature.mockReturnValue(false);

    const response = await POST(request("/api/twilio/sms"));

    expect(response.status).toBe(403);
    expect(h.recordInboundMessage).not.toHaveBeenCalled();
    expect(h.sendInboundMessage).not.toHaveBeenCalled();
  });
});
