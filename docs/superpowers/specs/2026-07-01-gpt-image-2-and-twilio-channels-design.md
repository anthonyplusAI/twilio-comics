# Design: GPT Image 2 generation + Twilio (SMS & Voice) input channels

> **Superseded:** This historical design predates Auth.js, WhatsApp support, Azure Blob/Queue Storage, and the combined Azure Container Apps runtime. See the root README for the current architecture.

**Date:** 2026-07-01
**Status:** Implemented, then updated 2026-07-07 to remove the previous secondary AI provider entirely.
**Scope:** Use OpenAI for comic image generation plus title/description generation, and add Twilio SMS/MMS and Twilio Voice (ConversationRelay) as alternative input channels to the existing web form.

---

## 1. Goals & non-goals

### Goals
- Generate comic pages with OpenAI **`gpt-image-2`**, preserving the existing "consistent character faces across panels" behavior that depends on reference images.
- Let users create a comic **without the web UI**, by:
  - **SMS/MMS** — texting their name + story prompt (and optionally a character photo).
  - **Voice call** — a phone conversation (Twilio ConversationRelay) that collects name + story prompt by voice.
- Deliver the finished comic back over the same channel (MMS image + a link to the existing web story page).

### Non-goals (this iteration)
- No changes to the web editor experience beyond the shared-service refactor.
- No new comic styles or layout changes.
- No billing/subscription changes; free-tier rate limiting is reused.
- No migration of existing stories.

---

## 2. Current architecture (as-is)

- **Web form** (`components/landing/comic-creation-form.tsx`) collects: `prompt`, `style` (noir/manga/american-modern/vintage), and up to **2 character photos** (uploaded to S3 via `next-s3-upload`).
- **`POST /api/generate-comic`** (new story, page 1): auth via Clerk → create `story` + `page` rows → build prompt (`lib/prompt.ts`) → generate image through `lib/image-generation.ts` with OpenAI `images.generate` or `images.edit` → upload result to S3 → generate title/description through `lib/title-generation.ts` with an OpenAI text model → update rows → apply free-tier rate limit.
- **`POST /api/add-page`** (continuation / redraw): similar, plus it passes the **previous page image** as a reference for style continuity.
- **Reference images** are the mechanism for character/style consistency: the character photos and previous-page image are passed to OpenAI `images.edit` as input images.
- **Storage:** Neon Postgres (Drizzle, `lib/schema.ts`): `stories`, `pages`, `feedback`. Images on public S3 (`lib/s3-upload.ts`). Rate limiting on Upstash Redis (`lib/rate-limit.ts`, 3 comics / 7 days). Auth via Clerk (`proxy.ts` middleware).

### Key constraints discovered (research-grounded)
1. **OpenAI splits generation across two endpoints.** `images.generate()` is **text-only**; reference/input images require **`images.edit()`** (accepts up to 16 input images). The port must branch: *no references → generate, any references → edit*.
2. **`gpt-image-2` returns base64 only** (`b64_json`) — never a URL. Bytes: `Buffer.from(res.data[0].b64_json, "base64")`, which drops directly into the existing S3 upload path (which currently fetches a URL — this changes to accept a buffer).
3. **No `temperature`; arbitrary width/height IS supported on `gpt-image-2`** (dims divisible by 16, aspect ratio 1:3–3:1). The existing `864x1184` remains valid, or use the named `1024x1536` portrait size. `quality` = `low|medium|high|auto`; `input_fidelity: "high"` improves face fidelity for edits.
4. **Twilio webhooks must respond in ~15s**, but generation takes 30–60s. Must ack immediately and deliver asynchronously.
5. **ConversationRelay requires a persistent WebSocket server** — a Next.js/Vercel serverless route cannot hold it. Needs a separate long-lived Node process/container.
6. **A2P 10DLC registration** (Brand + Campaign, ~10–15 day carrier review) gates US SMS deliverability. Outbound MMS media must be publicly reachable (S3 already is). Inbound MMS media downloads need HTTP Basic auth (Account SID + Auth Token).

---

