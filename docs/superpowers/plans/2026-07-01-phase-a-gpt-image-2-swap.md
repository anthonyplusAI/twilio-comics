# Phase A: GPT Image 2 Swap — Implementation Plan

> **Superseded:** This is a historical implementation plan. Current architecture and setup are documented in the root README and `docs/INFRA_SETUP.md`; provider, storage, authentication, job, and deployment details below are not current instructions.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the previous image provider with OpenAI `gpt-image-2` across the web comic-creation flow, preserving consistent-character-face behavior via reference images.

**Architecture:** Extract a single channel-agnostic image module (`lib/image-generation.ts`) that branches between OpenAI's text-only `images.generate()` (no references) and `images.edit()` (with 1–3 reference images). It returns raw image bytes; a new `uploadBufferToS3` persists them. The two web API routes (`generate-comic`, `add-page`) and the API-key validator are re-pointed to OpenAI with no change to their external contracts.

**Tech Stack:** Next.js 16 (App Router), TypeScript, `openai` npm SDK, AWS S3 (`@aws-sdk/client-s3`), Drizzle/Neon (unchanged this phase), Vitest (new, for unit tests).

## Global Constraints

- Image model id: **`gpt-image-2`** (verbatim).
- Portrait output size: **`1024x1536`** (named size, exact 2:3). `gpt-image-2` also supports arbitrary dims ÷16 within aspect 1:3–3:1, but this plan uses the named size.
- `gpt-image-2` returns **`b64_json` only** — never a URL. Do NOT set `response_format`.
- Reference images ⇒ **`images.edit()`** endpoint only; no references ⇒ **`images.generate()`**. Max 16 inputs (we send ≤3).
- No `temperature` param on OpenAI image endpoints (remove it).
- Use `@/*` path alias for imports.
- React Server Components by default; these are API routes / server libs — no `"use client"`.
- Preserve existing API route response shapes and `errorType` values (`content_policy`, `credit_limit`, `api_error`) so the frontend is untouched.
- Env: server key `OPENAI_API_KEY`; users may still bring their own key (BYO) via the `apiKey` field.
- Per AGENTS.md: never run `pnpm dev` (assume running); use `pnpm build` / `pnpm lint` to gate. Run `pnpm drizzle-kit push` after schema changes (none in Phase A).
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `package.json` | Add `openai`, `vitest`; add `test` script | Modify |
| `vitest.config.ts` | Vitest config with `@/*` alias | Create |
| `lib/image-generation.ts` | OpenAI wrapper: generate-vs-edit branch, base64→Buffer, error mapping. Sole owner of image-model knowledge. | Create |
| `lib/image-generation.test.ts` | Unit tests (mocked OpenAI) for the branch + decode + error mapping | Create |
| `lib/s3-upload.ts` | Add `uploadBufferToS3(buffer, key, contentType)`; keep `uploadImageToS3` | Modify |
| `lib/utils.ts` | Extend `isContentPolicyViolation` with OpenAI moderation strings | Modify |
| `app/api/generate-comic/route.ts` | Call `generateComicImage`; upload buffer | Modify |
| `app/api/add-page/route.ts` | Same swap for continuation/redraw | Modify |
| `app/api/validate-api-key/route.ts` | Validate an OpenAI key | Modify |
| `.example.env`, `README.md` | Add `OPENAI_API_KEY`; document model swap | Modify |

**Scope note (deliberate, from spec D1):** The spec proposes a `lib/comic-service.ts` orchestration extraction shared by web/SMS/voice. Phase A has only the *web* caller, so it extracts just the risky/duplicated part — the image call — into `lib/image-generation.ts`. The full orchestration extraction is deferred to **Phase B (SMS)**, when a genuine second caller exists. This is a conscious YAGNI decision, not a dropped requirement.

---

## Task 1: Add OpenAI SDK and Vitest tooling

