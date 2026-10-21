import { type NextRequest } from "next/server";
import { downloadBlob, getBlobMetadata, isValidMediaToken } from "@/lib/blob-storage";

export const runtime = "nodejs";

function authorizedKey(request: NextRequest): string | null {
  const key = request.nextUrl.searchParams.get("key") || "";
  const token = request.nextUrl.searchParams.get("token") || "";
  return key && token && isValidMediaToken(key, token) ? key : null;
}

export async function HEAD(request: NextRequest) {
  const key = authorizedKey(request);
  if (!key) return new Response(null, { status: 404 });

  try {
    const blob = await getBlobMetadata(key);
    return new Response(null, {
      headers: {
        "Content-Type": blob.contentType,
        "Content-Length": String(blob.contentLength),
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("Media metadata lookup failed", error);
    return new Response(null, { status: 404 });
  }
}

export async function GET(request: NextRequest) {
  const key = authorizedKey(request);
  if (!key) return new Response("Not found", { status: 404 });

  try {
    const blob = await downloadBlob(key);
    return new Response(new Uint8Array(blob.buffer), {
      headers: {
        "Content-Type": blob.contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("Media download failed", error);
    return new Response("Not found", { status: 404 });
  }
}