## 3. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Extract a channel-agnostic **`lib/comic-service.ts`** | Web, SMS, and Voice all need identical "make a comic page" logic. Avoids triplicating the ~150-line route logic. |
| D2 | **`lib/image-generation.ts`** wraps OpenAI; branches `generate()` vs `edit()` on presence of reference images | The two-endpoint split is the central API difference. |
| D3 | **Build SMS first, Voice second** (both designed here) | Voice forces a second long-lived deployment; SMS proves the full pipeline inside the existing app first. *(Recommended default — confirm.)* |
| D4 | **Delivery = MMS image + link to existing web story page** | Reuses the entire existing web viewer/editor/PDF; the image also lands in-thread. *(Recommended default — confirm.)* |
| D5 | **Phone number (E.164) is the identity** for SMS/Voice stories; Clerk stays web-only | Twilio users have no Clerk account. Natural, low-friction. |
| D6 | Background generation via **Upstash QStash** enqueue → worker | Already using Upstash; durable + retried; decouples the fast webhook ack from slow work. When the Voice WS service exists, it can host the worker instead. |
| D7 | Use OpenAI for title/description text | Keeps all AI generation on one provider. |
| D8 | Voice conversation runs on an **in-repo standalone Node WS server** (`voice-server/`) | ConversationRelay needs `wss://`; serverless can't host it. |

---

## 4. Component design

### 4.1 `lib/image-generation.ts` (new) — OpenAI wrapper

Single unit responsible for turning a prompt (+ optional reference image URLs) into image **bytes**.

```
generateImage({
  apiKey,            // BYO key or server default (OPENAI_API_KEY)
  prompt,            // full prompt string from buildComicPrompt
  referenceImageUrls // string[] of S3 URLs (character photos + prev page)
}): Promise<Buffer>
```

Behavior:
- `new OpenAI({ apiKey })`.
- If `referenceImageUrls.length === 0` → `client.images.generate({ model: "gpt-image-2", prompt, size: "1024x1536", quality: "high" })`.
- Else → fetch each reference URL → `Buffer` → `toFile(buf, "ref-N.png", { type })`; `client.images.edit({ model: "gpt-image-2", image: [...files], prompt, size: "1024x1536", quality: "high", input_fidelity: "high" })`. Cap at 16 inputs (we send ≤3, so fine).
- Decode `res.data[0].b64_json` → `Buffer`. Throw on missing data.
- Error mapping preserved: content-policy detection (`isContentPolicyViolation` in `lib/utils.ts` — may need new OpenAI-specific match strings), 401/403 (invalid key), 429/insufficient-quota. Map OpenAI error shapes to the app's existing `errorType` values so the UI/SMS copy is unchanged.

**Interface contract:** callers pass a prompt and reference URLs, get bytes. No knowledge of endpoints, base64, or OpenAI internals leaks out.

### 4.2 `lib/s3-upload.ts` (modify)

Add `uploadBufferToS3(buffer, key, contentType)` since OpenAI returns bytes, not a URL. Keep the existing URL-fetching `uploadImageToS3` for backward compat (or refactor it to call the buffer version after fetching). Image content type becomes `image/png` (gpt-image default) — key/extension updated accordingly.

### 4.3 `lib/comic-service.ts` (new) — channel-agnostic orchestration

Extracts the shared logic currently duplicated in `generate-comic` and `add-page` routes:

```
createComicStory({ userId, prompt, style, characterImageUrls, apiKey, source }): Promise<{ story, page, imageUrl }>
addComicPage({ userId, storySlug, prompt, characterImageUrls, apiKey, pageId? }): Promise<{ page, imageUrl }>
```

Responsibilities: create/lookup story + page rows, assemble reference image list (prev page + characters), call `buildComicPrompt`, call `image-generation`, upload to S3, generate title (new story), update rows, apply rate limit, cleanup rows on failure. `source: 'web' | 'sms' | 'voice'` recorded on the story.

The three existing web routes become thin adapters over this service.

### 4.4 Schema changes (`lib/schema.ts` + Drizzle migration)

- `stories.source` — `text('source').default('web').notNull()` (`web|sms|voice`).
- `stories.userId` already `text` — holds Clerk id **or** E.164 phone number.
- **New `conversations` table** — SMS/Voice state machine:
  - `id`, `phoneNumber` (unique, E.164), `channel` (`sms|voice`), `state` (`awaiting_name|awaiting_prompt|awaiting_style|awaiting_photo|generating|done`), `collected` (jsonb: `{ name?, prompt?, style?, characterImageUrls? }`), `activeStoryId`, `createdAt`, `updatedAt`.
  - Alternative: hold this in Redis with a TTL instead of Postgres. **Decision: Postgres table** for auditability and because Neon is already the source of truth. (Open question O3.)
- Run `pnpm drizzle-kit generate` + `pnpm drizzle-kit push` (per AGENTS.md).

### 4.5 SMS/MMS channel (Next.js routes)

