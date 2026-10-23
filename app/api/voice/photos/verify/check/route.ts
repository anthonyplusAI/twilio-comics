import { type NextRequest } from "next/server";
import { getCameraDestination, photoJson, readSmallPhotoJson } from "@/lib/browser-photo-access";
import { finishCameraBudget, reserveCameraBudget } from "@/lib/browser-photo-budget";
import {
  CAMERA_CHALLENGE_COOKIE,
  CAMERA_SESSION_COOKIE,
  createPhotoToken,
  photoCookieOptions,
  photoRequestHasAllowedOrigin,
  readPhotoToken,
} from "@/lib/browser-photo-session";
import { checkVoiceVerification } from "@/lib/voice-verification";

export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<Response> {
  if (!photoRequestHasAllowedOrigin(request)) return photoJson({ error: "Request origin is not allowed" }, 403);
  if (!await getCameraDestination()) return photoJson({ error: "Camera photos are not enabled" }, 404);
  const phone = readPhotoToken(request.cookies.get(CAMERA_CHALLENGE_COOKIE)?.value, "challenge");
  if (!phone) return photoJson({ error: "Request a new verification code" }, 401);
  const body = await readSmallPhotoJson(request);
  const code = body?.code;
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
    return photoJson({ error: "Enter the six-digit code" }, 400);
  }

  const budget = await reserveCameraBudget("verification_check", phone);
  if (!budget.allowed) {
    return photoJson({
      error: budget.reason === "rate_limit"
        ? "Too many code attempts. Try again later."
        : "Verification is unavailable right now.",
    }, budget.reason === "rate_limit" ? 429 : 503);
  }

  let approved: boolean;
  try {
    approved = await checkVoiceVerification(phone, code);
  } catch (error) {
    console.error("Browser camera verification check failed", error instanceof Error ? error.name : "unknown");
    await finishCameraBudget(budget.eventKey, "failed").catch(() => {});
    return photoJson({ error: "Could not check the code right now" }, 502);
  }
  await finishCameraBudget(budget.eventKey, approved ? "approved" : "denied").catch((error) =>
    console.error("Browser camera verification history could not finish", error instanceof Error ? error.name : "unknown"),
  );
  if (!approved) return photoJson({ error: "That code did not match" }, 401);

  const response = photoJson({ ok: true, phoneNumber: phone });
  response.cookies.set(CAMERA_SESSION_COOKIE, createPhotoToken(phone, "session"),
    photoCookieOptions("session"));
  response.cookies.set(CAMERA_CHALLENGE_COOKIE, "", {
    ...photoCookieOptions("challenge"), maxAge: 0,
  });
  return response;
}
