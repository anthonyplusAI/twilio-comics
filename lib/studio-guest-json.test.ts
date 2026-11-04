import { describe, expect, it } from "vitest";
import { MAX_STUDIO_JSON_BYTES, readBoundedStudioJson } from "@/lib/studio-guest-json";

function request(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://comics.example.com/api/generate-comic", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

describe("bounded Studio JSON reader", () => {
  it("reads a normal JSON object", async () => {
    expect(await readBoundedStudioJson(request('{"prompt":"Draw me"}')))
      .toEqual({ ok: true, value: { prompt: "Draw me" } });
  });

  it("rejects a declared body larger than the limit before reading it", async () => {
    const input = request("{}", { "content-length": String(MAX_STUDIO_JSON_BYTES + 1) });
    expect(await readBoundedStudioJson(input)).toMatchObject({ ok: false, status: 413 });
    expect(input.bodyUsed).toBe(false);
  });

  it("rejects an oversized stream even when Content-Length is absent or false", async () => {
    const input = request(JSON.stringify({ prompt: "x".repeat(MAX_STUDIO_JSON_BYTES) }), {
      "content-length": "1",
    });
    expect(await readBoundedStudioJson(input)).toMatchObject({ ok: false, status: 413 });
  });

  it("rejects malformed JSON and non-JSON media types", async () => {
    expect(await readBoundedStudioJson(request("{")))
      .toMatchObject({ ok: false, status: 400 });
    expect(await readBoundedStudioJson(request("{}", { "content-type": "text/plain" })))
      .toMatchObject({ ok: false, status: 415 });
  });
});
