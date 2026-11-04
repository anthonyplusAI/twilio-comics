import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { photoRequestHasAllowedOrigin } from "@/lib/browser-photo-session";
import { getBrowserStudioEnabled } from "@/lib/browser-studio-settings";
import { getStudioGuestSourceId, issueStudioGuestSession } from "@/lib/studio-guest-budget";
import {
  createStudioBudgetToken,
  createStudioGuestToken,
  getAuthorizedGoogleStudioActor,
  getStudioBudgetId,
  getStudioGuestActor,
  STUDIO_BUDGET_COOKIE,
  STUDIO_GUEST_COOKIE,
  studioBudgetCookieOptions,
  studioGuestCookieOptions,
} from "@/lib/studio-guest-session";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!photoRequestHasAllowedOrigin(request)) {
    return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
  }

  try {
    if (!await getBrowserStudioEnabled()) {
      return NextResponse.json({ error: "Browser Studio is closed" }, { status: 403 });
    }
    // This endpoint accepts no payload; new identities are charged to a trusted source.
    if (request.body || request.headers.get("content-length") !== null &&
        request.headers.get("content-length") !== "0") {
      return NextResponse.json({ error: "Session request must be empty" }, { status: 400 });
    }
    const google = await getAuthorizedGoogleStudioActor();
    if (google) {
      const response = NextResponse.json({ ready: true }, {
        headers: { "Cache-Control": "private, no-store, max-age=0" },
      });
      response.cookies.set(STUDIO_BUDGET_COOKIE,
        createStudioBudgetToken(getStudioBudgetId(request, google)),
        studioBudgetCookieOptions());
      return response;
    }
    const sourceId = getStudioGuestSourceId(request);
    if (!sourceId) {
      return NextResponse.json({ error: "Browser Studio is temporarily unavailable" }, { status: 503 });
    }

    const existing = await getStudioGuestActor(request);
    const userId = existing?.userId ?? randomUUID();
    if (!existing) {
      const issuance = await issueStudioGuestSession(userId, sourceId);
      if (issuance.reason === "rate_limit") {
        return NextResponse.json({ error: "Too many browser sessions from this network. Try again later." },
          { status: 429 });
      }
      if (issuance.reason === "unavailable") {
        return NextResponse.json({ error: "Browser Studio is temporarily unavailable" }, { status: 503 });
      }
    }

    const response = NextResponse.json(
      { ready: true },
      { headers: { "Cache-Control": "private, no-store, max-age=0" } },
    );
    response.cookies.set(STUDIO_GUEST_COOKIE, createStudioGuestToken(userId),
      studioGuestCookieOptions());
    response.cookies.set(STUDIO_BUDGET_COOKIE,
      createStudioBudgetToken(getStudioBudgetId(request, { userId, kind: "guest" })),
      studioBudgetCookieOptions());
    return response;
  } catch (error) {
    console.error("Browser Studio guest session unavailable", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ error: "Browser Studio is temporarily unavailable" }, { status: 503 });
  }
}
