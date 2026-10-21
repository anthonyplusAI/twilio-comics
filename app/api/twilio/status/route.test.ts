import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  validateTwilioSignature: vi.fn(),
  recordGeneratedMessageStatus: vi.fn(),
  recordFallbackMessageStatus: vi.fn(),
  sendFailedMmsTextFallback: vi.fn(),
}));

vi.mock("@/lib/twilio", () => ({
  validateTwilioSignature: h.validateTwilioSignature,
}));
vi.mock("@/lib/twilio-delivery", () => ({
  recordGeneratedMessageStatus: h.recordGeneratedMessageStatus,
  recordFallbackMessageStatus: h.recordFallbackMessageStatus,
  sendFailedMmsTextFallback: h.sendFailedMmsTextFallback,
  isDeliveryStatus: (status: string) => [
    "accepted", "scheduled", "queued", "sending", "sent", "delivered",
    "read", "failed", "undelivered", "canceled",
  ].includes(status),
}));

import { POST } from "@/app/api/twilio/status/route";

const jobId = "66b79156-7d64-4bd6-bd67-7e8ce96437ef";
const messageSid = "SM1234567890abcdef1234567890abcdef";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PUBLIC_BASE_URL = "https://comics.example.com";
  h.validateTwilioSignature.mockReturnValue(true);
  h.recordGeneratedMessageStatus.mockResolvedValue(true);
  h.recordFallbackMessageStatus.mockResolvedValue(true);
  h.sendFailedMmsTextFallback.mockResolvedValue(false);
});

function request(
  form = `MessageSid=${messageSid}&MessageStatus=undelivered&ErrorCode=30008`,
  signature = "signature",
  query = `jobId=${jobId}`,
) {
  return new NextRequest(`https://internal.example.com/api/twilio/status?${query}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    body: form,
  });
}

describe("Twilio generated-comic delivery callback", () => {
  it("validates the exact public callback URL and stores status and error code", async () => {
    const response = await POST(request());

    expect(response.status).toBe(204);
    expect(h.validateTwilioSignature).toHaveBeenCalledWith({
      signature: "signature",
      url: `https://comics.example.com/api/twilio/status?jobId=${jobId}`,
      params: {
        MessageSid: messageSid,
        MessageStatus: "undelivered",
        ErrorCode: "30008",
      },
    });
    expect(h.recordGeneratedMessageStatus).toHaveBeenCalledWith({
      jobId,
      messageSid,
      status: "undelivered",
      errorCode: "30008",
    });
    expect(h.sendFailedMmsTextFallback).toHaveBeenCalledWith(jobId);
  });

  it("tries the bounded text fallback on duplicate failed callbacks", async () => {
    h.recordGeneratedMessageStatus.mockResolvedValue(false);
    const response = await POST(request());
    expect(response.status).toBe(204);
    expect(h.sendFailedMmsTextFallback).toHaveBeenCalledWith(jobId);
  });

  it("tracks a fallback message separately without trying another fallback", async () => {
    const response = await POST(request(
      `MessageSid=${messageSid}&MessageStatus=delivered`,
      "signature",
      `jobId=${jobId}&fallback=1`,
    ));
    expect(response.status).toBe(204);
    expect(h.validateTwilioSignature).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `https://comics.example.com/api/twilio/status?jobId=${jobId}&fallback=1`,
      }),
    );
    expect(h.recordFallbackMessageStatus).toHaveBeenCalledWith({
      jobId,
      messageSid,
      status: "delivered",
      errorCode: null,
    });
    expect(h.recordGeneratedMessageStatus).not.toHaveBeenCalled();
    expect(h.sendFailedMmsTextFallback).not.toHaveBeenCalled();
  });

  it("acknowledges a fallback send error so scheduled recovery can retry it", async () => {
    h.sendFailedMmsTextFallback.mockRejectedValue(new Error("Twilio temporarily unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(request());
      expect(response.status).toBe(204);
    } finally {
      log.mockRestore();
    }
  });

  it("rejects an invalid Twilio signature before writing", async () => {
    h.validateTwilioSignature.mockReturnValue(false);
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(h.recordGeneratedMessageStatus).not.toHaveBeenCalled();
  });

  it("rejects callbacks missing a MessageSid", async () => {
    const response = await POST(request("MessageStatus=delivered"));
    expect(response.status).toBe(400);
    expect(h.recordGeneratedMessageStatus).not.toHaveBeenCalled();
  });

  it("acknowledges unknown future statuses without changing a job", async () => {
    const response = await POST(request(`MessageSid=${messageSid}&MessageStatus=future_status`));
    expect(response.status).toBe(204);
    expect(h.recordGeneratedMessageStatus).not.toHaveBeenCalled();
  });

  it("returns a retryable error when persistence fails", async () => {
    h.recordGeneratedMessageStatus.mockRejectedValue(new Error("Database unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await POST(request());
      expect(response.status).toBe(503);
    } finally {
      log.mockRestore();
    }
  });
});
