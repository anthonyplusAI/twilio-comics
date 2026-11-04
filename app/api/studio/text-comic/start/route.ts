import { type NextRequest } from "next/server";
import { getStoryWithPagesBySlug } from "@/lib/db-actions";
import { photoRequestHasAllowedOrigin, normalizePhotoPhone } from "@/lib/browser-photo-session";
import { getStudioActor } from "@/lib/studio-guest-session";
import { finishStudioTextBudget, getStudioTextSourceId, reserveStudioTextBudget } from "@/lib/studio-comic-text-budget";
import {
  STUDIO_TEXT_CHALLENGE_COOKIE,
  createStudioTextChallenge,
  getStudioComicTextOrigin,
  readSmallStudioTextJson,
  studioTextCookieOptions,
  studioTextJson,
} from "@/lib/studio-comic-text";
import { startVoiceVerification } from "@/lib/voice-verification";

export const runtime = "nodejs";

export async function POST(request: NextRequest): Promise<Response> {
  if (!photoRequestHasAllowedOrigin(request)) {
    return studioTextJson({ error: "Request origin is not allowed" }, 403);
  }

  try {
    if (!await getStudioComicTextOrigin()) {
      return studioTextJson({ error: "Comic texts are not available" }, 404);
    }
    const actor = await getStudioActor(request);
    if (!actor) return studioTextJson({ error: "Open Studio to access your comic" }, 401);

    const body = await readSmallStudioTextJson(request);
    const slug = body?.storySlug;
    const phone = normalizePhotoPhone(body?.phoneNumber);
    if (typeof slug !== "string" || !/^[a-z0-9-]{1,160}$/.test(slug) || !phone) {
      return studioTextJson({ error: "Enter a valid comic and mobile number" }, 400);
    }

    const result = await getStoryWithPagesBySlug(slug);
    if (!result || result.story.source !== "web" || result.story.userId !== actor.userId) {
      return studioTextJson({ error: "Comic not found" }, 404);
    }
    if (!result.pages.some((page) => Boolean(page.generatedImageUrl))) {
      return studioTextJson({ error: "Your comic is still being created" }, 409);
    }

    const sourceId = getStudioTextSourceId(request);
    if (!sourceId) return studioTextJson({ error: "Comic texts are unavailable right now" }, 503);
    const budget = await reserveStudioTextBudget({
      kind: "verify_start",
      userId: actor.userId,
      storyId: result.story.id,
      phone,
      sourceId,
    });
    if (!budget.allowed) {
      return studioTextJson({
        error: budget.reason === "rate_limit"
          ? "Too many codes requested. Try again later."
          : "Comic texts are unavailable right now",
      }, budget.reason === "rate_limit" ? 429 : 503);
    }

    try {
      await startVoiceVerification(phone);
    } catch (error) {
      console.error("Studio comic text verification could not start", error instanceof Error ? error.name : "unknown");
      await finishStudioTextBudget(budget.eventKey, "failed").catch(() => {});
      return studioTextJson({ error: "Could not send a code right now" }, 502);
    }
    await finishStudioTextBudget(budget.eventKey, "sent").catch((error) =>
      console.error("Studio comic text verification history could not finish", error instanceof Error ? error.name : "unknown"),
    );

    const response = studioTextJson({ ok: true, phoneNumber: phone });
    response.cookies.set(STUDIO_TEXT_CHALLENGE_COOKIE,
      createStudioTextChallenge({ userId: actor.userId, storyId: result.story.id, phone }),
      studioTextCookieOptions());
    return response;
  } catch (error) {
    console.error("Studio comic text verification unavailable", error instanceof Error ? error.name : "unknown");
    return studioTextJson({ error: "Comic texts are unavailable right now" }, 503);
  }
}
