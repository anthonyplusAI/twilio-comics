import { type NextRequest } from "next/server";
import { getCameraDestination, photoJson, readSmallPhotoJson } from "@/lib/browser-photo-access";
import { finishCameraBudget, reserveCameraBudget } from "@/lib/browser-photo-budget";
import {
  CAMERA_CHALLENGE_COOKIE,
  CAMERA_SESSION_COOKIE,
  createPhotoToken,
  normalizePhotoPhone,
  photoCookieOptions,
  photoRequestHasAllowedOrigin,
} from "@/lib/browser-photo-session";
import { startVoiceVerification } from "@/lib/voice-verification";

export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<Response> {
  if (!photoRequestHasAllowedOrigin(request)) return photoJson({ error: "Request origin is not allowed" }, 403);
  const destination = await getCameraDestination();
  if (!destination) return photoJson({ error: "Camera photos are not enabled" }, 404);
  const body = await readSmallPhotoJson(request);
  const phone = normalizePhotoPhone(body?.phoneNumber);
  if (!phone) return photoJson({ error: "Enter a mobile number with its country code" }, 400);

  const budget = await reserveCameraBudget("verification_start", phone);
  if (!budget.allowed) {
    return photoJson({
      error: budget.reason === "rate_limit"
        ? "Too many codes have been requested. Try again later."
        : "Verification is unavailable right now.",
    }, budget.reason === "rate_limit" ? 429 : 503);
  }

  try {
    await startVoiceVerification(phone);
  } catch (error) {
    console.error("Browser camera verification could not start", error instanceof Error ? error.name : "unknown");
    await finishCameraBudget(budget.eventKey, "failed").catch(() => {});
    return photoJson({ error: "Could not send a verification code right now" }, 502);
  }
  await finishCameraBudget(budget.eventKey, "sent").catch((error) =>
    console.error("Browser camera verification history could not finish", error instanceof Error ? error.name : "unknown"),
  );

  const response = photoJson({ ok: true, phoneNumber: phone });
  response.cookies.set(CAMERA_CHALLENGE_COOKIE, createPhotoToken(phone, "challenge"),
    photoCookieOptions("challenge"));
  response.cookies.set(CAMERA_SESSION_COOKIE, "", {
    ...photoCookieOptions("session"), maxAge: 0,
  });
  return response;
}
