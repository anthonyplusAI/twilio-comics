export const MAX_STUDIO_JSON_BYTES = 16 * 1024;

export type StudioJsonReadResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413 | 415; error: string };

/** Reads JSON incrementally so an absent or false Content-Length cannot allocate an unbounded body. */
export async function readBoundedStudioJson(request: Request): Promise<StudioJsonReadResult> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return { ok: false, status: 415, error: "Expected a JSON request" };
  }

  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      return { ok: false, status: 400, error: "Invalid Content-Length" };
    }
    if (Number(declared) > MAX_STUDIO_JSON_BYTES) {
      return { ok: false, status: 413, error: "JSON request is too large" };
    }
  }
  if (!request.body) {
    return { ok: false, status: 400, error: "Invalid JSON request" };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_STUDIO_JSON_BYTES) {
        await reader.cancel();
        return { ok: false, status: 413, error: "JSON request is too large" };
      }
      chunks.push(value);
    }
    const json = new TextDecoder("utf-8", { fatal: true })
      .decode(Buffer.concat(chunks, total));
    return { ok: true, value: JSON.parse(json) as unknown };
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON request" };
  } finally {
    reader.releaseLock();
  }
}
