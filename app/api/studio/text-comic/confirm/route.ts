import { type NextRequest, type NextResponse } from "next/server";
import { getStoryWithPagesBySlug } from "@/lib/db-actions";
import { comicDeliveryUrl } from "@/lib/dub-short-links";
import { photoRequestHasAllowedOrigin } from "@/lib/browser-photo-session";
import { getStudioActor } from "@/lib/studio-guest-session";
import { finishStudioTextBudget, getStudioTextSourceId, reserveStudioTextBudget } from "@/lib/studio-comic-text-budget";
import {
  STUDIO_TEXT_CHALLENGE_COOKIE,
  getStudioComicTextOrigin,
  readSmallStudioTextJson,
  readStudioTextChallenge,
  studioTextCookieOptions,
  studioTextJson,
} from "@/lib/studio-comic-text";
import { sendSms } from "@/lib/twilio";
import { checkVoiceVerification } from "@/lib/voice-verification";

export const runtime = "nodejs";

function verificationExpired(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return Reflect.get(error, "status") === 404 || Reflect.get(error, "code") === 20404;
}

function clearChallenge(response: NextResponse): NextResponse {
  response.cookies.set(STUDIO_TEXT_CHALLENGE_COOKIE, "", {
    ...studioTextCookieOptions(),
    maxAge: 0,
  });
  return response;
}

export async function POST(request: NextRequest): Promise<Response> {
  if (!photoRequestHasAllowedOrigin(request)) {
    return studioTextJson({ error: "Request origin is not allowed" }, 403);
  }

  try {
    const origin = await getStudioComicTextOrigin();
    if (!origin) return studioTextJson({ error: "Comic texts are not available" }, 404);
    const actor = await getStudioActor(request);
    if (!actor) return studioTextJson({ error: "Open Studio to access your comic" }, 401);

    const challenge = readStudioTextChallenge(request.cookies.get(STUDIO_TEXT_CHALLENGE_COOKIE)?.value);
    if (!challenge || challenge.userId !== actor.userId) {
      return studioTextJson({ error: "Request a new verification code" }, 401);
    }

    const body = await readSmallStudioTextJson(request);
    const slug = body?.storySlug;
    const code = body?.code;
    if (typeof slug !== "string" || !/^[a-z0-9-]{1,160}$/.test(slug) ||
        typeof code !== "string" || !/^\d{6}$/.test(code)) {
      return studioTextJson({ error: "Enter the six-digit code" }, 400);
    }

    const result = await getStoryWithPagesBySlug(slug);
    if (!result || result.story.source !== "web" || result.story.userId !== actor.userId ||
        result.story.id !== challenge.storyId) {
      return studioTextJson({ error: "Comic not found" }, 404);
    }
    if (!result.pages.some((page) => Boolean(page.generatedImageUrl))) {
      return studioTextJson({ error: "Your comic is still being created" }, 409);
    }

    const sourceId = getStudioTextSourceId(request);
    if (!sourceId) return studioTextJson({ error: "Comic texts are unavailable right now" }, 503);
    const checkBudget = await reserveStudioTextBudget({
      kind: "verify_check",
      userId: actor.userId,
      storyId: result.story.id,
      phone: challenge.phone,
      sourceId,
    });
    if (!checkBudget.allowed) {
      return studioTextJson({
        error: checkBudget.reason === "rate_limit"
          ? "Too many code attempts. Try again later."
          : "Comic texts are unavailable right now",
      }, checkBudget.reason === "rate_limit" ? 429 : 503);
    }

    let approved: boolean;
    try {
      approved = await checkVoiceVerification(challenge.phone, code);
    } catch (error) {
      console.error("Studio comic text verification check failed", error instanceof Error ? error.name : "unknown");
      await finishStudioTextBudget(checkBudget.eventKey, "failed").catch(() => {});
      if (verificationExpired(error)) {
        return clearChallenge(studioTextJson({ error: "That code expired. Request a new one." }, 401));
      }
      return studioTextJson({ error: "Could not check the code right now" }, 502);
    }
    await finishStudioTextBudget(checkBudget.eventKey, approved ? "approved" : "denied").catch((error) =>
      console.error("Studio comic text check history could not finish", error instanceof Error ? error.name : "unknown"),
    );
    if (!approved) return studioTextJson({ error: "That code did not match" }, 401);

    const sendBudget = await reserveStudioTextBudget({
      kind: "link_send",
      userId: actor.userId,
      storyId: result.story.id,
      phone: challenge.phone,
      sourceId,
    });
    if (!sendBudget.allowed) {
      return clearChallenge(studioTextJson({
        error: sendBudget.reason === "rate_limit"
          ? "Too many comic texts sent. Use the browser link to share your comic."
          : "Comic texts are unavailable right now",
      }, sendBudget.reason === "rate_limit" ? 429 : 503));
    }

    const canonicalUrl = new URL(`/story/${encodeURIComponent(slug)}`, origin).toString();
    const comicUrl = await comicDeliveryUrl(result.story.id, slug, canonicalUrl);
    let messageSid: string;
    try {
      messageSid = await sendSms({
        to: challenge.phone,
        body: `Your Twilio Comics comic is ready: ${comicUrl}`,
      });
    } catch (error) {
      console.error("Studio comic link text could not be queued", error instanceof Error ? error.name : "unknown");
      await finishStudioTextBudget(sendBudget.eventKey, "failed").catch(() => {});
      return clearChallenge(studioTextJson({ error: "Could not text the comic link right now" }, 502));
    }
    await finishStudioTextBudget(sendBudget.eventKey, "sent", messageSid).catch((error) =>
      console.error("Studio comic link history could not finish", error instanceof Error ? error.name : "unknown"),
    );
    return clearChallenge(studioTextJson({ ok: true }));
  } catch (error) {
    console.error("Studio comic text unavailable", error instanceof Error ? error.name : "unknown");
    return studioTextJson({ error: "Comic texts are unavailable right now" }, 503);
  }
}
