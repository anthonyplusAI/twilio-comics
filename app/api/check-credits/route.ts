import { type NextRequest, NextResponse } from "next/server";
import { photoRequestHasAllowedOrigin } from "@/lib/browser-photo-session";
import { readBoundedStudioJson } from "@/lib/studio-guest-json";
import { getStudioActor } from "@/lib/studio-guest-session";

export async function POST(request: NextRequest) {
  try {
    const actor = await getStudioActor(request);
    const userId = actor?.userId;

    if (!userId) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }

    if (actor?.kind === "guest" && !photoRequestHasAllowedOrigin(request)) {
      return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
    }

    const json = await readBoundedStudioJson(request);
    if (!json.ok) return NextResponse.json({ error: json.error }, { status: json.status });
    const body = json.value;
    const hasApiKey = body && typeof body === "object" && "hasApiKey" in body
      ? (body as { hasApiKey: unknown }).hasApiKey : false;
    if (actor?.kind === "guest" && hasApiKey) {
      return NextResponse.json({ error: "Browser Studio uses the app's OpenAI key" }, { status: 400 });
    }

    // Public Studio uses rolling throughput safeguards, not weekly credits.
    return NextResponse.json({
      hasApiKey: hasApiKey === true,
      creditsRemaining: "unlimited",
      resetTime: null,
    });
  } catch (error) {
    console.error("Error in check-credits API:", error);
    return NextResponse.json(
      { error: "Could not check comic availability" },
      { status: 500 }
    );
  }
}