**`POST /api/twilio/sms`** (webhook, form-encoded):
1. Validate `X-Twilio-Signature` (`twilio.validateRequest` with exact public URL + all params). Reject on mismatch.
2. Parse `From`, `Body`, `NumMedia`, `MediaUrl0…`, `MediaContentType0…`.
3. Load/create the `conversations` row for `From`; run the **state machine**:
   - `awaiting_name` → store name → ask for the story prompt.
   - `awaiting_prompt` → store prompt → (optional) ask for style/photo, or go straight to generate. Keep the flow short: **name → prompt → generate** by default; style defaults to `noir`, photo optional if an MMS image is attached at any step.
   - If an image is attached: download with Basic auth → re-upload to our S3 → add to `characterImageUrls`.
   - When enough is collected → set `generating`, **enqueue** a QStash job, and reply with an **instant ack** ("Generating your comic — about a minute…").
4. Respond with TwiML (`Content-Type: text/xml`) — either the ack `<Message>` or empty `<Response/>`.

**`POST /api/twilio/generate-worker`** (QStash target, verified via QStash signature):
- Runs `comic-service.createComicStory({ source: 'sms', userId: phone, ... })` (30–60s).
- On success: `client.messages.create({ to: phone, from: TWILIO_PHONE_NUMBER, body: "Your comic '<title>' is ready! View/continue: <link>", mediaUrl: [s3Url] })`.
- On failure: send an SMS with the mapped error message (content-policy, credits, generic). Reset conversation state.
- This route must allow a longer max duration (`export const maxDuration = 60`) — or run on the long-lived service if/when it exists.

### 4.6 Voice channel (standalone WS service) — phase 2

**`POST /api/twilio/voice`** (Next.js route, returns TwiML):
```xml
<Response>
  <Connect>
    <ConversationRelay url="wss://<voice-host>/relay"
      welcomeGreeting="Hi! I'll make you a comic. What's your name?" />
  </Connect>
</Response>
```

