export const MAX_TWILIO_WEBHOOK_BODY_BYTES = 64 * 1024;

type TwilioFormResult =
  | { ok: true; params: Record<string, string> }
  | { ok: false; response: Response };

function tooLarge(): TwilioFormResult {
  return {
    ok: false,
    response: new Response("Twilio webhook body too large", {
      status: 413,
      headers: { "Cache-Control": "no-store" },
    }),
  };
}

/** Read signed form parameters without allowing a webhook to buffer an unbounded body. */
export async function readTwilioWebhookForm(request: Request): Promise<TwilioFormResult> {
  const contentLength = request.headers.get("content-length")?.trim();
  if (contentLength && /^\d+$/.test(contentLength) &&
      Number(contentLength) > MAX_TWILIO_WEBHOOK_BODY_BYTES) {
    void request.body?.cancel().catch(() => undefined);
    return tooLarge();
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > MAX_TWILIO_WEBHOOK_BODY_BYTES - size) {
        void reader.cancel().catch(() => undefined);
        return tooLarge();
      }
      size += value.byteLength;
      chunks.push(value);
    }
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const params: Record<string, string> = {};
  new URLSearchParams(new TextDecoder().decode(body)).forEach((value, key) => {
    params[key] = value;
  });
  return { ok: true, params };
}
