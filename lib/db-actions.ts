import { db } from './db';
import { stories, pages, feedback, conversations, generationJobs, type Story, type Page, type Feedback, type Conversation } from './schema';
import { and, eq, gt, gte, isNotNull, isNull, sql } from 'drizzle-orm';
import { generateComicSlug } from './slug-generator';

export async function createStory(data: { id?: string; title: string; description?: string; userId: string; style?: string; usesOwnApiKey?: boolean; source?: string }): Promise<Story> {
  // Generate a unique slug
  let slug = generateComicSlug();
  let attempts = 0;
  const maxAttempts = 10;

  // Ensure slug uniqueness
  while (attempts < maxAttempts) {
    const existing = await db.select().from(stories).where(eq(stories.slug, slug)).limit(1);
    if (existing.length === 0) break;
    slug = generateComicSlug();
    attempts++;
  }

  if (attempts >= maxAttempts) {
    // Fallback to a simple random slug if we can't generate a unique one
    slug = `story-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  }

  const [story] = await db
    .insert(stories)
    .values({ ...data, slug })
    .onConflictDoNothing({ target: stories.id })
    .returning();
  if (story) return story;
  if (!data.id) throw new Error("Failed to create story");
  const existing = await getStoryById(data.id);
  if (!existing) throw new Error("Failed to create story");
  return existing;
}

export async function createPage(data: {
  id?: string;
  storyId: string;
  pageNumber: number;
  prompt: string;
  characterImageUrls: string[];
}): Promise<Page> {
  const [page] = await db
    .insert(pages)
    .values(data)
    .onConflictDoNothing({ target: pages.id })
    .returning();
  if (page) return page;
  if (!data.id) throw new Error("Failed to create page");
  const [existing] = await db
    .select()
    .from(pages)
    .where(eq(pages.id, data.id))
    .limit(1);
  if (!existing) throw new Error("Failed to create page");
  return existing;
}

export async function updatePage(pageId: string, generatedImageUrl: string): Promise<void> {
  await db.update(pages)
    .set({ generatedImageUrl, updatedAt: new Date() })
    .where(eq(pages.id, pageId));
}

export async function updateStory(storyId: string, data: { title?: string; description?: string }): Promise<void> {
  await db.update(stories)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(stories.id, storyId));
}

export async function getStoryWithPages(storyId: string): Promise<{ story: Story; pages: Page[] } | null> {
  const storyResult = await db.select().from(stories).where(eq(stories.id, storyId)).limit(1);

  if (storyResult.length === 0) {
    return null;
  }

  const storyPages = await db.select().from(pages)
    .where(eq(pages.storyId, storyId))
    .orderBy(pages.pageNumber);

  return {
    story: storyResult[0],
    pages: storyPages,
  };
}

export async function getStoryById(storyId: string): Promise<Story | null> {
  const result = await db.select().from(stories).where(eq(stories.id, storyId)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function getStoryWithPagesBySlug(slug: string): Promise<{ story: Story; pages: Page[] } | null> {
  const storyResult = await db.select().from(stories).where(eq(stories.slug, slug)).limit(1);

  if (storyResult.length === 0) {
    return null;
  }

  const storyPages = await db.select().from(pages)
    .where(eq(pages.storyId, storyResult[0].id))
    .orderBy(pages.pageNumber);

  return {
    story: storyResult[0],
    pages: storyPages,
  };
}

export async function getStoryCharacterImages(storyId: string): Promise<string[]> {
  const storyPages = await db.select({
    characterImageUrls: pages.characterImageUrls,
    pageNumber: pages.pageNumber
  })
    .from(pages)
    .where(eq(pages.storyId, storyId))
    .orderBy(pages.pageNumber);

  // Flatten all character URLs from all pages, keeping order by page number
  const allUrls: string[] = [];
  const seenUrls = new Set<string>();

  for (const page of storyPages) {
    for (const url of page.characterImageUrls) {
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        allUrls.push(url);
      }
    }
  }

  return allUrls;
}

export async function getLastPageImage(storyId: string): Promise<string | null> {
  const allPages = await db.select({ generatedImageUrl: pages.generatedImageUrl, pageNumber: pages.pageNumber })
    .from(pages)
    .where(eq(pages.storyId, storyId))
    .orderBy(pages.pageNumber);

  if (allPages.length === 0) return null;

  // Find the last page that has a generated image
  for (let i = allPages.length - 1; i >= 0; i--) {
    if (allPages[i].generatedImageUrl) {
      return allPages[i].generatedImageUrl;
    }
  }

  return null;
}

export async function getNextPageNumber(storyId: string): Promise<number> {
  const storyPages = await db.select({ pageNumber: pages.pageNumber })
    .from(pages)
    .where(eq(pages.storyId, storyId))
    .orderBy(pages.pageNumber);

  if (storyPages.length === 0) {
    return 1;
  }

  return Math.max(...storyPages.map(p => p.pageNumber)) + 1;
}

export async function deletePage(pageId: string): Promise<void> {
  await db.delete(pages).where(eq(pages.id, pageId));
}

/** Remove only the unfinished continuation page belonging to a failed job. */
export async function deleteBlankContinuationPage({
  pageId,
  storyId,
  userId,
}: {
  pageId: string;
  storyId: string;
  userId: string;
}): Promise<boolean> {
  const [deleted] = await db
    .delete(pages)
    .where(and(
      eq(pages.id, pageId),
      eq(pages.storyId, storyId),
      gt(pages.pageNumber, 1),
      isNull(pages.generatedImageUrl),
      sql`EXISTS (
        SELECT 1 FROM ${stories}
        WHERE ${stories.id} = ${pages.storyId}
          AND ${stories.userId} = ${userId}
      )`,
      sql`EXISTS (
        SELECT 1 FROM ${generationJobs}
        WHERE ${generationJobs.id} = ${pages.id}
          AND ${generationJobs.targetStoryId} = ${pages.storyId}
          AND ${generationJobs.userId} = ${userId}
          AND ${generationJobs.status} = ${"failed"}
      )`,
    ))
    .returning({ id: pages.id });
  return Boolean(deleted);
}

export async function deleteStory(storyId: string): Promise<void> {
  await db.delete(stories).where(eq(stories.id, storyId));
}

export async function createFeedback(data: { message: string; userId?: string }): Promise<Feedback> {
  const [entry] = await db.insert(feedback).values(data).returning();
  return entry;
}

export async function getPagesGeneratedLast24Hours(): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pages)
    .where(and(isNotNull(pages.generatedImageUrl), gte(pages.createdAt, since)));
  return row?.count ?? 0;
}

export async function getOrCreateConversation(phoneNumber: string, channel: string = "sms"): Promise<Conversation> {
  const [created] = await db
    .insert(conversations)
    .values({ phoneNumber, channel, state: "collecting", collected: {} })
    .onConflictDoNothing({
      target: [conversations.channel, conversations.phoneNumber],
    })
    .returning();
  if (created) return created;

  const [existing] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.phoneNumber, phoneNumber),
        eq(conversations.channel, channel),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("Conversation disappeared during lookup");
  return existing;
}

export async function updateConversation(
  phoneNumber: string,
  data: { state?: string; collected?: Record<string, unknown>; activeStoryId?: string | null },
  channel: string = "sms",
): Promise<void> {
  await db
    .update(conversations)
    .set({ ...data, updatedAt: new Date() })
    .where(
      and(
        eq(conversations.phoneNumber, phoneNumber),
        eq(conversations.channel, channel),
      ),
    );
}

export async function resetConversation(
  phoneNumber: string,
  channel: string = "sms",
): Promise<void> {
  await db
    .update(conversations)
    .set({ state: "collecting", collected: {}, activeStoryId: null, updatedAt: new Date() })
    .where(
      and(
        eq(conversations.phoneNumber, phoneNumber),
        eq(conversations.channel, channel),
      ),
    );
}

interface GenerationConversationJob {
  recipientAddress: string;
  source: string;
  idempotencyKey: string;
  prompt: string;
}

function submittedDraftCondition(job: GenerationConversationJob) {
  return and(
    eq(conversations.phoneNumber, job.recipientAddress),
    eq(conversations.channel, job.source),
    eq(conversations.state, "generating"),
    // The marker is written before publishing to Azure Queue. Legacy rows
    // without a marker may still finish if their original prompt is active.
    sql`(
      ${conversations.collected}->>'generationRequestKey' = ${job.idempotencyKey}
      OR (
        ${conversations.collected}->>'generationRequestKey' IS NULL
        AND ${conversations.collected}->>'prompt' = ${job.prompt}
      )
    )`,
  );
}

export async function completeConversationForGeneration(
  job: GenerationConversationJob,
  storyId: string,
): Promise<boolean> {
  const [updated] = await db
    .update(conversations)
    .set({
      state: "done",
      activeStoryId: storyId,
      collected: sql`${conversations.collected} - 'generationRequestKey'`,
      updatedAt: new Date(),
    })
    .where(submittedDraftCondition(job))
    .returning({ id: conversations.id });
  return Boolean(updated);
}

export async function failConversationForGeneration(
  job: GenerationConversationJob,
): Promise<boolean> {
  const [updated] = await db
    .update(conversations)
    .set({
      state: "confirming",
      collected: sql`${conversations.collected} - 'generationRequestKey'`,
      updatedAt: new Date(),
    })
    .where(submittedDraftCondition(job))
    .returning({ id: conversations.id });
  return Boolean(updated);
}
