# Phase B: Twilio SMS/MMS Channel — Implementation Plan

> **Superseded:** This is a historical implementation plan. Current architecture and setup are documented in the root README and `docs/INFRA_SETUP.md`; provider, storage, authentication, job, and deployment details below are not current instructions.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user create a comic entirely over SMS/MMS — text their name + story prompt (optionally an MMS photo), get the finished comic page delivered back as an MMS image plus a link to the web story page.

**Architecture:** A signature-validated inbound webhook (`/api/twilio/sms`) runs a per-phone-number conversation state machine (persisted in a new `conversations` table). When enough is collected it enqueues a durable QStash job and immediately acks (beating Twilio's ~15s timeout). A worker route (`/api/twilio/generate-worker`) runs the 30–60s generation via a new channel-agnostic `lib/comic-service.ts` (shared with the web route), then sends the result as an outbound MMS. The phone number (E.164) is the story's `userId`.

**Tech Stack:** Next.js 16 App Router, TypeScript, `twilio` SDK, `@upstash/qstash`, Drizzle/Neon, OpenAI `gpt-image-2` (via Phase A's `lib/image-generation.ts`), Vitest.

## Global Constraints

- Builds on Phase A (branch `feat/gpt-image-2-twilio-channels`). Phase A provides `lib/image-generation.ts` (`generateComicImage({ apiKey, prompt, referenceImageUrls }): Promise<Buffer>`) and `lib/s3-upload.ts` (`uploadBufferToS3(buffer, key, contentType?): Promise<string>`). Reuse them; do not reimplement.
- Image generation is **server-funded**: always `process.env.OPENAI_API_KEY`. No BYO key on Twilio channels.
- Identity: the E.164 phone number (Twilio `From`) is the story's `userId` (the column is `text`, no type change). Twilio stories set `source = 'sms'`.
- Rate limiting: reuse `freeTierRateLimit` (Upstash) keyed by the phone number, applied after a successful generation — consistent with Phase A (rate-limit everyone, server-funded).
- Signature validation is mandatory: verify `X-Twilio-Signature` on the inbound webhook and `Upstash-Signature` on the worker. Reject invalid requests with 403 before any work.
- TwiML responses use `Content-Type: text/xml`. Inbound MMS media downloads need HTTP Basic auth (Account SID + Auth Token). Outbound MMS `mediaUrl` must be a public S3 URL (already public).
- Conversation flow is intentionally SHORT: **name → story prompt → generate**. Style defaults to `noir`. A photo is optional: if any inbound message includes an image (`NumMedia > 0`), attach it as a character reference.
- Per AGENTS.md: never run `pnpm dev`; use `pnpm build` / `pnpm lint` / `pnpm test`. Run `pnpm drizzle-kit generate` to create migrations and `pnpm drizzle-kit push` to apply — BUT applying requires a live `DATABASE_URL`, which is the user's step; the plan generates the migration file and documents the push, it does not require a live DB to complete a task.
- Env additions this phase: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`, `PUBLIC_BASE_URL`.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `package.json` | add `twilio`, `@upstash/qstash` | Modify |
| `lib/schema.ts` | add `stories.source`; add `conversations` table + types | Modify |
| `drizzle/0006_*.sql` + meta | generated migration for the above | Create (generated) |
| `lib/comic-service.ts` | channel-agnostic `createComicStory()` — create story+page, gen image, upload, title, rate-limit, cleanup | Create |
| `lib/comic-service.test.ts` | unit tests (mocked deps) for the orchestration | Create |
| `app/api/generate-comic/route.ts` | refactor to call `createComicStory` (thin adapter) | Modify |
| `lib/twilio.ts` | Twilio client, `validateTwilioSignature`, `sendComicMms`, `downloadTwilioMedia` | Create |
| `lib/twilio.test.ts` | unit tests for signature validation + media/mms param assembly (mocked SDK) | Create |
| `lib/conversation.ts` | pure state machine `advanceConversation(state, inbound) → { nextState, collected, reply, action }` | Create |
| `lib/conversation.test.ts` | table-driven unit tests for the state machine | Create |
| `lib/qstash.ts` | `publishGenerationJob(payload)`, `verifyQstashSignature(req)` | Create |
| `lib/db-actions.ts` | conversation CRUD: `getOrCreateConversation`, `updateConversation`, `resetConversation` | Modify |
| `app/api/twilio/sms/route.ts` | inbound webhook: validate → advance SM → persist → enqueue/ack → TwiML | Create |
| `app/api/twilio/generate-worker/route.ts` | QStash worker: verify → createComicStory → outbound MMS | Create |
| `.example.env`, `README.md`, `.env.example` comments | new env vars + SMS setup docs | Modify |

**Note on `lib/comic-service.ts` (spec D1):** deferred from Phase A because there was only one caller. Phase B adds the SMS worker as a genuine second caller, so the extraction lands now. The web route (`generate-comic`) is refactored to delegate to it in the same task, so the two callers share one code path.

---

## Task 1: Add Twilio and QStash SDKs

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `twilio` and `@upstash/qstash` importable.

- [ ] **Step 1: Install**

Run:
```bash
pnpm add twilio @upstash/qstash
```
Expected: both appear in `dependencies`; lockfile updated.

- [ ] **Step 2: Verify they import**

Run:
```bash
node -e "require('twilio'); require('@upstash/qstash'); console.log('ok')"
```
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add twilio and qstash sdks

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Schema — `stories.source` + `conversations` table

**Files:**
- Modify: `lib/schema.ts`
- Create (generated): `drizzle/0006_*.sql` + `drizzle/meta/*`

**Interfaces:**
- Produces: `stories.source` column; `conversations` table; exported types `Conversation`, `NewConversation`. Consumed by Tasks 3, 7, 8 and `db-actions` (Task's own + Task 7).
- The `conversations` row shape:
  - `id` uuid pk default random
  - `phoneNumber` text not null unique (E.164, the `From`)
  - `channel` text not null default `'sms'` (`sms` | `voice`)
  - `state` text not null default `'awaiting_name'`
  - `collected` jsonb `$type<{ name?: string; prompt?: string; style?: string; characterImageUrls?: string[] }>` default `{}` not null
  - `activeStoryId` uuid null (references stories.id, no cascade needed — nullable link)
  - `createdAt`, `updatedAt` timestamps default now not null

- [ ] **Step 1: Add `source` to the stories table**

In `lib/schema.ts`, in the `stories` pgTable definition, add after the `style` line:
```ts
  source: text('source').default('web').notNull(),
```

- [ ] **Step 2: Add the `conversations` table**

In `lib/schema.ts`, after the `pages` table definition (before Relations), add:
```ts
// Conversations table — SMS/Voice input state machine, keyed by phone number
export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  phoneNumber: text('phone_number').notNull().unique(),
  channel: text('channel').default('sms').notNull(),
  state: text('state').default('awaiting_name').notNull(),
  collected: jsonb('collected')
    .$type<{ name?: string; prompt?: string; style?: string; characterImageUrls?: string[] }>()
    .default({})
    .notNull(),
  activeStoryId: uuid('active_story_id'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
```

- [ ] **Step 3: Export conversation types**

In `lib/schema.ts`, with the other type exports at the bottom, add:
```ts
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
```

- [ ] **Step 4: Generate the migration**

Run:
```bash
pnpm drizzle-kit generate
```
Expected: a new `drizzle/0006_*.sql` file is created containing `ALTER TABLE "stories" ADD COLUMN "source" ... ` and `CREATE TABLE "conversations" (...)`, plus an updated `drizzle/meta/_journal.json`. This step only needs the schema file (no live DB).

- [ ] **Step 5: Verify the migration SQL looks right**

Run:
```bash
cat drizzle/0006_*.sql
```
Expected: contains `ADD COLUMN "source" text DEFAULT 'web' NOT NULL` and `CREATE TABLE "conversations"` with a unique constraint on `phone_number`. If `source` is missing or the table is malformed, fix `lib/schema.ts` and regenerate.

- [ ] **Step 6: Verify TS compiles**

Run:
```bash
pnpm exec tsc --noEmit 2>&1 | grep -i "schema.ts" || echo "no schema.ts type errors"
```
Expected: `no schema.ts type errors`.

- [ ] **Step 7: Commit**

```bash
git add lib/schema.ts drizzle/
git commit -m "feat: add stories.source and conversations table

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> **User step (documented, not part of this task's automated completion):** apply the migration to the live DB with `pnpm drizzle-kit push` (needs a real `DATABASE_URL`). Noted in Task 9 docs.

---

## Task 3: `lib/comic-service.ts` — channel-agnostic story creation + refactor web route

**Files:**
- Create: `lib/comic-service.ts`
- Test: `lib/comic-service.test.ts`
- Modify: `app/api/generate-comic/route.ts` (delegate to the service)

**Interfaces:**
- Consumes: `generateComicImage` (Phase A), `uploadBufferToS3` (Phase A), `buildComicPrompt`, `createStory`/`createPage`/`updateStory`/`updatePage`/`deleteStory` (db-actions), `freeTierRateLimit`, `COMIC_STYLES`, `isContentPolicyViolation`.
- Produces:
  ```ts
  export type ComicServiceError =
    | { type: "content_policy" }
    | { type: "credit_limit" }
    | { type: "api_error"; status?: number; message: string };
  export interface CreateComicResult {
    story: { id: string; slug: string; title: string; description?: string };
    page: { id: string; pageNumber: number };
    imageUrl: string;
  }
  export interface CreateComicArgs {
    userId: string;               // Clerk id OR E.164 phone
    prompt: string;
    style?: string;               // default "noir"
    characterImageUrls?: string[];
    source: "web" | "sms" | "voice";
    generateTitle?: boolean;      // default true
  }
  // Throws ComicServiceError-shaped errors (see below) on failure, after cleaning up rows.
  export function createComicStory(args: CreateComicArgs): Promise<CreateComicResult>;
  ```
  Consumed by the web route (this task) and the QStash worker (Task 8).

**Design notes:**
- This extracts the "new story, page 1" path from `generate-comic/route.ts` — story creation, prompt build, image generation (server key), S3 upload, OpenAI title/description generation gated by `generateTitle`, rate-limit application (unconditional, keyed by `userId`), and DB cleanup on failure.
- It throws typed errors (a small `ComicServiceError` class) instead of returning `NextResponse`, so both an HTTP route and a background worker can map them to their own output (JSON vs. SMS copy).
- Title generation failure must NOT fail the whole request (existing behavior: falls back to a prompt-derived title).

- [ ] **Step 1: Write the failing test**

Create `lib/comic-service.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  generateComicImage: vi.fn(),
  uploadBufferToS3: vi.fn(),
  createStory: vi.fn(),
  createPage: vi.fn(),
  updateStory: vi.fn(),
  updatePage: vi.fn(),
  deleteStory: vi.fn(),
  limit: vi.fn(),
}));

vi.mock("@/lib/image-generation", () => ({ generateComicImage: h.generateComicImage }));
vi.mock("@/lib/s3-upload", () => ({ uploadBufferToS3: h.uploadBufferToS3 }));
vi.mock("@/lib/db-actions", () => ({
  createStory: h.createStory,
  createPage: h.createPage,
  updateStory: h.updateStory,
  updatePage: h.updatePage,
  deleteStory: h.deleteStory,
}));
vi.mock("@/lib/rate-limit", () => ({ freeTierRateLimit: { limit: h.limit } }));

import { createComicStory, ComicServiceError } from "@/lib/comic-service";

beforeEach(() => {
  Object.values(h).forEach((f) => f.mockReset());
  h.createStory.mockResolvedValue({ id: "s1", slug: "hero-abcd", title: "temp", description: null });
  h.createPage.mockResolvedValue({ id: "p1", pageNumber: 1 });
  h.generateComicImage.mockResolvedValue(Buffer.from("png"));
  h.uploadBufferToS3.mockResolvedValue("https://bucket.s3.amazonaws.com/comics/s1/page-1.png");
  h.updateStory.mockResolvedValue(undefined);
  h.updatePage.mockResolvedValue(undefined);
  h.limit.mockResolvedValue({ success: true });
});

describe("createComicStory", () => {
  it("creates a story + page, generates and uploads image, applies rate limit, returns urls", async () => {
    const res = await createComicStory({
      userId: "+15551234567",
      prompt: "batman on a rooftop",
      source: "sms",
      generateTitle: false,
    });
    expect(h.createStory).toHaveBeenCalledOnce();
    expect(h.createStory.mock.calls[0][0]).toMatchObject({ userId: "+15551234567", source: "sms" });
    expect(h.generateComicImage).toHaveBeenCalledOnce();
    expect(h.uploadBufferToS3).toHaveBeenCalledOnce();
    expect(h.updatePage).toHaveBeenCalledWith("p1", res.imageUrl);
    expect(h.limit).toHaveBeenCalledWith("+15551234567");
    expect(res.imageUrl).toContain("page-1.png");
    expect(res.story.slug).toBe("hero-abcd");
  });

  it("passes character image urls to generation as references", async () => {
    await createComicStory({
      userId: "u1", prompt: "x", source: "web", generateTitle: false,
      characterImageUrls: ["https://s3/a.png"],
    });
    expect(h.generateComicImage.mock.calls[0][0].referenceImageUrls).toEqual(["https://s3/a.png"]);
  });

  it("deletes the story and throws content_policy on a policy violation", async () => {
    h.generateComicImage.mockRejectedValue(new Error("Your request was rejected as a result of our safety system"));
    await expect(
      createComicStory({ userId: "u1", prompt: "x", source: "web", generateTitle: false }),
    ).rejects.toMatchObject({ type: "content_policy" });
    expect(h.deleteStory).toHaveBeenCalledWith("s1");
  });

  it("maps a 402 to credit_limit and cleans up", async () => {
    const err: any = new Error("insufficient_quota"); err.status = 402;
    h.generateComicImage.mockRejectedValue(err);
    await expect(
      createComicStory({ userId: "u1", prompt: "x", source: "web", generateTitle: false }),
    ).rejects.toMatchObject({ type: "credit_limit" });
    expect(h.deleteStory).toHaveBeenCalledWith("s1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/comic-service.test.ts`
Expected: FAIL — `@/lib/comic-service` not found.

- [ ] **Step 3: Implement `lib/comic-service.ts`**

```ts
import { COMIC_STYLES } from "./constants";
import { buildComicPrompt } from "./prompt";
import { generateComicImage } from "./image-generation";
import { uploadBufferToS3 } from "./s3-upload";
import {
  createStory,
  createPage,
  updateStory,
  updatePage,
  deleteStory,
} from "./db-actions";
import { freeTierRateLimit } from "./rate-limit";
import { isContentPolicyViolation } from "./utils";
import OpenAI from "openai";

const TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-4.1-mini";

export class ComicServiceError extends Error {
  type: "content_policy" | "credit_limit" | "api_error";
  status?: number;
  constructor(type: "content_policy" | "credit_limit" | "api_error", message: string, status?: number) {
    super(message);
    this.type = type;
    this.status = status;
  }
}

export interface CreateComicArgs {
  userId: string;
  prompt: string;
  style?: string;
  characterImageUrls?: string[];
  source: "web" | "sms" | "voice";
  generateTitle?: boolean;
}

export interface CreateComicResult {
  story: { id: string; slug: string; title: string; description?: string };
  page: { id: string; pageNumber: number };
  imageUrl: string;
}

async function generateTitleAndDescription(prompt: string, style: string) {
  try {
    const styleName = COMIC_STYLES.find((s) => s.id === style)?.name || style;
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const titlePrompt = `Based on this comic book prompt, generate a compelling title and description for the comic book.\n\nPrompt: "${prompt}"\nStyle: ${styleName}\n\nGenerate:\n1. A catchy, engaging title (maximum 60 characters)\n2. A brief description (2-3 sentences, maximum 200 characters)\n\nFormat your response as JSON:\n{\n  "title": "Title here",\n  "description": "Description here"\n}\n\nOnly return the JSON, no other text.`;
    const textResponse = await client.chat.completions.create({
      model: TEXT_MODEL,
      messages: [
        { role: "system", content: "You are a creative assistant that generates compelling comic book titles and descriptions. Always respond with valid JSON only." },
        { role: "user", content: titlePrompt },
      ],
      temperature: 0.8,
      max_tokens: 300,
    });
    const content = textResponse.choices[0]?.message?.content?.trim();
    if (!content) throw new Error("No response from text generation");
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");
    const parsed = JSON.parse(jsonMatch[0]);
    const fallbackTitle = prompt.length > 50 ? prompt.substring(0, 50) + "..." : prompt;
    const rawTitle = parsed.title?.trim() || fallbackTitle;
    const rawDescription = parsed.description?.trim();
    const title = rawTitle.length > 60 ? rawTitle.substring(0, 57) + "..." : rawTitle;
    const description = rawDescription && rawDescription.length > 200 ? rawDescription.substring(0, 197) + "..." : rawDescription;
    return { title, description: description || undefined };
  } catch (error) {
    console.error("Error generating title and description:", error);
    return { title: prompt.length > 50 ? prompt.substring(0, 50) + "..." : prompt, description: undefined };
  }
}

export async function createComicStory({
  userId,
  prompt,
  style = "noir",
  characterImageUrls = [],
  source,
  generateTitle = true,
}: CreateComicArgs): Promise<CreateComicResult> {
  const fallbackTitle = prompt.length > 50 ? prompt.substring(0, 50) + "..." : prompt;

  const story = await createStory({
    title: fallbackTitle,
    description: undefined,
    userId,
    style,
    source,
  });

  const page = await createPage({
    storyId: story.id,
    pageNumber: 1,
    prompt,
    characterImageUrls,
  });

  const fullPrompt = buildComicPrompt({ prompt, style, characterImages: characterImageUrls });

  // Kick off title generation in parallel (non-fatal)
  const titlePromise = generateTitle
    ? generateTitleAndDescription(prompt, style)
    : Promise.resolve({ title: fallbackTitle, description: undefined as string | undefined });

  let imageBuffer: Buffer;
  try {
    imageBuffer = await generateComicImage({
      apiKey: process.env.OPENAI_API_KEY!,
      prompt: fullPrompt,
      referenceImageUrls: characterImageUrls,
    });
  } catch (error) {
    try {
      await deleteStory(story.id);
    } catch (cleanupError) {
      console.error("Error cleaning up story on generation failure:", cleanupError);
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    if (error instanceof Error && isContentPolicyViolation(message)) {
      throw new ComicServiceError("content_policy", message);
    }
    const status = error && typeof error === "object" && "status" in error ? (error as { status?: number }).status : undefined;
    if (status === 402 || status === 429) {
      throw new ComicServiceError("credit_limit", message, status);
    }
    throw new ComicServiceError("api_error", message, status);
  }

  const s3Key = `${story.id}/page-${page.pageNumber}-${Date.now()}.png`;
  const imageUrl = await uploadBufferToS3(imageBuffer, s3Key, "image/png");

  const { title, description } = await titlePromise;
  try {
    await updateStory(story.id, { title, description });
  } catch (dbError) {
    console.error("Error updating story title/description:", dbError);
  }

  await updatePage(page.id, imageUrl);

  try {
    await freeTierRateLimit.limit(userId);
  } catch (rateLimitError) {
    console.error("Error applying rate limit after successful generation:", rateLimitError);
  }

  return {
    story: { id: story.id, slug: story.slug, title, description },
    page: { id: page.id, pageNumber: page.pageNumber },
    imageUrl,
  };
}
```

- [ ] **Step 4: Update `createStory` in db-actions to accept `source`**

In `lib/db-actions.ts`, extend the `createStory` data param type to include `source?: string`:
```ts
export async function createStory(data: { title: string; description?: string; userId: string; style?: string; usesOwnApiKey?: boolean; source?: string }): Promise<Story> {
```
(The `...data` spread already forwards it to the insert; no other change needed.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test lib/comic-service.test.ts`
Expected: PASS (4 tests). If the content-policy test fails, confirm `isContentPolicyViolation` matches the "safety system" string (it does after Phase A Task 4).

- [ ] **Step 6: Refactor the web route to delegate**

In `app/api/generate-comic/route.ts`, replace the NEW-STORY branch (the `else` where `storyId` is falsy) so that after auth + validation it calls `createComicStory`. Keep the CONTINUATION branch (`if (storyId)`) exactly as-is for now (it is exercised less and will be unified in a later cleanup — do not touch it this task). Concretely: in the `else` branch, instead of the inline create/generate/upload/title logic, call:
```ts
    try {
      const result = await createComicStory({
        userId,
        prompt,
        style,
        characterImageUrls: characterImages,
        source: "web",
        generateTitle: true,
      });
      return NextResponse.json({
        imageUrl: result.imageUrl,
        storyId: result.story.id,
        storySlug: result.story.slug,
        pageId: result.page.id,
        pageNumber: result.page.pageNumber,
        title: result.story.title,
        description: result.story.description,
      });
    } catch (error) {
      if (error instanceof ComicServiceError) {
        if (error.type === "content_policy") {
          return NextResponse.json({ error: getContentPolicyErrorMessage(), errorType: "content_policy" }, { status: 400 });
        }
        if (error.type === "credit_limit") {
          return NextResponse.json({ error: "Insufficient API credits. Please add credits to your OpenAI account at https://platform.openai.com/account/billing or update your API key.", errorType: "credit_limit" }, { status: 402 });
        }
        return NextResponse.json({ error: error.message || "Failed to generate image", errorType: "api_error" }, { status: error.status || 500 });
      }
      throw error;
    }
```
Add the imports at the top: `import { createComicStory, ComicServiceError } from "@/lib/comic-service";` and ensure `getContentPolicyErrorMessage` is imported (it already is). Remove the now-dead inline title/generation code from the `else` path ONLY (the continuation `if (storyId)` path keeps its own copy).

> If cleanly splitting the two branches proves awkward, STOP and report DONE_WITH_CONCERNS describing the tangle — do not force a risky refactor of the continuation path.

- [ ] **Step 7: Verify build + full tests**

Run: `pnpm build 2>&1 | grep -iE "Compiled|Failed to compile"` and `pnpm test`
Expected: "Compiled successfully"; all tests pass (Phase A's 9 + comic-service's 4 = 13+).

- [ ] **Step 8: Commit**

```bash
git add lib/comic-service.ts lib/comic-service.test.ts lib/db-actions.ts app/api/generate-comic/route.ts
git commit -m "feat: extract channel-agnostic comic-service; web route delegates

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `lib/twilio.ts` — client, signature validation, MMS send, media download

**Files:**
- Create: `lib/twilio.ts`
- Test: `lib/twilio.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function validateTwilioSignature(args: { signature: string | null; url: string; params: Record<string, string> }): boolean;
  export function sendComicMms(args: { to: string; body: string; mediaUrl?: string }): Promise<void>;
  export function sendSms(args: { to: string; body: string }): Promise<void>;
  export async function downloadTwilioMedia(mediaUrl: string): Promise<{ buffer: Buffer; contentType: string }>;
  export interface InboundSms {
    from: string; to: string; body: string;
    mediaUrls: string[]; mediaContentTypes: string[];
  }
  export function parseInboundSms(params: Record<string, string>): InboundSms;
  ```
  Consumed by the SMS webhook (Task 7) and worker (Task 8).

- [ ] **Step 1: Write the failing test**

Create `lib/twilio.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  validateRequest: vi.fn(),
  create: vi.fn(),
}));

vi.mock("twilio", () => {
  const twilio: any = vi.fn(() => ({ messages: { create: h.create } }));
  twilio.validateRequest = h.validateRequest;
  return { default: twilio };
});

beforeEach(() => {
  process.env.TWILIO_ACCOUNT_SID = "ACtest";
  process.env.TWILIO_AUTH_TOKEN = "tok";
  process.env.TWILIO_PHONE_NUMBER = "+15550000000";
  h.validateRequest.mockReset();
  h.create.mockReset();
  h.create.mockResolvedValue({ sid: "SM1" });
});

describe("parseInboundSms", () => {
  it("parses from/body and indexed media", async () => {
    const { parseInboundSms } = await import("@/lib/twilio");
    const r = parseInboundSms({
      From: "+15551112222", To: "+15550000000", Body: "hi",
      NumMedia: "2", MediaUrl0: "https://u/0", MediaContentType0: "image/jpeg",
      MediaUrl1: "https://u/1", MediaContentType1: "image/png",
    });
    expect(r.from).toBe("+15551112222");
    expect(r.body).toBe("hi");
    expect(r.mediaUrls).toEqual(["https://u/0", "https://u/1"]);
    expect(r.mediaContentTypes).toEqual(["image/jpeg", "image/png"]);
  });

  it("handles zero media", async () => {
    const { parseInboundSms } = await import("@/lib/twilio");
    const r = parseInboundSms({ From: "+1", To: "+2", Body: "x", NumMedia: "0" });
    expect(r.mediaUrls).toEqual([]);
  });
});

describe("validateTwilioSignature", () => {
  it("delegates to twilio.validateRequest with auth token, url, params", async () => {
    h.validateRequest.mockReturnValue(true);
    const { validateTwilioSignature } = await import("@/lib/twilio");
    const ok = validateTwilioSignature({ signature: "sig", url: "https://a/api/twilio/sms", params: { From: "+1" } });
    expect(ok).toBe(true);
    expect(h.validateRequest).toHaveBeenCalledWith("tok", "sig", "https://a/api/twilio/sms", { From: "+1" });
  });

  it("returns false when signature header is null", async () => {
    const { validateTwilioSignature } = await import("@/lib/twilio");
    expect(validateTwilioSignature({ signature: null, url: "https://a", params: {} })).toBe(false);
    expect(h.validateRequest).not.toHaveBeenCalled();
  });
});

describe("sendComicMms", () => {
  it("sends an MMS with mediaUrl array when provided", async () => {
    const { sendComicMms } = await import("@/lib/twilio");
    await sendComicMms({ to: "+15551112222", body: "done", mediaUrl: "https://s3/x.png" });
    expect(h.create).toHaveBeenCalledWith({
      to: "+15551112222", from: "+15550000000", body: "done", mediaUrl: ["https://s3/x.png"],
    });
  });

  it("sends plain SMS (no mediaUrl key) when no media", async () => {
    const { sendComicMms } = await import("@/lib/twilio");
    await sendComicMms({ to: "+15551112222", body: "text only" });
    expect(h.create).toHaveBeenCalledWith({ to: "+15551112222", from: "+15550000000", body: "text only" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/twilio.test.ts`
Expected: FAIL — `@/lib/twilio` not found.

- [ ] **Step 3: Implement `lib/twilio.ts`**

```ts
import twilio from "twilio";

function client() {
  return twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
}

export interface InboundSms {
  from: string;
  to: string;
  body: string;
  mediaUrls: string[];
  mediaContentTypes: string[];
}

export function parseInboundSms(params: Record<string, string>): InboundSms {
  const numMedia = parseInt(params.NumMedia || "0", 10) || 0;
  const mediaUrls: string[] = [];
  const mediaContentTypes: string[] = [];
  for (let i = 0; i < numMedia; i++) {
    const url = params[`MediaUrl${i}`];
    if (url) {
      mediaUrls.push(url);
      mediaContentTypes.push(params[`MediaContentType${i}`] || "application/octet-stream");
    }
  }
  return {
    from: params.From || "",
    to: params.To || "",
    body: (params.Body || "").trim(),
    mediaUrls,
    mediaContentTypes,
  };
}

export function validateTwilioSignature({
  signature,
  url,
  params,
}: {
  signature: string | null;
  url: string;
  params: Record<string, string>;
}): boolean {
  if (!signature) return false;
  return twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN!, signature, url, params);
}

export async function sendComicMms({
  to,
  body,
  mediaUrl,
}: {
  to: string;
  body: string;
  mediaUrl?: string;
}): Promise<void> {
  const params: { to: string; from: string; body: string; mediaUrl?: string[] } = {
    to,
    from: process.env.TWILIO_PHONE_NUMBER!,
    body,
  };
  if (mediaUrl) params.mediaUrl = [mediaUrl];
  await client().messages.create(params);
}

export async function sendSms({ to, body }: { to: string; body: string }): Promise<void> {
  await sendComicMms({ to, body });
}

export async function downloadTwilioMedia(
  mediaUrl: string,
): Promise<{ buffer: Buffer; contentType: string }> {
  const authHeader =
    "Basic " +
    Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
  const res = await fetch(mediaUrl, { headers: { Authorization: authHeader } });
  if (!res.ok) {
    throw new Error(`Failed to download Twilio media ${mediaUrl}: ${res.status}`);
  }
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/twilio.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/twilio.ts lib/twilio.test.ts
git commit -m "feat: add twilio client, signature validation, mms send, media download

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `lib/conversation.ts` — pure SMS state machine

**Files:**
- Create: `lib/conversation.ts`
- Test: `lib/conversation.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ConversationState = "awaiting_name" | "awaiting_prompt" | "generating" | "done";
  export interface Collected { name?: string; prompt?: string; style?: string; characterImageUrls?: string[]; }
  export interface InboundTurn { body: string; hasImage: boolean; }
  export interface Advance {
    nextState: ConversationState;
    collected: Collected;
    reply: string;                 // text to send back to the user
    action: "none" | "enqueue_generation" | "reset";
  }
  export function advanceConversation(current: { state: ConversationState; collected: Collected }, turn: InboundTurn): Advance;
  ```
  Pure function — no I/O. Consumed by the webhook (Task 7). The webhook is responsible for attaching downloaded image URLs into `collected.characterImageUrls` before/around calling this (the SM only needs `hasImage` to decide copy).

**Behavior (name → prompt → generate):**
- `awaiting_name`: if body is empty → re-prompt for name (state unchanged). Else store `name`, → `awaiting_prompt`, reply asking for the story idea.
- `awaiting_prompt`: if body is empty → re-prompt. Else store `prompt`, → `generating`, reply "Got it, {name}! Generating your comic — about a minute…", action `enqueue_generation`.
- `generating`: reply "Still working on your last comic — hang tight!" action `none` (ignore input while a job is in flight).
- `done`: any inbound → treat as a NEW comic: reset to `awaiting_name`... but to keep it snappy, if body is non-empty treat it as a fresh prompt? NO — keep it explicit: `done` + any message → reset to `awaiting_name`, reply the welcome/name prompt, action `reset`. (Simfplicity over cleverness.)
- A "restart"/"new" keyword (case-insensitive, body === "new" or "restart") in ANY state → reset to `awaiting_name` with cleared collected, action `reset`.

- [ ] **Step 1: Write the failing test**

Create `lib/conversation.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { advanceConversation } from "@/lib/conversation";

describe("advanceConversation", () => {
  it("awaiting_name with a name advances to awaiting_prompt and stores name", () => {
    const r = advanceConversation({ state: "awaiting_name", collected: {} }, { body: "Ada", hasImage: false });
    expect(r.nextState).toBe("awaiting_prompt");
    expect(r.collected.name).toBe("Ada");
    expect(r.action).toBe("none");
    expect(r.reply.length).toBeGreaterThan(0);
  });

  it("awaiting_name with empty body re-prompts, stays in awaiting_name", () => {
    const r = advanceConversation({ state: "awaiting_name", collected: {} }, { body: "", hasImage: false });
    expect(r.nextState).toBe("awaiting_name");
    expect(r.action).toBe("none");
  });

  it("awaiting_prompt with a prompt advances to generating and enqueues", () => {
    const r = advanceConversation(
      { state: "awaiting_prompt", collected: { name: "Ada" } },
      { body: "a robot detective in the rain", hasImage: false },
    );
    expect(r.nextState).toBe("generating");
    expect(r.collected.prompt).toBe("a robot detective in the rain");
    expect(r.action).toBe("enqueue_generation");
    expect(r.reply).toContain("Ada");
  });

  it("generating ignores input with a hold message", () => {
    const r = advanceConversation({ state: "generating", collected: { name: "Ada", prompt: "x" } }, { body: "hello?", hasImage: false });
    expect(r.nextState).toBe("generating");
    expect(r.action).toBe("none");
  });

  it("done + any message resets to awaiting_name", () => {
    const r = advanceConversation({ state: "done", collected: { name: "Ada" } }, { body: "hi again", hasImage: false });
    expect(r.nextState).toBe("awaiting_name");
    expect(r.action).toBe("reset");
    expect(r.collected).toEqual({});
  });

  it("'restart' keyword resets from any state", () => {
    const r = advanceConversation({ state: "awaiting_prompt", collected: { name: "Ada" } }, { body: "restart", hasImage: false });
    expect(r.nextState).toBe("awaiting_name");
    expect(r.action).toBe("reset");
    expect(r.collected).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/conversation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/conversation.ts`**

```ts
export type ConversationState = "awaiting_name" | "awaiting_prompt" | "generating" | "done";

export interface Collected {
  name?: string;
  prompt?: string;
  style?: string;
  characterImageUrls?: string[];
}

export interface InboundTurn {
  body: string;
  hasImage: boolean;
}

export interface Advance {
  nextState: ConversationState;
  collected: Collected;
  reply: string;
  action: "none" | "enqueue_generation" | "reset";
}

const RESET_KEYWORDS = new Set(["new", "restart", "reset"]);
const WELCOME = "Welcome to MakeComics! What's your name?";

export function advanceConversation(
  current: { state: ConversationState; collected: Collected },
  turn: InboundTurn,
): Advance {
  const body = (turn.body || "").trim();

  // Global reset keyword
  if (RESET_KEYWORDS.has(body.toLowerCase())) {
    return { nextState: "awaiting_name", collected: {}, reply: WELCOME, action: "reset" };
  }

  switch (current.state) {
    case "awaiting_name": {
      if (!body) {
        return { nextState: "awaiting_name", collected: current.collected, reply: WELCOME, action: "none" };
      }
      const collected = { ...current.collected, name: body };
      return {
        nextState: "awaiting_prompt",
        collected,
        reply: `Nice to meet you, ${body}! Describe the comic you want — a scene, characters, a vibe. (You can also attach a photo to star in it.)`,
        action: "none",
      };
    }
    case "awaiting_prompt": {
      if (!body) {
        return {
          nextState: "awaiting_prompt",
          collected: current.collected,
          reply: "Tell me what the comic should be about — the more detail, the better!",
          action: "none",
        };
      }
      const collected = { ...current.collected, prompt: body };
      const name = collected.name ? `, ${collected.name}` : "";
      return {
        nextState: "generating",
        collected,
        reply: `Got it${name}! Generating your comic now — this takes about a minute. I'll text it to you when it's ready. ✏️`,
        action: "enqueue_generation",
      };
    }
    case "generating": {
      return {
        nextState: "generating",
        collected: current.collected,
        reply: "Still drawing your last comic — hang tight, it'll arrive shortly! (Text 'new' to start over.)",
        action: "none",
      };
    }
    case "done":
    default: {
      return { nextState: "awaiting_name", collected: {}, reply: WELCOME, action: "reset" };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/conversation.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/conversation.ts lib/conversation.test.ts
git commit -m "feat: add pure SMS conversation state machine

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `lib/qstash.ts` — publish + verify

**Files:**
- Create: `lib/qstash.ts`
- Test: `lib/qstash.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface GenerationJob { phoneNumber: string; prompt: string; style?: string; characterImageUrls?: string[]; }
  export function publishGenerationJob(job: GenerationJob): Promise<void>;
  // Re-export the App Router verify wrapper for the worker route:
  export { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
  ```
  Consumed by the webhook (Task 7, publish) and worker (Task 8, verify).

**Design:** `publishGenerationJob` builds the worker URL from `PUBLIC_BASE_URL` (`${PUBLIC_BASE_URL}/api/twilio/generate-worker`), sets `deduplicationId` to `${phoneNumber}-${prompt-hash}` so an accidental double-enqueue is dropped, and publishes JSON.

- [ ] **Step 1: Write the failing test**

Create `lib/qstash.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ publishJSON: vi.fn() }));
vi.mock("@upstash/qstash", () => ({
  Client: vi.fn(() => ({ publishJSON: h.publishJSON })),
}));
vi.mock("@upstash/qstash/nextjs", () => ({ verifySignatureAppRouter: (fn: any) => fn }));

beforeEach(() => {
  process.env.QSTASH_TOKEN = "qtok";
  process.env.PUBLIC_BASE_URL = "https://app.example.com";
  h.publishJSON.mockReset();
  h.publishJSON.mockResolvedValue({ messageId: "m1" });
});

describe("publishGenerationJob", () => {
  it("publishes to the worker URL with the job body and a dedup id", async () => {
    const { publishGenerationJob } = await import("@/lib/qstash");
    await publishGenerationJob({ phoneNumber: "+15551112222", prompt: "hero", style: "noir" });
    expect(h.publishJSON).toHaveBeenCalledOnce();
    const arg = h.publishJSON.mock.calls[0][0];
    expect(arg.url).toBe("https://app.example.com/api/twilio/generate-worker");
    expect(arg.body).toMatchObject({ phoneNumber: "+15551112222", prompt: "hero", style: "noir" });
    expect(typeof arg.deduplicationId).toBe("string");
    expect(arg.deduplicationId.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/qstash.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/qstash.ts`**

```ts
import { Client } from "@upstash/qstash";
import { createHash } from "node:crypto";

export { verifySignatureAppRouter } from "@upstash/qstash/nextjs";

export interface GenerationJob {
  phoneNumber: string;
  prompt: string;
  style?: string;
  characterImageUrls?: string[];
}

export async function publishGenerationJob(job: GenerationJob): Promise<void> {
  const client = new Client({ token: process.env.QSTASH_TOKEN! });
  const url = `${process.env.PUBLIC_BASE_URL}/api/twilio/generate-worker`;
  const hash = createHash("sha256")
    .update(`${job.phoneNumber}:${job.prompt}`)
    .digest("hex")
    .slice(0, 16);
  await client.publishJSON({
    url,
    body: job,
    deduplicationId: `${job.phoneNumber}-${hash}`,
    retries: 2,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/qstash.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add lib/qstash.ts lib/qstash.test.ts
git commit -m "feat: add qstash publish + verify wrapper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `lib/db-actions.ts` — conversation CRUD

**Files:**
- Modify: `lib/db-actions.ts`
- Test: `lib/db-actions.conversation.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function getOrCreateConversation(phoneNumber: string, channel?: string): Promise<Conversation>;
  export function updateConversation(phoneNumber: string, data: { state?: string; collected?: Collected; activeStoryId?: string | null }): Promise<void>;
  export function resetConversation(phoneNumber: string): Promise<void>;
  ```
  Consumed by the webhook (Task 8) and worker (Task 9).

**Design:** `getOrCreateConversation` does an upsert-on-read: select by `phoneNumber`; if none, insert a default row (`state: 'awaiting_name'`, `collected: {}`). `updateConversation` sets provided fields + `updatedAt: new Date()`. `resetConversation` sets `state='awaiting_name'`, `collected={}`, `activeStoryId=null`.

- [ ] **Step 1: Write the failing test**

Create `lib/db-actions.conversation.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  select: vi.fn(), insert: vi.fn(), update: vi.fn(),
}));

// Chainable drizzle query-builder stub
function chain(result: any) {
  const c: any = {};
  for (const m of ["from", "where", "limit", "set", "values", "returning"]) c[m] = vi.fn(() => c);
  c.then = (res: any) => Promise.resolve(result).then(res); // awaitable
  return c;
}

vi.mock("@/lib/db", () => ({
  db: {
    select: (...a: any[]) => h.select(...a),
    insert: (...a: any[]) => h.insert(...a),
    update: (...a: any[]) => h.update(...a),
  },
}));

import { getOrCreateConversation } from "@/lib/db-actions";

beforeEach(() => {
  h.select.mockReset(); h.insert.mockReset(); h.update.mockReset();
});

describe("getOrCreateConversation", () => {
  it("returns the existing conversation when found", async () => {
    const existing = { id: "c1", phoneNumber: "+1", state: "awaiting_prompt", collected: { name: "Ada" } };
    h.select.mockReturnValue(chain([existing]));
    const r = await getOrCreateConversation("+1");
    expect(r).toEqual(existing);
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("inserts a default conversation when none exists", async () => {
    const created = { id: "c2", phoneNumber: "+2", state: "awaiting_name", collected: {} };
    h.select.mockReturnValue(chain([]));       // none found
    h.insert.mockReturnValue(chain([created])); // returning() -> [created]
    const r = await getOrCreateConversation("+2");
    expect(r).toEqual(created);
    expect(h.insert).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/db-actions.conversation.test.ts`
Expected: FAIL — `getOrCreateConversation` not exported.

- [ ] **Step 3: Implement the CRUD in `lib/db-actions.ts`**

Add `conversations` and the `Conversation` type to the existing import from `./schema`, then add:
```ts
export async function getOrCreateConversation(phoneNumber: string, channel: string = "sms"): Promise<Conversation> {
  const existing = await db.select().from(conversations).where(eq(conversations.phoneNumber, phoneNumber)).limit(1);
  if (existing.length > 0) return existing[0];
  const [created] = await db
    .insert(conversations)
    .values({ phoneNumber, channel, state: "awaiting_name", collected: {} })
    .returning();
  return created;
}

export async function updateConversation(
  phoneNumber: string,
  data: { state?: string; collected?: Record<string, unknown>; activeStoryId?: string | null },
): Promise<void> {
  await db
    .update(conversations)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(conversations.phoneNumber, phoneNumber));
}

export async function resetConversation(phoneNumber: string): Promise<void> {
  await db
    .update(conversations)
    .set({ state: "awaiting_name", collected: {}, activeStoryId: null, updatedAt: new Date() })
    .where(eq(conversations.phoneNumber, phoneNumber));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/db-actions.conversation.test.ts`
Expected: PASS (2 tests). If the chain stub doesn't await correctly, ensure the mocked builder is thenable (the `then` in `chain`).

- [ ] **Step 5: Commit**

```bash
git add lib/db-actions.ts lib/db-actions.conversation.test.ts
git commit -m "feat: add conversation CRUD (get-or-create, update, reset)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `app/api/twilio/sms/route.ts` — inbound webhook

**Files:**
- Create: `app/api/twilio/sms/route.ts`

**Interfaces:**
- Consumes: `validateTwilioSignature`, `parseInboundSms`, `downloadTwilioMedia` (Task 4); `advanceConversation` (Task 5); `publishGenerationJob` (Task 6); `getOrCreateConversation`, `updateConversation` (Task 7); `uploadBufferToS3` (Phase A).
- Produces: an HTTP `POST` returning TwiML (`text/xml`). No new exports consumed elsewhere.

**Flow:**
1. Read the RAW body with `await request.text()`, parse it as `URLSearchParams` into a `Record<string,string>` (Twilio sends `application/x-www-form-urlencoded`).
2. Build the exact public URL: `${process.env.PUBLIC_BASE_URL}/api/twilio/sms`. Validate `X-Twilio-Signature` against it + params; on failure return `403`.
3. `parseInboundSms(params)` → `{ from, body, mediaUrls, mediaContentTypes }`.
4. `getOrCreateConversation(from)`.
5. If media present: download each image via `downloadTwilioMedia`, re-upload to S3 (`uploadBufferToS3(buffer, `chars/${from}/${Date.now()}-${i}.png`, contentType)`), collect URLs.
6. Call `advanceConversation({ state, collected }, { body, hasImage: mediaUrls.length>0 })`. Merge any new character image URLs into `collected.characterImageUrls`.
7. Persist: `updateConversation(from, { state: nextState, collected })`.
8. If `action === "enqueue_generation"`: `publishGenerationJob({ phoneNumber: from, prompt: collected.prompt!, style: collected.style || "noir", characterImageUrls: collected.characterImageUrls })`.
9. Respond with TwiML `<Response><Message>${reply}</Message></Response>`, `Content-Type: text/xml`.
10. Route segment: `export const runtime = "nodejs";` (needs Node Buffer + twilio SDK).

- [ ] **Step 1: Create the route**

```ts
import { type NextRequest } from "next/server";
import {
  validateTwilioSignature,
  parseInboundSms,
  downloadTwilioMedia,
} from "@/lib/twilio";
import { advanceConversation, type Collected, type ConversationState } from "@/lib/conversation";
import { publishGenerationJob } from "@/lib/qstash";
import { getOrCreateConversation, updateConversation } from "@/lib/db-actions";
import { uploadBufferToS3 } from "@/lib/s3-upload";

export const runtime = "nodejs";

function twiml(message: string): Response {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`;
  return new Response(xml, { headers: { "Content-Type": "text/xml" } });
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const params: Record<string, string> = {};
  new URLSearchParams(rawBody).forEach((v, k) => {
    params[k] = v;
  });

  const url = `${process.env.PUBLIC_BASE_URL}/api/twilio/sms`;
  const signature = request.headers.get("x-twilio-signature");
  if (!validateTwilioSignature({ signature, url, params })) {
    return new Response("Invalid signature", { status: 403 });
  }

  const inbound = parseInboundSms(params);
  if (!inbound.from) {
    return twiml("Sorry, something went wrong. Please try again.");
  }

  try {
    const convo = await getOrCreateConversation(inbound.from);
    const collected = (convo.collected || {}) as Collected;

    // Download + persist any attached images as character references
    let newImageUrls: string[] = [];
    for (let i = 0; i < inbound.mediaUrls.length; i++) {
      const ct = inbound.mediaContentTypes[i] || "";
      if (!ct.startsWith("image/")) continue;
      try {
        const { buffer, contentType } = await downloadTwilioMedia(inbound.mediaUrls[i]);
        const ext = contentType.includes("png") ? "png" : "jpg";
        const s3Url = await uploadBufferToS3(
          buffer,
          `chars/${inbound.from.replace(/[^0-9]/g, "")}/${Date.now()}-${i}.${ext}`,
          contentType,
        );
        newImageUrls.push(s3Url);
      } catch (mediaErr) {
        console.error("Failed to ingest inbound media:", mediaErr);
      }
    }

    const advance = advanceConversation(
      { state: convo.state as ConversationState, collected },
      { body: inbound.body, hasImage: newImageUrls.length > 0 },
    );

    // Merge new character images into collected (cap 2, matching web UI)
    const mergedCollected: Collected = { ...advance.collected };
    if (newImageUrls.length > 0) {
      mergedCollected.characterImageUrls = [
        ...(advance.collected.characterImageUrls || []),
        ...newImageUrls,
      ].slice(0, 2);
    }

    await updateConversation(inbound.from, {
      state: advance.nextState,
      collected: mergedCollected,
    });

    if (advance.action === "enqueue_generation" && mergedCollected.prompt) {
      await publishGenerationJob({
        phoneNumber: inbound.from,
        prompt: mergedCollected.prompt,
        style: mergedCollected.style || "noir",
        characterImageUrls: mergedCollected.characterImageUrls,
      });
    }

    return twiml(advance.reply);
  } catch (err) {
    console.error("Error in Twilio SMS webhook:", err);
    return twiml("Sorry, something went wrong on our end. Text 'new' to start over.");
  }
}
```

- [ ] **Step 2: Verify build compiles**

Run: `pnpm build 2>&1 | grep -iE "Compiled|Failed to compile|twilio/sms"`
Expected: "Compiled successfully" (page-data collection may still fail on missing DATABASE_URL — pre-existing/unrelated).

- [ ] **Step 3: Commit**

```bash
git add app/api/twilio/sms/route.ts
git commit -m "feat: inbound Twilio SMS webhook with conversation state machine

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: `app/api/twilio/generate-worker/route.ts` — QStash worker → MMS

**Files:**
- Create: `app/api/twilio/generate-worker/route.ts`

**Interfaces:**
- Consumes: `verifySignatureAppRouter` (Task 6); `createComicStory`, `ComicServiceError` (Task 3); `sendComicMms` (Task 4); `updateConversation`, `resetConversation` (Task 7).
- Produces: `POST` handler wrapped in QStash verification; `export const maxDuration = 60`.

**Flow:**
1. Wrapped by `verifySignatureAppRouter` (verifies `Upstash-Signature`; returns 403 on failure).
2. Parse the job body `{ phoneNumber, prompt, style, characterImageUrls }`.
3. `createComicStory({ userId: phoneNumber, prompt, style, characterImageUrls, source: "sms", generateTitle: true })`.
4. On success: build a link `${PUBLIC_BASE_URL}/story/${slug}`; `sendComicMms({ to: phoneNumber, body: "Your comic '<title>' is ready! View & add pages: <link>", mediaUrl: imageUrl })`; set conversation `state='done'`, `activeStoryId=story.id`.
5. On `ComicServiceError`: send a friendly SMS per `type` (content_policy / credit_limit / api_error); `resetConversation(phoneNumber)`.
6. Always return `200` to QStash after handling (so it doesn't retry a user-facing failure we've already messaged). Only return non-2xx for unexpected/transient errors where a retry is desirable.

- [ ] **Step 1: Create the route**

```ts
import { verifySignatureAppRouter } from "@/lib/qstash";
import { createComicStory, ComicServiceError } from "@/lib/comic-service";
import { sendComicMms } from "@/lib/twilio";
import { updateConversation, resetConversation } from "@/lib/db-actions";

export const runtime = "nodejs";
export const maxDuration = 60;

async function handler(request: Request) {
  const job = (await request.json()) as {
    phoneNumber: string;
    prompt: string;
    style?: string;
    characterImageUrls?: string[];
  };

  if (!job?.phoneNumber || !job?.prompt) {
    return Response.json({ error: "Invalid job payload" }, { status: 400 });
  }

  try {
    const result = await createComicStory({
      userId: job.phoneNumber,
      prompt: job.prompt,
      style: job.style || "noir",
      characterImageUrls: job.characterImageUrls || [],
      source: "sms",
      generateTitle: true,
    });

    const link = `${process.env.PUBLIC_BASE_URL}/story/${result.story.slug}`;
    await sendComicMms({
      to: job.phoneNumber,
      body: `Your comic "${result.story.title}" is ready! View it and add more pages: ${link}`,
      mediaUrl: result.imageUrl,
    });

    await updateConversation(job.phoneNumber, { state: "done", activeStoryId: result.story.id });
    return Response.json({ ok: true });
  } catch (error) {
    let message = "Sorry, we couldn't create your comic this time. Text 'new' to try again.";
    if (error instanceof ComicServiceError) {
      if (error.type === "content_policy") {
        message = "That prompt tripped our content filter. Text 'new' and try a different idea!";
      } else if (error.type === "credit_limit") {
        message = "Our comic studio is over capacity right now. Please try again a bit later!";
      }
    } else {
      console.error("Unexpected worker error:", error);
    }

    try {
      await sendComicMms({ to: job.phoneNumber, body: message });
    } catch (smsErr) {
      console.error("Failed to send failure SMS:", smsErr);
    }
    await resetConversation(job.phoneNumber);
    // Return 200: we've already notified the user; no value in a QStash retry.
    return Response.json({ ok: false, handled: true });
  }
}

export const POST = verifySignatureAppRouter(handler);
```

- [ ] **Step 2: Verify build compiles**

Run: `pnpm build 2>&1 | grep -iE "Compiled|Failed to compile|generate-worker"`
Expected: "Compiled successfully".

- [ ] **Step 3: Commit**

```bash
git add app/api/twilio/generate-worker/route.ts
git commit -m "feat: QStash worker generates comic and delivers via MMS

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Env vars + documentation

**Files:**
- Modify: `.example.env`
- Modify: `README.md`

**Interfaces:** none (docs/config only).

- [ ] **Step 1: Add env vars to `.example.env`**

Append to `.example.env`:
```
# Twilio (SMS/MMS channel)
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=

# Upstash QStash (background comic generation jobs)
QSTASH_TOKEN=
QSTASH_CURRENT_SIGNING_KEY=
QSTASH_NEXT_SIGNING_KEY=

# Public origin (for Twilio signature validation + outbound story links)
PUBLIC_BASE_URL=
```

- [ ] **Step 2: Document the SMS channel + setup in README**

Add a "Create comics by text (SMS/MMS)" section to `README.md` describing:
- Text the Twilio number your name, then a comic idea (optionally attach a photo); you get the comic back as an MMS + a link.
- Setup checklist:
  1. Create a Twilio account; get Account SID + Auth Token.
  2. Buy a phone number with SMS + Voice + MMS.
  3. **A2P 10DLC registration (Brand + Campaign) — required for US SMS; ~10–15 day carrier review. Start early.**
  4. Set the number's Messaging webhook to `<PUBLIC_BASE_URL>/api/twilio/sms` (HTTP POST).
  5. Enable Upstash QStash; copy `QSTASH_TOKEN` + signing keys.
  6. Set all env vars above; run `pnpm drizzle-kit push` to apply the `conversations`/`source` migration to your Neon DB.
- Note the async design: the webhook acks instantly and the finished comic is delivered by an outbound MMS ~1 minute later.

- [ ] **Step 3: Verify + commit**

Run: `pnpm build 2>&1 | grep -iE "Compiled|Failed to compile"` (no code change, should still compile).
```bash
git add .example.env README.md
git commit -m "docs: document Twilio SMS channel setup and env vars

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: End-to-end verification (automated portion)

**Files:** none (verification only).

- [ ] **Step 1: Full test suite**

Run: `pnpm test`
Expected: all pass — Phase A (9) + comic-service (4) + twilio (6) + conversation (6) + qstash (1) + db-actions conversation (2) = **28** tests.

- [ ] **Step 2: Build compiles**

Run: `pnpm build 2>&1 | grep -iE "Compiled successfully|Failed to compile"`
Expected: "Compiled successfully" (page-data collection failing on missing DATABASE_URL is pre-existing/env, not a code failure).

- [ ] **Step 3: Route inventory check**

Run:
```bash
ls app/api/twilio/sms/route.ts app/api/twilio/generate-worker/route.ts
grep -rn "verifySignatureAppRouter\|validateTwilioSignature" app/api/twilio
```
Expected: both routes exist; signature validation present in each (worker via the wrapper, sms via `validateTwilioSignature`).

- [ ] **Step 4: Record manual/user steps (cannot be automated here)**

Document in the final report that these require the user:
- Real Twilio + QStash credentials in `.env`; `OPENAI_API_KEY` (from Phase A).
- `pnpm drizzle-kit push` against the live Neon DB (applies the migration).
- A2P 10DLC approval before US SMS delivers.
- Configure the Twilio number's Messaging webhook → `<PUBLIC_BASE_URL>/api/twilio/sms`.
- A public URL (deploy, or `ngrok`/tunnel for local) so Twilio + QStash can reach the app.
- Live smoke test: text the number → name → prompt → receive MMS.

---

## Self-Review

**Spec coverage (Phase B slice of the design §4.4–4.5, §5):**
- `stories.source` + `conversations` table → Task 2. ✔
- Channel-agnostic `comic-service.ts` (spec D1) → Task 3. ✔
- Twilio client / signature / MMS send / media download → Task 4. ✔
- Conversation state machine (name→prompt→generate, photo optional, default noir) → Task 5. ✔
- QStash publish + verify (async ack-then-push, beats 15s timeout) → Tasks 6, 8, 9. ✔
- Inbound webhook with signature validation + instant ack → Task 8. ✔
- Worker: generate + outbound MMS + web link (spec D4) → Task 9. ✔
- Phone number as identity (spec D5) → Tasks 3, 8, 9 (userId = From). ✔
- Env/docs incl. A2P 10DLC callout → Task 10. ✔

**Deferred (Phase C — separate plan):** Voice/ConversationRelay + standalone WS service. The `conversations` table already carries a `channel` column and `voice` state values are compatible, so Phase C reuses this schema.

**Placeholder scan:** none — every code step has complete code.

**Type consistency:** `createComicStory` args/result identical in Tasks 3, 9. `advanceConversation` shape identical in Tasks 5, 8. `GenerationJob` shape identical in Tasks 6, 8, 9. `Collected` type shared (conversation.ts) and used in webhook. `parseInboundSms`/`validateTwilioSignature`/`sendComicMms`/`downloadTwilioMedia` signatures identical in Tasks 4, 8, 9.

**Known risk flagged for implementers:** the `db-actions.conversation.test.ts` chainable-drizzle mock is delicate; if it proves flaky, the implementer may switch to asserting against a thin repository seam rather than the query builder — noted in Task 7 Step 4.
