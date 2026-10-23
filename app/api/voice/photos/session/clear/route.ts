import { type NextRequest } from "next/server";
import { photoJson } from "@/lib/browser-photo-access";
import {
  CAMERA_CHALLENGE_COOKIE,
  CAMERA_SESSION_COOKIE,
  photoCookieOptions,
  photoRequestHasAllowedOrigin,
} from "@/lib/browser-photo-session";

export const runtime = "nodejs";

/** A shared photo booth must discard the previous person's verified session. */
export async function POST(request: NextRequest): Promise<Response> {
  if (!photoRequestHasAllowedOrigin(request)) {
    return photoJson({ error: "Request origin is not allowed" }, 403);
  }

  const response = photoJson({ ok: true });
  response.cookies.set(CAMERA_CHALLENGE_COOKIE, "", {
    ...photoCookieOptions("challenge"),
    maxAge: 0,
  });
  response.cookies.set(CAMERA_SESSION_COOKIE, "", {
    ...photoCookieOptions("session"),
    maxAge: 0,
  });
  return response;
}
