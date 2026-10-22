import { describe, expect, it } from "vitest";
import {
  MAX_TWILIO_WEBHOOK_BODY_BYTES,
  readTwilioWebhookForm,
} from "@/lib/twilio-webhook-body";

function request(body: BodyInit, headers?: HeadersInit): Request {
  return new Request("https://comics.example.com/api/twilio/sms", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("bounded Twilio webhook forms", () => {
  it("preserves URL form decoding and the last value for duplicate parameters", async () => {
    const result = await readTwilioWebhookForm(request(
      "From=%2B15551112222&Body=A+robot+%26+dragon&Tag=old&Tag=new",
    ));

    expect(result).toEqual({
      ok: true,
      params: {
        From: "+15551112222",
        Body: "A robot & dragon",
        Tag: "new",
      },
    });
  });

  it("accepts a form at the byte limit", async () => {
    const body = `Body=${"a".repeat(MAX_TWILIO_WEBHOOK_BODY_BYTES - 5)}`;
    const result = await readTwilioWebhookForm(request(body));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.Body).toHaveLength(MAX_TWILIO_WEBHOOK_BODY_BYTES - 5);
  });

  it("rejects an advertised oversized body without reading it", async () => {
    const result = await readTwilioWebhookForm(request("Body=small", {
      "content-length": String(MAX_TWILIO_WEBHOOK_BODY_BYTES + 1),
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
  });

  it("rejects chunked bodies that exceed the limit without Content-Length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`Body=${"a".repeat(32 * 1024)}`));
        controller.enqueue(new TextEncoder().encode("a".repeat(32 * 1024)));
        controller.close();
      },
    });
    const result = await readTwilioWebhookForm(request(stream));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
  });

  it("counts UTF-8 bytes rather than decoded characters", async () => {
    const body = `Body=${"a".repeat(MAX_TWILIO_WEBHOOK_BODY_BYTES - 5 - 3)}😀`;
    const result = await readTwilioWebhookForm(request(body));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
  });
});
