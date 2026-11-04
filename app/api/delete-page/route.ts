import { type NextRequest, NextResponse } from "next/server";
import { photoRequestHasAllowedOrigin } from "@/lib/browser-photo-session";
import { getStoryWithPagesBySlug, deletePage } from "@/lib/db-actions";
import { readBoundedStudioJson } from "@/lib/studio-guest-json";
import { getStudioActor } from "@/lib/studio-guest-session";

export async function DELETE(request: NextRequest) {
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
    const fields = json.value && typeof json.value === "object" && !Array.isArray(json.value)
      ? json.value as Record<string, unknown>
      : {};
    const { storySlug, pageId } = fields;

    if (typeof storySlug !== "string" || !storySlug ||
        typeof pageId !== "string" || !pageId) {
      return NextResponse.json(
        { error: "Missing required fields: storySlug and pageId" },
        { status: 400 }
      );
    }

    // Get the story to check ownership
    const storyData = await getStoryWithPagesBySlug(storySlug);
    if (!storyData) {
      return NextResponse.json({ error: "Story not found" }, { status: 404 });
    }

    const { story, pages } = storyData;

    // Check ownership
    if (story.userId !== userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    // Check if page exists and belongs to the story
    const pageExists = pages.some(p => p.id === pageId);
    if (!pageExists) {
      return NextResponse.json({ error: "Page not found" }, { status: 404 });
    }

    // Don't allow deleting the last page
    if (pages.length <= 1) {
      return NextResponse.json(
        { error: "Cannot delete the last page of a story" },
        { status: 400 }
      );
    }

    await deletePage(pageId);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting page:", error);
    return NextResponse.json(
      { error: "Could not delete page" },
      { status: 500 }
    );
  }
}
