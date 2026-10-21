# Conversational Comics on Azure Implementation Plan

> **For agentic workers:** Keep file ownership explicit. Write a focused failing behavioral test before changing production behavior, then run the full project gates.

**Goal:** Let a person create and continue a comic through an AI-guided SMS, WhatsApp, or voice conversation and receive the result by message.

**Architecture:** A shared OpenAI-backed conversation engine collects and confirms a draft. Signed messaging webhooks durably queue inbound turns; ConversationRelay handles live voice turns in the public ACA. The existing Azure Queue and event-driven ACA Job process inbound messages and comic generation, with PostgreSQL leases and checkpoints.

**Tech Stack:** Next.js 16, Node.js 22, TypeScript, OpenAI SDK, Twilio SDK, Neon PostgreSQL/Drizzle, Azure Queue/Blob Storage, Azure Container Apps, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-01-conversational-comics-azure-design.md`

## Global Constraints

- Keep the existing Azure Container Apps layout: one public app on port 8080 and one private event-driven job using the same image.
- Do not run `pnpm dev`; the user owns the local development server.
- Validate all Twilio webhooks and the ConversationRelay upgrade with the exact public URL.
- Do not put prompts, photos, phone numbers, or secrets in Azure Queue messages.
- Reuse the existing four style IDs and cap image prompts at 4,000 characters and references at two.
- Make confirmation an explicit user action before any generation cost is incurred.
- Preserve existing uncommitted work and previously recorded migration files.

## Review Focus

1. An inbound webhook retries after queue publication fails: the idea must eventually be processed once, without leaving the conversation stuck.
2. Two quick texts arrive while two ACA jobs run: the later turn must observe the earlier turn's state.
3. An image arrives without a caption: the reference must be kept and the user prompted for an idea.
4. A voice transcript says “yes, but add a dragon”: the app must revise the draft, not submit it.
5. Twilio accepts an MMS but reports `undelivered`: the app must record the failure and try the text-only link where that channel permits it.

---

### Task 1: Shared comic conversation engine

**Files:** `lib/comic-agent.ts`, `lib/comic-agent-model.ts`, `lib/comic-agent.test.ts`, `lib/comic-agent-model.test.ts`.

**Interface:** `advanceComicAgent(current, turn, model?)` returns `{ nextState, collected, reply, action, submission? }`. `submission` contains a validated prompt, style, reference URLs, and optional continuation story ID. `action: "submit"` occurs only on an explicit `CREATE`/“create it” turn after confirmation.

- [ ] Write tests for idea-first intake, style selection, revisions, photo-only turns, explicit confirmation, reset/cancel/status, generating state, continuation, malformed model output, and prompt/history limits.
- [ ] Run the focused tests and observe the expected missing-behavior failures.
- [ ] Implement the deterministic state machine and structured OpenAI model adapter with Zod validation and timeouts.
- [ ] Run focused and full tests. Ensure the model never directly publishes a queue message.

### Task 2: Durable queue and inbound message storage

**Files:** `lib/schema.ts`, `drizzle/0005_premium_speed.sql`, forward migration(s), `lib/generation-queue.ts`, `lib/twilio-events.ts`, `worker/index.ts`, focused tests.

**Interface:** Queue messages are either legacy `{version:1,jobId}` generation work or versioned inbound work containing a `MessageSid`; inbound message text and media metadata live in PostgreSQL. Per-conversation leases are acquired and released atomically.

- [ ] Test queue parsing, old-message compatibility, failed publication/retry, duplicate `MessageSid`, and per-phone lease behavior.
- [ ] Run those tests red, then add schema, migration, queue dispatch, and durable receipt operations.
- [ ] Restore the recorded `0005` SQL and put the previously omitted schema objects in a forward migration.
- [ ] Run tests and Drizzle's static migration checks. Keep live schema writes for the preflight step.

### Task 3: Messaging adapter and ordered agent worker

**Files:** `app/api/twilio/sms/route.ts`, `app/api/twilio/whatsapp/route.ts`, `lib/process-inbound-message.ts`, focused tests.

**Interface:** The webhook validates signature, persists the request, publishes its ID, and returns empty TwiML. The worker processes the oldest pending message for that phone/channel, calls `advanceComicAgent`, checkpoints state and reply, submits generation only after confirmation, then sends a Twilio reply.

- [ ] Test signed and forged webhooks, first idea, rapid turns, photo-only input, queue failure, duplicate delivery, and retry after outbound failure.
- [ ] Observe red tests, implement the adapter and processor, and run focused/full tests.
- [ ] Bound per-phone model usage and use exact HTTPS Twilio media hosts with redirect rejection before credentialed downloads.

### Task 4: ConversationRelay voice adapter

**Files:** `server/index.ts`, `lib/voice-conversation.ts`, `app/api/twilio/voice/route.ts`, a voice action route, `package.json`, voice tests.

**Interface:** Each signed `/relay` session passes final transcripts to `advanceComicAgent`; confirmed submission uses `CallSid` and the same job API. Failed model or queue operations produce spoken recovery copy. The `<Connect action>` route handles disconnects.

- [ ] Test setup identity, multi-turn revisions, exact confirmation, duplicate prompts, interrupted speech, quota rejection, and socket failure.
- [ ] Observe red tests, implement voice handling, and run focused/full tests.
- [ ] Make the documented local voice start path use the custom server without executing `pnpm dev` during this task.

### Task 5: Continuation and result delivery

**Files:** `lib/comic-service.ts`, `lib/generation-jobs.ts`, `lib/process-generation-job.ts`, `lib/twilio.ts`, a signed status-callback route, focused tests.

**Interface:** Generation jobs distinguish create versus append and use deterministic page/blob IDs. A completed job sends an MMS-sized preview and story link; status callbacks track carrier delivery and trigger a single link-only fallback when appropriate.

- [ ] Test idempotent page creation, append ownership, previous-page reference, queue worker overtaking publisher, MMS preview sizing, and failed/undelivered callbacks.
- [ ] Observe red tests, implement checkpointed generation and delivery, and run focused/full tests.
- [ ] Ensure a channel user can request another page but cannot edit another user's story by supplying a slug.

### Task 6: Azure and migration rollout safety

**Files:** `scripts/provision-azure.sh`, `docs/INFRA_SETUP.md`, `docs/DEPLOYMENT.md`, `.github/workflows/deploy.yml`, `.example.env`, `README.md`, focused shell/static checks.

- [ ] Derive the OIDC subject from the actual GitHub owner/repository and provision required tagged Azure resources idempotently.
- [ ] Add a database preflight that detects a push-managed database without a Drizzle ledger and stops before deploy rather than replaying old migrations.
- [ ] Document the Twilio webhook URLs, ConversationRelay setup, callback, ACA/Queue settings, migration baseline, local testing, and user-visible commands.
- [ ] Run shell syntax checks and review the Docker image contents, managed identity permissions, and health smoke test.

### Task 7: Verification and integration review

- [ ] Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, and a container build if the local environment permits it.
- [ ] Test the SMS, WhatsApp, voice, generation, and status-callback flows with signed fixtures and a local fake OpenAI/Twilio/Azure boundary.
- [ ] Inspect the full diff, resolve integration defects, and record what still requires live Twilio/Azure credentials.