**Files:**
- Modify: `package.json` (dependencies + `test` script)
- Create: `vitest.config.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `openai` package available for import; `pnpm test` runs Vitest with `@/*` resolving to repo root.

- [ ] **Step 1: Install dependencies**

Run:
```bash
pnpm add openai && pnpm add -D vitest
```
Expected: `openai` in `dependencies`, `vitest` in `devDependencies`; lockfile updated.

- [ ] **Step 2: Add the `test` script to package.json**

In `package.json` `"scripts"`, add:
```json
"test": "vitest run"
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": resolve(__dirname, ".") },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "app/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Verify Vitest runs (no tests yet is OK)**

Run: `pnpm test`
Expected: Vitest starts and exits cleanly reporting "No test files found" (exit code 0) — or passes once Task 2 adds a test. If it errors on config, fix the alias path.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts
git commit -m "chore: add openai sdk and vitest tooling

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Create `lib/image-generation.ts` (OpenAI wrapper)

**Files:**
- Create: `lib/image-generation.ts`
- Test: `lib/image-generation.test.ts`

**Interfaces:**
- Consumes: `openai` SDK; `fetch` (global) to download reference images.
- Produces:
  ```ts
  export const IMAGE_SIZE = "1024x1536";
  export interface GenerateComicImageArgs {
    apiKey: string;
    prompt: string;
    referenceImageUrls?: string[]; // S3 URLs; [] or undefined => text-only generate
  }
  // Returns raw PNG bytes decoded from OpenAI's b64_json.
  export function generateComicImage(args: GenerateComicImageArgs): Promise<Buffer>;
  ```
  Consumed by `generate-comic` and `add-page` routes (Tasks 4–5).

- [ ] **Step 1: Write the failing test**

Create `lib/image-generation.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const generateMock = vi.fn();
const editMock = vi.fn();
const toFileMock = vi.fn(async (buf: Buffer, name: string, opts: any) => ({ name, opts }));

vi.mock("openai", () => {
  const OpenAI = vi.fn(() => ({
    images: { generate: generateMock, edit: editMock },
  }));
  // @ts-expect-error attach static toFile like the real SDK
  OpenAI.toFile = toFileMock;
  return { default: OpenAI };
});

import { generateComicImage, IMAGE_SIZE } from "@/lib/image-generation";

const B64 = Buffer.from("fake-png-bytes").toString("base64");

beforeEach(() => {
  generateMock.mockReset();
  editMock.mockReset();
  generateMock.mockResolvedValue({ data: [{ b64_json: B64 }] });
  editMock.mockResolvedValue({ data: [{ b64_json: B64 }] });
  // Stub fetch for reference-image downloads
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => new TextEncoder().encode("ref").buffer,
    headers: { get: () => "image/png" },
  })));
});

describe("generateComicImage", () => {
  it("uses images.generate (text-only) when there are no reference images", async () => {
    const out = await generateComicImage({ apiKey: "k", prompt: "hero", referenceImageUrls: [] });
    expect(generateMock).toHaveBeenCalledOnce();
    expect(editMock).not.toHaveBeenCalled();
    const arg = generateMock.mock.calls[0][0];
    expect(arg.model).toBe("gpt-image-2");
    expect(arg.size).toBe(IMAGE_SIZE);
    expect(arg).not.toHaveProperty("temperature");
    expect(out).toBeInstanceOf(Buffer);
    expect(out.toString()).toBe("fake-png-bytes");
  });

  it("uses images.edit with input images when reference images are provided", async () => {
    await generateComicImage({ apiKey: "k", prompt: "hero", referenceImageUrls: ["https://s3/a.png", "https://s3/b.png"] });
    expect(editMock).toHaveBeenCalledOnce();
    expect(generateMock).not.toHaveBeenCalled();
    const arg = editMock.mock.calls[0][0];
    expect(arg.model).toBe("gpt-image-2");
    expect(Array.isArray(arg.image)).toBe(true);
    expect(arg.image).toHaveLength(2);
    expect(arg.input_fidelity).toBe("high");
  });

  it("caps reference images at 16", async () => {
    const urls = Array.from({ length: 20 }, (_, i) => `https://s3/${i}.png`);
    await generateComicImage({ apiKey: "k", prompt: "x", referenceImageUrls: urls });
    expect(editMock.mock.calls[0][0].image).toHaveLength(16);
  });

  it("throws when OpenAI returns no image data", async () => {
    generateMock.mockResolvedValue({ data: [] });
    await expect(generateComicImage({ apiKey: "k", prompt: "x" })).rejects.toThrow(/no image/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/image-generation.test.ts`
Expected: FAIL — cannot resolve `@/lib/image-generation` (module not created yet).

- [ ] **Step 3: Write the implementation**

Create `lib/image-generation.ts`:
```ts
import OpenAI, { toFile } from "openai";

export const IMAGE_MODEL = "gpt-image-2";
export const IMAGE_SIZE = "1024x1536"; // portrait 2:3 comic page
export const MAX_REFERENCE_IMAGES = 16;

export interface GenerateComicImageArgs {
  apiKey: string;
  prompt: string;
  referenceImageUrls?: string[];
}

async function urlToFile(url: string, index: number) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch reference image ${url}: ${res.status}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "image/png";
  const ext = contentType.includes("jpeg") || contentType.includes("jpg") ? "jpg" : "png";
  return toFile(buffer, `ref-${index}.${ext}`, { type: contentType });
}

export async function generateComicImage({
  apiKey,
  prompt,
  referenceImageUrls = [],
}: GenerateComicImageArgs): Promise<Buffer> {
  const client = new OpenAI({ apiKey });
  const refs = referenceImageUrls.slice(0, MAX_REFERENCE_IMAGES);

  let response;
  if (refs.length === 0) {
    response = await client.images.generate({
      model: IMAGE_MODEL,
      prompt,
      size: IMAGE_SIZE,
      quality: "high",
    });
  } else {
    const images = await Promise.all(refs.map((url, i) => urlToFile(url, i)));
    response = await client.images.edit({
      model: IMAGE_MODEL,
      image: images,
      prompt,
      size: IMAGE_SIZE,
      quality: "high",
      input_fidelity: "high",
    });
  }

  const b64 = response.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("OpenAI returned no image data");
  }
  return Buffer.from(b64, "base64");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/image-generation.test.ts`
Expected: PASS (4 tests). If `toFile` import fails under the mock, confirm the mock attaches `toFile` as a named export too — adjust the `vi.mock` to `return { default: OpenAI, toFile: toFileMock }`.

- [ ] **Step 5: Commit**

```bash
git add lib/image-generation.ts lib/image-generation.test.ts
git commit -m "feat: add gpt-image-2 wrapper with generate/edit branch

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Add `uploadBufferToS3` to `lib/s3-upload.ts`

**Files:**
- Modify: `lib/s3-upload.ts`
- Test: `lib/s3-upload.test.ts` (create)

**Interfaces:**
- Consumes: `@aws-sdk/client-s3` (already a dependency).
- Produces:
  ```ts
  export function uploadBufferToS3(buffer: Buffer, key: string, contentType?: string): Promise<string>;
  ```
  Returns the public S3 URL (same URL shape as existing `uploadImageToS3`). Consumed by Tasks 4–5. `uploadImageToS3` is kept unchanged.

- [ ] **Step 1: Write the failing test**

Create `lib/s3-upload.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMock = vi.fn();
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn(() => ({ send: sendMock })),
  PutObjectCommand: vi.fn((input) => ({ input })),
}));

beforeEach(() => {
  process.env.S3_UPLOAD_KEY = "k";
  process.env.S3_UPLOAD_SECRET = "s";
  process.env.S3_UPLOAD_BUCKET = "my-bucket";
  process.env.S3_UPLOAD_REGION = "us-east-1";
  sendMock.mockReset();
  sendMock.mockResolvedValue({});
});

describe("uploadBufferToS3", () => {
  it("puts the buffer and returns the public comics URL", async () => {
    const { uploadBufferToS3 } = await import("@/lib/s3-upload");
    const url = await uploadBufferToS3(Buffer.from("png"), "abc/page-1.png", "image/png");
    expect(sendMock).toHaveBeenCalledOnce();
    expect(url).toBe("https://my-bucket.s3.us-east-1.amazonaws.com/comics/abc/page-1.png");
  });

  it("defaults content type to image/png", async () => {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const { uploadBufferToS3 } = await import("@/lib/s3-upload");
    await uploadBufferToS3(Buffer.from("x"), "k.png");
    const call = (PutObjectCommand as any).mock.calls.at(-1)[0];
    expect(call.ContentType).toBe("image/png");
    expect(call.Key).toBe("comics/k.png");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/s3-upload.test.ts`
Expected: FAIL — `uploadBufferToS3` is not exported.

- [ ] **Step 3: Implement `uploadBufferToS3`**

In `lib/s3-upload.ts`, add this export (reuse the existing module-level `s3Client`). Place it directly after the existing `uploadImageToS3` function:
```ts
export async function uploadBufferToS3(
  buffer: Buffer,
  key: string,
  contentType: string = "image/png",
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: process.env.S3_UPLOAD_BUCKET!,
    Key: `comics/${key}`,
    Body: buffer,
    ContentType: contentType,
    Metadata: { "app-name": "make-comics", type: "comic-page" },
  });
  await s3Client.send(command);
  return `https://${process.env.S3_UPLOAD_BUCKET}.s3.${process.env.S3_UPLOAD_REGION}.amazonaws.com/comics/${key}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/s3-upload.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/s3-upload.ts lib/s3-upload.test.ts
git commit -m "feat: add uploadBufferToS3 for raw image bytes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Extend content-policy detection for OpenAI

**Files:**
- Modify: `lib/utils.ts`
- Test: `lib/utils.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `isContentPolicyViolation(msg)` also returns `true` for OpenAI moderation phrasing. Signature unchanged; consumed by routes (Tasks 5–6).

- [ ] **Step 1: Write the failing test**

Create `lib/utils.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { isContentPolicyViolation } from "@/lib/utils";

describe("isContentPolicyViolation", () => {
  it("matches legacy provider phrasing", () => {
    expect(isContentPolicyViolation("Invalid content detected")).toBe(true);
    expect(isContentPolicyViolation("NO_IMAGE")).toBe(true);
  });

  it("matches OpenAI moderation phrasing", () => {
    expect(isContentPolicyViolation("Your request was rejected as a result of our safety system")).toBe(true);
    expect(isContentPolicyViolation("This request may violate our content policy")).toBe(true);
    expect(isContentPolicyViolation("moderation_blocked")).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isContentPolicyViolation("connection timeout")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/utils.test.ts`
Expected: FAIL — the OpenAI phrasing assertions fail (strings not yet matched).

- [ ] **Step 3: Extend `isContentPolicyViolation`**

In `lib/utils.ts`, replace the `isContentPolicyViolation` body with:
```ts
export function isContentPolicyViolation(errorMessage: string): boolean {
  return (
    errorMessage.includes("content policy") ||
    errorMessage.includes("Invalid content detected") ||
    errorMessage.includes("content moderation") ||
    errorMessage.includes("flagged and rejected") ||
    errorMessage.includes("NO_IMAGE") ||
    // OpenAI moderation phrasing
    errorMessage.includes("safety system") ||
    errorMessage.includes("moderation_blocked") ||
    errorMessage.toLowerCase().includes("content_policy_violation")
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/utils.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/utils.ts lib/utils.test.ts
git commit -m "feat: detect openai content-policy errors

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Swap `app/api/generate-comic/route.ts` to OpenAI

**Files:**
- Modify: `app/api/generate-comic/route.ts`

**Interfaces:**
- Consumes: `generateComicImage` (Task 2), `uploadBufferToS3` (Task 3), `isContentPolicyViolation` (Task 4), and OpenAI title/description generation.
- Produces: unchanged HTTP response shape.

> This is a modify-in-place task with no unit test (it's an integration route; verified via build + manual run in Task 7). Make each edit exactly as written.

- [ ] **Step 1: Update imports and remove legacy image constants**

Replace the top provider import and the model/dimension constants. Change line 2 from:
```ts
import OpenAI from "openai";
```
to keep text generation on OpenAI and add the new imports. After the existing `import { buildComicPrompt } from "@/lib/prompt";` line, add:
```ts
import { generateComicImage } from "@/lib/image-generation";
import { uploadBufferToS3 } from "@/lib/s3-upload";
```

Then delete these now-unused constants (the `NEW_MODEL`, `IMAGE_MODEL`, `FIXED_DIMENSIONS` block):
```ts
const NEW_MODEL = false;
const IMAGE_MODEL = NEW_MODEL
  ? "google/gemini-3-pro-image"
  : "google/flash-image-2.5";
const FIXED_DIMENSIONS = NEW_MODEL
  ? { width: 896, height: 1200 }
  : { width: 864, height: 1184 };
```
Keep `const TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-4.1-mini";` (used for the title call).

- [ ] **Step 2: Keep the text client, and remove the `dimensions` variable**

The title-generation block uses an OpenAI text client for `client.chat.completions.create` (title). Delete the now-unused line:
```ts
    const dimensions = FIXED_DIMENSIONS;
```

- [ ] **Step 3: Replace the image-generation call**

Find the image generation block (the `try { ... response = await client.images.generate({ ... }) ... }`) and replace the **success path** so it calls OpenAI and returns a Buffer. Replace:
```ts
      const startTime = Date.now();
      response = await client.images.generate({
        model: IMAGE_MODEL,
        prompt: fullPrompt,
        width: dimensions.width,
        height: dimensions.height,
        temperature: 0.1, // Lower temperature for more consistent face matching
        reference_images:
          referenceImages.length > 0 ? referenceImages : undefined,
      });
      const endTime = Date.now();
```
with:
```ts
      const startTime = Date.now();
      imageBuffer = await generateComicImage({
        apiKey: finalApiKey!,
        prompt: fullPrompt,
        referenceImageUrls: referenceImages,
      });
      const endTime = Date.now();
```
And change the declaration `let response;` (just above the `try`) to:
```ts
    let imageBuffer: Buffer;
```

- [ ] **Step 4: Replace the response-validation + S3 upload block**

Replace:
```ts
    if (!response.data || !response.data[0] || !response.data[0].url) {
      return NextResponse.json(
        { error: "No image URL in response" },
        { status: 500 },
      );
    }

    const imageUrl = response.data[0].url;

    // Upload image to S3 for permanent storage
    const s3Key = `${storyId || story!.id}/page-${
      page.pageNumber
    }-${Date.now()}.jpg`;
    const s3ImageUrl = await uploadImageToS3(imageUrl, s3Key);
```
with:
```ts
    // Upload generated bytes to S3 for permanent storage
    const s3Key = `${storyId || story!.id}/page-${
      page.pageNumber
    }-${Date.now()}.png`;
    const s3ImageUrl = await uploadBufferToS3(imageBuffer, s3Key, "image/png");
```

- [ ] **Step 5: Fix the 402 credit-limit error message**

Replace the old provider-specific billing message:
```ts
              error:
                "Insufficient API credits. Please add credits to your OpenAI account at https://platform.openai.com/account/billing or update your API key.",
```
with:
```ts
              error:
                "Insufficient API credits. Please add credits to your OpenAI account at https://platform.openai.com/account/billing or update your API key.",
```

- [ ] **Step 6: Verify the build compiles**

Run: `pnpm build`
Expected: build succeeds. If TypeScript complains that `imageBuffer` is used before assignment, confirm the `catch` block returns (it does — every branch returns a `NextResponse`), and that `imageBuffer` is declared with `let imageBuffer: Buffer;`. `next.config.mjs` has `ignoreBuildErrors: true`, so also run `pnpm lint` to surface issues the build hides.

- [ ] **Step 7: Commit**

```bash
git add app/api/generate-comic/route.ts
git commit -m "feat: generate first page with gpt-image-2

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Swap `app/api/add-page/route.ts` to OpenAI

**Files:**
- Modify: `app/api/add-page/route.ts`

**Interfaces:**
- Consumes: `generateComicImage` (Task 2), `uploadBufferToS3` (Task 3). This route does not do text generation.
- Produces: unchanged HTTP response shape.

- [ ] **Step 1: Update imports and delete legacy constants**

Remove the old provider import (line 3):
```ts
import OpenAI from "openai";
```
Replace the S3 import line:
```ts
import { uploadImageToS3 } from "@/lib/s3-upload";
```
with:
```ts
import { uploadBufferToS3 } from "@/lib/s3-upload";
```
After the `import { buildComicPrompt } from "@/lib/prompt";` line, add:
```ts
import { generateComicImage } from "@/lib/image-generation";
```
Delete the model/dimension constants block:
```ts
const NEW_MODEL = false;
const IMAGE_MODEL = NEW_MODEL
  ? "google/gemini-3-pro-image"
  : "google/flash-image-2.5";
const FIXED_DIMENSIONS = NEW_MODEL
  ? { width: 896, height: 1200 }
  : { width: 864, height: 1184 };
```

- [ ] **Step 2: Remove the `dimensions` var and old provider client**

Delete:
```ts
    const dimensions = FIXED_DIMENSIONS;
```
Delete the old provider client construction:
```ts
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
```

- [ ] **Step 3: Replace the image-generation call**

Change `let response;` to:
```ts
    let imageBuffer: Buffer;
```
Replace:
```ts
      const startTime = Date.now();
      response = await client.images.generate({
        model: IMAGE_MODEL,
        prompt: fullPrompt,
        width: dimensions.width,
        height: dimensions.height,
        reference_images:
          referenceImages.length > 0 ? referenceImages : undefined,
      });
      const endTime = Date.now();
```
with:
```ts
      const startTime = Date.now();
      imageBuffer = await generateComicImage({
        apiKey: process.env.OPENAI_API_KEY!,
        prompt: fullPrompt,
        referenceImageUrls: referenceImages,
      });
      const endTime = Date.now();
```

- [ ] **Step 4: Replace the response-validation + S3 upload block**

Replace:
```ts
    if (!response.data || !response.data[0] || !response.data[0].url) {
      return NextResponse.json(
        { error: "No image URL in response" },
        { status: 500 },
      );
    }

    const imageUrl = response.data[0].url;
    const s3Key = `${story.id}/page-${page.pageNumber}-${Date.now()}.jpg`;
    const s3ImageUrl = await uploadImageToS3(imageUrl, s3Key);
```
with:
```ts
    const s3Key = `${story.id}/page-${page.pageNumber}-${Date.now()}.png`;
    const s3ImageUrl = await uploadBufferToS3(imageBuffer, s3Key, "image/png");
```

- [ ] **Step 5: Verify build + lint**

Run: `pnpm build && pnpm lint`
Expected: succeeds; no remaining references to legacy image-generation imports, `dimensions`, or `response.data` in this file. Confirm with:
```bash
grep -n "dimensions\|response.data\|images.generate" app/api/add-page/route.ts
```
Expected: no matches.

- [ ] **Step 6: Commit**

```bash
git add app/api/add-page/route.ts
git commit -m "feat: generate continuation pages with gpt-image-2

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Re-point API-key validation to OpenAI + env/docs

**Files:**
- Modify: `app/api/validate-api-key/route.ts`
- Modify: `.example.env`
- Modify: `README.md`
- Modify: `components/api-key-modal.tsx` (copy only — verify current wording first)

**Interfaces:**
- Consumes: `openai` SDK.
- Produces: `POST /api/validate-api-key` validates an OpenAI key; response shape `{ valid: boolean, error?: string }` unchanged.

- [ ] **Step 1: Rewrite the validator**

Replace the entire body of `app/api/validate-api-key/route.ts` with:
```ts
import { type NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

export async function POST(request: NextRequest) {
  try {
    const { apiKey } = await request.json();

    if (!apiKey || typeof apiKey !== "string") {
      return NextResponse.json(
        { valid: false, error: "API key is required" },
        { status: 400 },
      );
    }

    // Cheap validating call: list models. Succeeds only for a valid key.
    const client = new OpenAI({ apiKey });
    await client.models.list();

    return NextResponse.json({ valid: true });
  } catch (error: unknown) {
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? (error as { status: number }).status
        : undefined;

    if (status === 401 || status === 403) {
      return NextResponse.json({ valid: false, error: "Invalid API key" });
    }

    return NextResponse.json(
      { valid: false, error: "Validation failed" },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 2: Add `OPENAI_API_KEY` to `.example.env`**

Add a line at the top of `.example.env`:
```
OPENAI_API_KEY=
```
Leave `OPENAI_API_KEY=` in place for both image and title/description generation.

- [ ] **Step 3: Update the API-key modal copy**

Run first to see current wording:
```bash
grep -n "API key" components/api-key-modal.tsx
```
Then replace any user-facing legacy provider references and the key-acquisition link with OpenAI equivalents:
- Link → `https://platform.openai.com/api-keys`
- Wording → "OpenAI API key"
Only change display strings/links; do not change component logic.

- [ ] **Step 4: Update README**

In `README.md`, update the "How AI Generates Comics" section: comic pages are generated with **OpenAI `gpt-image-2`** (`images.edit` for character/style consistency, `images.generate` otherwise), and titles/descriptions use an OpenAI text model. Add `OPENAI_API_KEY=<your_openai_api_key>` to the env-keys list.

- [ ] **Step 5: Verify build + lint**

Run: `pnpm build && pnpm lint`
Expected: succeeds. Confirm no stale provider copy remains in the api-key modal:
```bash
grep -in "together" components/api-key-modal.tsx
```
Expected: no matches (or only non-user-facing).

- [ ] **Step 6: Commit**

```bash
git add app/api/validate-api-key/route.ts .example.env README.md components/api-key-modal.tsx
git commit -m "feat: validate openai keys; document gpt-image-2 swap

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: all Vitest tests pass (image-generation, s3-upload, utils).

- [ ] **Step 2: Confirm no stray legacy image usage remains**

Run:
```bash
grep -rn "images.generate\|reference_images\|FIXED_DIMENSIONS" app lib
```
Expected: no matches (the only `images.generate`/`edit` calls now live inside `lib/image-generation.ts` via the OpenAI client — this grep targets removed legacy provider patterns).

- [ ] **Step 3: Manual smoke test (requires `OPENAI_API_KEY` set, dev server already running per AGENTS.md)**

Use the verify skill or drive the running app:
1. Create a comic from the web form with **no** character photo → confirm a portrait page image is produced and stored (S3 URL loads).
2. Create one **with** a character photo → confirm the face resembles the reference (exercises `images.edit`).
3. Add a continuation page → confirm style continuity with the previous page (exercises `images.edit` with previous-page reference).

Record the observed outcome (image URLs, timing) as evidence. Do not claim success without this.

- [ ] **Step 4: Final gate**

Run: `pnpm build && pnpm lint && pnpm test`
Expected: all pass. Phase A complete.

---

## Self-Review

**Spec coverage (Phase A slice of §10):**
- OpenAI swap, generate-vs-edit branch → Tasks 2, 5, 6. ✔
- `uploadBufferToS3` for base64 bytes → Task 3. ✔
- Re-point `/api/validate-api-key` → Task 7. ✔
- Env/docs (`OPENAI_API_KEY`) → Task 7. ✔
- BYO key preserved → Tasks 5 (`finalApiKey`), 7. ✔
- Content-policy mapping for OpenAI → Task 4. ✔
- `comic-service.ts` (spec D1) → **deliberately deferred to Phase B** (documented in File Structure scope note). ✔
- Title text now uses OpenAI through `lib/title-generation.ts`. ✔

**Deferred to later plans (not Phase A):** schema `source`/`conversations` (Phase B), SMS webhook + QStash worker (Phase B), Voice WS service (Phase C). These will each get their own plan.

**Placeholder scan:** none — every code step shows complete code.

**Type consistency:** `generateComicImage({ apiKey, prompt, referenceImageUrls })` returning `Promise<Buffer>` is used identically in Tasks 5 & 6; `uploadBufferToS3(buffer, key, contentType)` used identically in Tasks 5 & 6. ✔
