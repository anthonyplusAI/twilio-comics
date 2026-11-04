import { NextResponse } from "next/server";

/** Legacy photo-session cleanup still uses a no-cache JSON response. */
export function photoJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}

/** The old phone-linked camera intake is permanently closed. */
export function retiredCameraPhotoResponse(): NextResponse {
  return photoJson({
    error: "This photo flow has moved. Open the start page for current options.",
  }, 410);
}
