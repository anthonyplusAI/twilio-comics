# Conversational comics on Azure: design

**Status:** Implementation brief for the current worktree.

## Outcome

A person can text a comic idea or call the Twilio number, refine it with an AI assistant, explicitly approve the draft, and receive the finished comic by message. The browser remains an optional viewer and editor. The first approved request creates one five-panel page; a later `CONTINUE` request can add a page to the same phone-owned story. Each page consumes one free-tier generation claim.

## User flow

1. The first text or spoken utterance is treated as an idea, not as a name field. The assistant asks one useful question at a time, accepts changes, and chooses only an existing style: `american-modern`, `manga`, `noir`, or `vintage`.
2. SMS and WhatsApp can carry up to two image references. A photo-only message is acknowledged and kept for the draft. A voice caller can describe characters verbally; image attachment is available through messaging.
3. Once the idea is specific enough, the assistant summarizes the page and asks for the explicit command `CREATE` (or spoken “create it”). Other speech or text revises the draft. `NEW` resets it, `DISCARD` discards a text draft (spoken “cancel” on a call), and `STATUS` reports generation progress. After delivery, `CONTINUE` starts a new page of the same story. SMS opt-out, opt-in, and help keywords remain reserved for Twilio.
4. Generation runs asynchronously. The recipient receives an MMS or WhatsApp image plus a story link. On media delivery failure, the app attempts a text-only link and records delivery status. A phone story remains viewable by link; linking it to a Google account is a separate identity flow and is not implied by a shared phone number.

## Components and contracts

- `lib/comic-agent.ts` owns deterministic state transitions and validation. It calls `lib/comic-agent-model.ts` only when the user is refining a draft. The model returns a proposed reply, self-contained image prompt, supported style, and whether the draft is ready for approval. Code, not the model, decides when `CREATE` submits a job.
- SMS and WhatsApp webhooks validate the Twilio signature, store each `MessageSid` and content durably in PostgreSQL, enqueue its ID on Azure Queue, and return TwiML promptly. The worker handles messages in arrival order per phone/channel under a bounded database lease, saves the reply before sending it, and retries safely. The queue payload carries identifiers, not user content.
- The `/relay` WebSocket in the public Container App validates Twilio's handshake and uses the same conversation engine for live turns. It submits a job only after confirmation. A `<Connect action>` callback gives the caller a clear result if the socket fails.
- The existing event-driven Container Apps Job handles both inbound-agent work and image-generation work from Azure Queue. Both use the same immutable container image. Slow image generation never runs inside a Twilio webhook or call request.
- `lib/comic-service.ts` creates page 1 or appends an idempotent page. The generation job has a deterministic page ID and Blob key so queue redelivery does not regenerate completed work. Outbound delivery records a Twilio SID and later status callbacks.

## Reliability and safety

- Inbound deduplication uses `MessageSid`; call submission uses `CallSid` plus the approved turn. Queue publication failures remain retryable and cannot strand a conversation in `generating`. Concurrent retries cannot move a job backward from `processing` or `succeeded`.
- A per-conversation lease prevents two inbound turns from overwriting state. The worker processes the oldest pending turn first and leaves a queued wake-up available while another worker owns the lease.
- Inputs are bounded: 4,000 characters for an image prompt, 12 recent conversation turns, two references, validated styles, and a limited number of agent turns. The user text is passed to OpenAI as a user message; Twilio and model output are validated before side effects.
- Twilio media download requires an exact allowed HTTPS host and rejects redirects before sending Twilio credentials. The outbound preview is sized for MMS while the full image remains in Blob for the story page.
- Messaging status callbacks verify Twilio signatures and record `delivered`, `failed`, or `undelivered`. A Twilio API SID means accepted for processing, not delivered to the recipient.

## Azure and migration contract

Keep the current public ACA (Next.js plus ConversationRelay WebSocket), event-driven ACA Job, Azure Queue, private Blob, ACR, managed identities, GitHub OIDC, CI gate, and health smoke test. Follow the sibling projects' tagged resource provisioning and derive the OIDC repo subject from this checkout rather than hard-coding another repository.

Restore already-recorded Drizzle migration `0005` to its committed contents. Add missing schema objects and new conversation/outbox fields only in forward migrations. An existing database previously changed with `drizzle-kit push` must be inspected and baselined before file-based `migrate` is used. No automatic production schema write occurs until that preflight is complete.

## Verification

Behavioral tests cover model output validation, confirmation and revision, photo-only turns, ordered SMS processing, queue failures/retries, voice submission, continuation, Twilio signature checks, delivery callbacks, and MMS sizing. Run tests, typecheck, lint, production build, and Docker build. Verify a real Twilio number and Azure worker only when credentials and external configuration are available.
