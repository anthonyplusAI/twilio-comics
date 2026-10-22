import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { getStoryWithPagesBySlug, updateStory } from "@/lib/db-actions";
import { db } from "@/lib/db";
import { stories } from "@/lib/schema";
import { eq } from "drizzle-orm";

function privateJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ storySlug: string }> }
) {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    const { storySlug: slug } = await params;

    // Special case: if slug is "all", return user's stories for debugging
    if (slug === "all") {
      if (!userId) {
        return privateJson({ error: "Authentication required for this endpoint" }, 401);
      }
      const userStories = await db
        .select()
        .from(stories)
        .where(eq(stories.userId, userId));
      return privateJson({
        message: "User stories",
        stories: userStories.map((s) => ({
          id: s.id,
          slug: s.slug,
          title: s.title,
        })),
      });
    }

    if (!slug) {
      return privateJson({ error: "Story slug is required" }, 400);
    }

    const result = await getStoryWithPagesBySlug(slug);

    if (!result) {
      return privateJson({ error: "Story not found" }, 404);
    }

    // Check if the story belongs to the authenticated user
    const isOwner = userId ? result.story.userId === userId : false;

    const publicStory = {
      slug: result.story.slug,
      title: result.story.title,
      style: result.story.style,
    };
    const responseData = {
      story: isOwner
        ? {
            ...publicStory,
            id: result.story.id,
            description: result.story.description,
            source: result.story.source,
            createdAt: result.story.createdAt,
            updatedAt: result.story.updatedAt,
          }
        : publicStory,
      pages: result.pages.map((page) =>
        isOwner
          ? page
          : {
              pageNumber: page.pageNumber,
              generatedImageUrl: page.generatedImageUrl,
            },
      ),
      isOwner,
    };
    return privateJson(responseData);
  } catch (error) {
    console.error("Error fetching story:", error);
    return privateJson({ error: "Failed to fetch story" }, 500);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ storySlug: string }> }
) {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return privateJson({ error: "Authentication required" }, 401);
    }

    const { storySlug: slug } = await params;

    if (!slug) {
      return privateJson({ error: "Story slug is required" }, 400);
    }

    const result = await getStoryWithPagesBySlug(slug);

    if (!result) {
      return privateJson({ error: "Story not found" }, 404);
    }

    // Check if the story belongs to the authenticated user
    if (result.story.userId !== userId) {
      return privateJson({ error: "Unauthorized" }, 403);
    }

    const { title } = await request.json();

    if (!title || typeof title !== "string" || title.trim().length === 0) {
      return privateJson({ error: "Title is required and must be a non-empty string" }, 400);
    }

    await updateStory(result.story.id, { title: title.trim() });

    return privateJson({ success: true });
  } catch (error) {
    console.error("Error updating story:", error);
    return privateJson({ error: "Failed to update story" }, 500);
  }
}