**`voice-server/`** (in-repo standalone Node service, deployed to Fly/Render/Railway):
- WebSocket server; validates `X-Twilio-Signature` on the handshake.
- On `setup`: capture `callSid`, `from`. State = awaiting_name.
- On `prompt` (`last:true`): advance state machine (name → story prompt). Send `text` tokens back for TTS.
- After collecting name + prompt: speak "Generating now — I'll text it to you," enqueue the **same** QStash generation job (source `voice`, `userId` = caller's `from`), then `end` the session. Delivery is via outbound MMS exactly like SMS.
- Reuses `lib/comic-service.ts` and `lib/image-generation.ts` (shared package/imports; the service is in the same repo).

### 4.7 `/api/validate-api-key` (modify)

Validate OpenAI keys with `new OpenAI({ apiKey })` → a cheap validating call (e.g. `client.models.retrieve("gpt-image-2")` or a tiny models list) → return `{ valid }`. Update the api-key modal copy and cost hint (~$0.05/comic).

---

## 5. Data flow (SMS, happy path)

```
User texts "Batman noir on a rooftop"
      │
      ▼
POST /api/twilio/sms  ── validate sig ── load conversation(From)
      │                                        │
      │  state machine: name? prompt? ─────────┘
      │  (enough collected)
      ├─▶ enqueue QStash job {phone, prompt, style, refs}
      └─▶ TwiML reply: "Generating your comic — ~1 min…"   (instant, <1s)

QStash ──▶ POST /api/twilio/generate-worker (maxDuration 60)
      │
      ├─ comic-service.createComicStory(source:'sms', userId:phone)
      │     ├─ buildComicPrompt()
      │     ├─ image-generation.generateImage()  ── gpt-image-2 (edit if refs)
      │     ├─ uploadBufferToS3()  → public URL
      │     └─ title/description via OpenAI text model
      │
      └─▶ client.messages.create({ to:phone, mediaUrl:[s3Url], body:"…<link>" })
            → user receives comic page as MMS + web link
```

---

## 6. Environment variables (additions)

```
OPENAI_API_KEY=
OPENAI_IMAGE_MODEL=gpt-image-2
OPENAI_TEXT_MODEL=gpt-4.1-mini

# Twilio
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_PHONE_NUMBER=            # E.164, SMS+Voice+MMS capable

# Background jobs
QSTASH_TOKEN=
QSTASH_CURRENT_SIGNING_KEY=
QSTASH_NEXT_SIGNING_KEY=

# App
PUBLIC_BASE_URL=                # https origin, for exact-URL sig validation + links

# Voice (phase 2)
CONVERSATION_RELAY_WS_URL=      # wss://<voice-host>/relay

```
Update `.example.env` and `README.md` accordingly.

---

## 7. External setup checklist (for the user)

1. **OpenAI:** create key with `gpt-image-2` access; set `OPENAI_API_KEY`.
2. **Twilio:** create account; note Account SID + Auth Token; buy a phone number with **SMS + Voice + MMS**; set the number's Messaging webhook → `<PUBLIC_BASE_URL>/api/twilio/sms` and Voice webhook → `<PUBLIC_BASE_URL>/api/twilio/voice`.
3. **A2P 10DLC:** register Brand + Campaign in Twilio Trust Hub — **start early (~10–15 day review)**; US SMS is unreliable until approved.
4. **ConversationRelay:** accept the AI/ML addendum in Console → Voice → Settings → Privacy & Security (phase 2).
5. **Upstash QStash:** enable QStash; capture token + signing keys.
6. **Long-lived host** (phase 2): deploy `voice-server/` to Fly/Render/Railway; set `CONVERSATION_RELAY_WS_URL`.
7. **S3:** confirm objects are publicly GET-able (they are) so Twilio can fetch MMS media.

---

## 8. Error handling

- **Signature validation failure** → 403, no processing.
- **Content policy** → reuse `isContentPolicyViolation`; SMS/voice reply with the friendly policy message; clean up created rows.
- **Insufficient credits/quota (OpenAI 429/402)** → mapped `credit_limit` message.
- **Invalid BYO key (401/403)** → mapped message; validate-api-key catches this earlier for web.
- **Generation failure mid-job** → worker deletes the orphan story/page rows (mirrors current cleanup) and texts the user an apology + retry hint; conversation state reset.
- **QStash retry** → worker must be idempotent-ish: guard against double-send by checking whether the story already has a generated image before re-generating.

---

## 9. Testing strategy

- **Unit:** `image-generation.ts` — mock OpenAI; assert generate-vs-edit branch on reference presence, base64→buffer decode, error mapping. `comic-service.ts` — mock image + S3 + db; assert story/page creation, reference assembly, cleanup on failure.
- **Unit:** SMS state machine — pure function `(state, inbound) → (nextState, reply, action)`; table-driven tests for name→prompt→generate, photo attach, restart.
- **Signature validation:** unit test `twilio.validateRequest` wiring with a known-good fixture.
- **Integration (local):** Twilio CLI / ngrok to hit `/api/twilio/sms`; QStash local dev or a direct worker call to exercise generation against a real OpenAI key (one real image).
- **Manual e2e:** text the number end-to-end; confirm MMS delivery + link.
- **Build/lint gates:** `pnpm build`, `pnpm lint` (dev server assumed already running per AGENTS.md).

---

## 10. Build sequence

**Phase A — OpenAI swap (no Twilio):**
1. `lib/image-generation.ts` + `uploadBufferToS3`; wire into existing `generate-comic` + `add-page` behind the new `comic-service.ts`. Re-point `/api/validate-api-key`. Verify web flow still produces comics with consistent faces. Update env/docs.

**Phase B — SMS/MMS:**
2. Schema: `stories.source`, `conversations` table, migration + push.
3. `/api/twilio/sms` webhook + state machine + signature validation.
4. QStash enqueue + `/api/twilio/generate-worker` + outbound MMS delivery.
5. Twilio number config + A2P registration (external, in parallel).

**Phase C — Voice (ConversationRelay):**
6. `/api/twilio/voice` TwiML route.
7. `voice-server/` WS service (reuses comic-service); deploy to long-lived host.
8. Wire ConversationRelay + accept AI/ML addendum.

Each phase is independently shippable and testable.

---

## 11. Open questions (for user review)

- **O1 (build order):** Confirm SMS-first (D3) vs both-together vs voice-first.
- **O2 (delivery):** Confirm MMS image + link (D4) vs image-only vs link-only. (Link-only avoids some MMS cost/compliance but is less magical.)
- **O3 (conversation state store):** Postgres `conversations` table (chosen) vs Redis with TTL. Redis is lighter but less auditable.
- **O4 (title text):** Resolved — use an OpenAI text model.
- **O5 (styles over SMS):** Ask the texter to pick a style, or default to `noir` and skip the extra turn? (Design assumes default-noir, photo optional, to keep the SMS conversation to 2 turns.)
- **O6 (BYO key over SMS):** Web users can supply their own OpenAI key. Should SMS/voice users always use the server key (simpler), given they can't paste a key easily? (Design assumes server key for Twilio channels.)
```
