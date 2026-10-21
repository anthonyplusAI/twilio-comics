# Phase C: Twilio Voice (ConversationRelay) — Implementation Plan

> **Superseded:** This is a historical implementation plan. Voice now runs in the main Azure Container App and queues work through Azure Queue Storage; use the root README and `docs/INFRA_SETUP.md` for current instructions.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user create a comic by phone call — Twilio ConversationRelay handles speech-to-text/text-to-speech; a standalone WebSocket server runs a scripted conversation (name → comic idea), enqueues the same generation job as SMS, and the finished comic is delivered to the caller by SMS/MMS.

**Architecture:** The Voice webhook (a Next.js serverless route) returns TwiML `<Connect><ConversationRelay url="wss://..."/></Connect>`. The call then connects to **a standalone long-lived Node WebSocket server** (`voice-server/`) — this CANNOT be a Next.js/Vercel serverless route because ConversationRelay holds a persistent socket for the call's duration. Twilio does STT/TTS; our server exchanges JSON text messages, runs a pure turn-based handler (reusing `lib/conversation.ts`'s collected-fields shape), and on completion calls `publishGenerationJob` (the same QStash job SMS uses). Delivery is via the existing SMS/MMS worker (caller gets the comic as a text).

**Tech Stack:** Next.js 16 (voice webhook only), a standalone Node + `ws` WebSocket service, `@upstash/qstash` (publish), TypeScript, Vitest.

## Global Constraints

- Builds on Phase A + B (branch `feat/gpt-image-2-twilio-channels`). Reuses `publishGenerationJob` (QStash) and the SMS `generate-worker` for delivery. Does NOT duplicate generation logic.
- The WebSocket server is a SEPARATE deployable (long-lived process). It must not import Next.js-only code. Specifically, `publishGenerationJob` must be importable WITHOUT pulling `@upstash/qstash/nextjs` (Task 1 splits the module).
- Image generation stays server-funded; identity is the caller's phone number (`from` in the ConversationRelay `setup` message) → same `userId`/`source` model (source `voice`).
- Validate the Twilio signature on the WebSocket upgrade handshake (`X-Twilio-Signature`) before accepting the connection.
- The conversation is scripted and short: greeting → capture name → capture comic idea → confirm + enqueue → end the call. The caller is told the comic will arrive by text.
- Rate limiting: peek `freeTierRateLimit.getRemaining(from)` before enqueuing (same as SMS), speak an over-limit message and end if exhausted.
- Per AGENTS.md: never run `pnpm dev`. The Next.js part is validated via `pnpm build`; the voice-server is validated via its own `pnpm test`/`tsc`/`node` smoke.
- Env additions: `CONVERSATION_RELAY_WS_URL` (the public wss:// URL Twilio connects to), reuse `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`, `QSTASH_*`, `PUBLIC_BASE_URL`, `OPENAI_*`.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `lib/qstash.ts` | keep `publishGenerationJob` + `GenerationJob` (pure, no /nextjs import) | Modify (split) |
| `lib/qstash-nextjs.ts` | re-export `verifySignatureAppRouter` from `@upstash/qstash/nextjs` (Next-only) | Create |
| `app/api/twilio/generate-worker/route.ts` | update import of the verify wrapper to the new module | Modify |
| `app/api/twilio/voice/route.ts` | Voice webhook → ConversationRelay TwiML (validate signature) | Create |
| `lib/voice-conversation.ts` | pure turn handler: `handleVoiceTurn(state, event) → { reply?, action, nextState, collected }` | Create |
| `lib/voice-conversation.test.ts` | table-driven tests for the turn handler | Create |
| `voice-server/package.json` | standalone service deps (`ws`, `twilio`, `@upstash/qstash`) | Create |
| `voice-server/src/server.ts` | `ws` server: handshake sig validation, per-connection session, message loop | Create |
| `voice-server/src/server.test.ts` | unit test the message dispatch (mock ws + publish) | Create |
| `voice-server/Dockerfile` + `fly.toml` (or render.yaml) | deployment scaffolding for the long-lived process | Create |
| `voice-server/README.md` | how to run/deploy the WS server | Create |
| `.example.env`, root `README.md` | `CONVERSATION_RELAY_WS_URL` + voice setup + AI/ML addendum note | Modify |

**Design note:** The turn logic lives in a PURE `lib/voice-conversation.ts` (no `ws`/network), so it's unit-testable and mirrors the SMS state machine's philosophy. The `voice-server` is thin I/O glue around it. This keeps the untestable socket layer minimal.

---

<!-- TASKS TO BE APPENDED AFTER RESEARCH RECONCILIATION -->

## Task 1: Split `lib/qstash.ts` so publish is importable outside Next.js

**Files:**
- Modify: `lib/qstash.ts` (remove the `/nextjs` re-export)
- Create: `lib/qstash-nextjs.ts` (the `/nextjs` re-export)
- Modify: `app/api/twilio/generate-worker/route.ts` (import verify from the new module)

**Interfaces:**
- `lib/qstash.ts` keeps `publishGenerationJob(job)` and `GenerationJob` with NO import of `@upstash/qstash/nextjs` — so a plain Node process (the voice server) can import it.
- `lib/qstash-nextjs.ts` exports `verifySignatureAppRouter` (Next-only).

- [ ] **Step 1: Remove the `/nextjs` re-export line from `lib/qstash.ts`**

Delete this line from `lib/qstash.ts`:
```ts
export { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
```

- [ ] **Step 2: Create `lib/qstash-nextjs.ts`**

```ts
// Next.js-only: the App Router signature-verification wrapper. Kept separate
// from lib/qstash.ts so non-Next consumers (the voice WS server) can import
// publishGenerationJob without pulling the /nextjs subpath.
export { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
```

- [ ] **Step 3: Update the worker import**

In `app/api/twilio/generate-worker/route.ts`, change:
```ts
import { verifySignatureAppRouter } from "@/lib/qstash";
```
to:
```ts
import { verifySignatureAppRouter } from "@/lib/qstash-nextjs";
```

- [ ] **Step 4: Verify tests + build**

Run: `pnpm test` (36 still pass — the qstash test imports `publishGenerationJob` from `@/lib/qstash`, unaffected) and `pnpm build 2>&1 | grep -iE "Compiled successfully|Failed to compile"`.
Expected: pass + Compiled successfully. If the qstash test mocked `@upstash/qstash/nextjs`, that mock is now unused but harmless.

- [ ] **Step 5: Commit**

```bash
git add lib/qstash.ts lib/qstash-nextjs.ts app/api/twilio/generate-worker/route.ts
git commit -m "refactor: split qstash publish (pure) from nextjs verify wrapper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Voice webhook — ConversationRelay TwiML

**Files:**
- Create: `app/api/twilio/voice/route.ts`

**Interfaces:**
- `POST` returns ConversationRelay TwiML (`Content-Type: text/xml`), validating `X-Twilio-Signature` first (403 on fail).

- [ ] **Step 1: Create the route**

```ts
import { type NextRequest } from "next/server";
import { validateTwilioSignature } from "@/lib/twilio";

export const runtime = "nodejs";

function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const params: Record<string, string> = {};
  new URLSearchParams(rawBody).forEach((v, k) => {
    params[k] = v;
  });

  const url = `${process.env.PUBLIC_BASE_URL?.replace(/\/$/, "")}/api/twilio/voice`;
  const signature = request.headers.get("x-twilio-signature");
  if (!validateTwilioSignature({ signature, url, params })) {
    return new Response("Invalid signature", { status: 403 });
  }

  const wsUrl = escapeXmlAttr(process.env.CONVERSATION_RELAY_WS_URL || "");
  const greeting = escapeXmlAttr(
    "Welcome to Make Comics! I'll help you create a comic over the phone. What's your name?",
  );

  const xml = `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><ConversationRelay url="${wsUrl}" welcomeGreeting="${greeting}" ttsProvider="Google" transcriptionProvider="Deepgram" language="en-US" interruptible="any"/></Connect></Response>`;

  return new Response(xml, { headers: { "Content-Type": "text/xml" } });
}
```

- [ ] **Step 2: Verify build**

Run: `pnpm build 2>&1 | grep -iE "Compiled successfully|Failed to compile"` and confirm the route exists:
```bash
grep -n "ConversationRelay\|validateTwilioSignature\|CONVERSATION_RELAY_WS_URL" app/api/twilio/voice/route.ts
```
Expected: Compiled successfully; all three present.

- [ ] **Step 3: Commit**

```bash
git add app/api/twilio/voice/route.ts
git commit -m "feat: voice webhook returns ConversationRelay TwiML

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `lib/voice-conversation.ts` — pure turn handler

**Files:**
- Create: `lib/voice-conversation.ts`
- Test: `lib/voice-conversation.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type VoiceStep = "awaiting_name" | "awaiting_prompt" | "done";
  export interface VoiceSession { step: VoiceStep; name?: string; prompt?: string; }
  export interface VoiceInbound { voicePrompt: string; }
  export interface VoiceReply {
    session: VoiceSession;
    // messages to send to Twilio, in order. text => {type:"text",...}; end => {type:"end",...}
    say?: string;           // a single text utterance (last:true) to speak
    endCall?: boolean;      // if true, send an {type:"end"} after `say`
    action: "none" | "enqueue_generation";
  }
  // Advances one turn given the caller's completed utterance (prompt with last:true).
  export function handleVoiceTurn(session: VoiceSession, inbound: VoiceInbound): VoiceReply;
  ```
  Pure — no ws, no network. The `setup` handling and welcomeGreeting live in the server (Task 4); this handles each caller utterance. Since the TwiML `welcomeGreeting` asks the name, the FIRST inbound prompt is the name.

- [ ] **Step 1: Write the failing test**

Create `lib/voice-conversation.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { handleVoiceTurn } from "@/lib/voice-conversation";

describe("handleVoiceTurn", () => {
  it("first utterance (name) → asks for the comic idea, no enqueue", () => {
    const r = handleVoiceTurn({ step: "awaiting_name" }, { voicePrompt: "Ada" });
    expect(r.session.step).toBe("awaiting_prompt");
    expect(r.session.name).toBe("Ada");
    expect(r.say).toMatch(/Ada/);
    expect(r.action).toBe("none");
    expect(r.endCall).toBeFalsy();
  });

  it("second utterance (prompt) → enqueues, confirms, ends the call", () => {
    const r = handleVoiceTurn(
      { step: "awaiting_prompt", name: "Ada" },
      { voicePrompt: "a robot detective in the rain" },
    );
    expect(r.session.step).toBe("done");
    expect(r.session.prompt).toBe("a robot detective in the rain");
    expect(r.action).toBe("enqueue_generation");
    expect(r.endCall).toBe(true);
    expect(r.say).toMatch(/text|phone|sent/i);
  });

  it("empty name utterance re-prompts, stays awaiting_name, no enqueue", () => {
    const r = handleVoiceTurn({ step: "awaiting_name" }, { voicePrompt: "   " });
    expect(r.session.step).toBe("awaiting_name");
    expect(r.action).toBe("none");
    expect(r.endCall).toBeFalsy();
  });

  it("empty prompt utterance re-prompts, stays awaiting_prompt", () => {
    const r = handleVoiceTurn({ step: "awaiting_prompt", name: "Ada" }, { voicePrompt: "" });
    expect(r.session.step).toBe("awaiting_prompt");
    expect(r.action).toBe("none");
    expect(r.endCall).toBeFalsy();
  });

  it("done step ignores further input without enqueuing again", () => {
    const r = handleVoiceTurn({ step: "done", name: "Ada", prompt: "x" }, { voicePrompt: "hello?" });
    expect(r.action).toBe("none");
    expect(r.endCall).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/voice-conversation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/voice-conversation.ts`**

```ts
export type VoiceStep = "awaiting_name" | "awaiting_prompt" | "done";

export interface VoiceSession {
  step: VoiceStep;
  name?: string;
  prompt?: string;
}

export interface VoiceInbound {
  voicePrompt: string;
}

export interface VoiceReply {
  session: VoiceSession;
  say?: string;
  endCall?: boolean;
  action: "none" | "enqueue_generation";
}

export function handleVoiceTurn(session: VoiceSession, inbound: VoiceInbound): VoiceReply {
  const text = (inbound.voicePrompt || "").trim();

  switch (session.step) {
    case "awaiting_name": {
      if (!text) {
        return {
          session,
          say: "Sorry, I didn't catch your name. What's your name?",
          action: "none",
        };
      }
      return {
        session: { ...session, step: "awaiting_prompt", name: text },
        say: `Nice to meet you, ${text}! Now describe the comic you'd like — a scene, characters, or a vibe.`,
        action: "none",
      };
    }
    case "awaiting_prompt": {
      if (!text) {
        return {
          session,
          say: "Tell me what the comic should be about.",
          action: "none",
        };
      }
      return {
        session: { ...session, step: "done", prompt: text },
        say: "Great! Your comic is being created now and will be texted to your phone in about a minute. Goodbye!",
        endCall: true,
        action: "enqueue_generation",
      };
    }
    case "done":
    default: {
      return {
        session,
        say: "Your comic is on its way by text. Goodbye!",
        endCall: true,
        action: "none",
      };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/voice-conversation.test.ts`
Expected: PASS (5 tests). Then full `pnpm test` (36 + 5 = 41).

- [ ] **Step 5: Commit**

```bash
git add lib/voice-conversation.ts lib/voice-conversation.test.ts
git commit -m "feat: pure voice-conversation turn handler

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `voice-server/` standalone WebSocket service

**Files:**
- Create: `voice-server/package.json`
- Create: `voice-server/tsconfig.json`
- Create: `voice-server/src/handler.ts` (message dispatch, testable — imports the pure turn handler + publish + rate limit)
- Create: `voice-server/src/server.ts` (ws server + handshake signature validation)
- Test: `voice-server/src/handler.test.ts`

**Interfaces:**
- `handler.ts` exports:
  ```ts
  export interface Session { step: "awaiting_name" | "awaiting_prompt" | "done"; name?: string; prompt?: string; from?: string; callSid?: string; }
  export interface OutMsg { type: "text" | "end"; token?: string; last?: boolean; handoffData?: string; }
  // Pure-ish: given the current session and an inbound Twilio message, returns the
  // updated session and the list of outbound messages to send. Side effects
  // (enqueue) are injected via `deps` so the function stays unit-testable.
  export async function dispatch(
    session: Session,
    msg: any,
    deps: { publish: (job: { phoneNumber: string; prompt: string; style?: string }) => Promise<void>; getRemaining: (id: string) => Promise<{ remaining: number }>; },
  ): Promise<{ session: Session; out: OutMsg[] }>;
  ```
- `server.ts` wires a real `ws` server: validates the handshake signature, holds a `Session` per connection, calls `dispatch` on each message with real `publishGenerationJob` + `freeTierRateLimit.getRemaining` (imported from the app's lib via a relative path or a small copy — see Step notes), and sends `out` messages over the socket.

**Design:** `dispatch` is the testable core. It handles `setup` (store `from`/`callSid`, no output since `welcomeGreeting` speaks first), `prompt` (only act on `last === true`; call `handleVoiceTurn`; on `enqueue_generation`, peek rate limit then publish; produce `text` + optional `end`), and `error` (log, no output).

- [ ] **Step 1: Create `voice-server/package.json`**

```json
{
  "name": "voice-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node --experimental-strip-types src/server.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "ws": "^8.18.0",
    "twilio": "^6.0.0",
    "@upstash/qstash": "^2.11.0",
    "@upstash/ratelimit": "^2.0.0",
    "@upstash/redis": "^1.38.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.0",
    "typescript": "^5",
    "vitest": "^4.0.0"
  }
}
```

> Note: this service has its own `node_modules`. The controller/user runs `pnpm install` inside `voice-server/` when deploying. The turn logic is re-implemented here as a local copy of `handleVoiceTurn` (voice-server is a separate package and cannot import from the Next app's `@/lib` alias). Keep the copy byte-identical to `lib/voice-conversation.ts`; the plan accepts this small duplication because the two live in different deployables. Alternatively, if a shared workspace package is set up, import it — but that is out of scope; copy is acceptable and noted.

- [ ] **Step 2: Create `voice-server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `voice-server/src/voice-conversation.ts` (local copy)**

Copy the FULL contents of `lib/voice-conversation.ts` (from Phase C Task 3) into `voice-server/src/voice-conversation.ts` verbatim. (Separate deployable; cannot use the `@/` alias.)

- [ ] **Step 4: Write the failing test `voice-server/src/handler.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatch, type Session } from "./handler.ts";

const deps = {
  publish: vi.fn(),
  getRemaining: vi.fn(),
};

beforeEach(() => {
  deps.publish.mockReset();
  deps.getRemaining.mockReset();
  deps.getRemaining.mockResolvedValue({ remaining: 3 });
  deps.publish.mockResolvedValue(undefined);
});

describe("dispatch", () => {
  it("setup stores from/callSid and emits nothing (welcomeGreeting speaks)", async () => {
    const { session, out } = await dispatch({ step: "awaiting_name" }, { type: "setup", from: "+15551112222", callSid: "CA1" }, deps);
    expect(session.from).toBe("+15551112222");
    expect(session.callSid).toBe("CA1");
    expect(out).toEqual([]);
  });

  it("ignores non-final prompt (last:false)", async () => {
    const { out } = await dispatch({ step: "awaiting_name", from: "+1" }, { type: "prompt", voicePrompt: "Ad", last: false }, deps);
    expect(out).toEqual([]);
  });

  it("first final prompt (name) asks for the idea, no publish", async () => {
    const { session, out } = await dispatch({ step: "awaiting_name", from: "+1" }, { type: "prompt", voicePrompt: "Ada", last: true }, deps);
    expect(session.step).toBe("awaiting_prompt");
    expect(out[0]).toMatchObject({ type: "text", last: true });
    expect(out.some((m) => m.type === "end")).toBe(false);
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it("second final prompt (idea) publishes and ends the call", async () => {
    const { session, out } = await dispatch(
      { step: "awaiting_prompt", from: "+15551112222", name: "Ada" },
      { type: "prompt", voicePrompt: "a robot detective", last: true },
      deps,
    );
    expect(deps.publish).toHaveBeenCalledWith({ phoneNumber: "+15551112222", prompt: "a robot detective", style: "noir" });
    expect(out.some((m) => m.type === "text")).toBe(true);
    expect(out.some((m) => m.type === "end")).toBe(true);
    expect(session.step).toBe("done");
  });

  it("over rate limit → speaks limit message, ends, does NOT publish", async () => {
    deps.getRemaining.mockResolvedValue({ remaining: 0 });
    const { out } = await dispatch(
      { step: "awaiting_prompt", from: "+15551112222", name: "Ada" },
      { type: "prompt", voicePrompt: "a robot detective", last: true },
      deps,
    );
    expect(deps.publish).not.toHaveBeenCalled();
    expect(out.some((m) => m.type === "end")).toBe(true);
    expect(out.find((m) => m.type === "text")?.token || "").toMatch(/limit/i);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `cd voice-server && npm install && npx vitest run src/handler.test.ts`
Expected: FAIL — `./handler.ts` not found. (If `npm install` is unavailable offline, report BLOCKED with the error; the implementer needs deps to run these.)

- [ ] **Step 6: Implement `voice-server/src/handler.ts`**

```ts
import { handleVoiceTurn, type VoiceSession } from "./voice-conversation.ts";

export interface Session {
  step: "awaiting_name" | "awaiting_prompt" | "done";
  name?: string;
  prompt?: string;
  from?: string;
  callSid?: string;
}

export interface OutMsg {
  type: "text" | "end";
  token?: string;
  last?: boolean;
  handoffData?: string;
}

export interface Deps {
  publish: (job: { phoneNumber: string; prompt: string; style?: string }) => Promise<void>;
  getRemaining: (id: string) => Promise<{ remaining: number }>;
}

export async function dispatch(
  session: Session,
  msg: any,
  deps: Deps,
): Promise<{ session: Session; out: OutMsg[] }> {
  switch (msg?.type) {
    case "setup": {
      return {
        session: { ...session, from: msg.from, callSid: msg.callSid },
        out: [],
      };
    }
    case "prompt": {
      if (msg.last !== true) return { session, out: [] };
      const turn = handleVoiceTurn(
        { step: session.step, name: session.name, prompt: session.prompt } as VoiceSession,
        { voicePrompt: msg.voicePrompt || "" },
      );
      const next: Session = { ...session, ...turn.session };
      const out: OutMsg[] = [];

      if (turn.action === "enqueue_generation" && turn.session.prompt && session.from) {
        const { remaining } = await deps.getRemaining(session.from);
        if (remaining <= 0) {
          out.push({
            type: "text",
            token: "You've reached the free limit of comics for this week. Please try again in a few days. Goodbye!",
            last: true,
          });
          out.push({ type: "end", handoffData: JSON.stringify({ reason: "rate_limited" }) });
          return { session: next, out };
        }
        await deps.publish({ phoneNumber: session.from, prompt: turn.session.prompt, style: "noir" });
      }

      if (turn.say) out.push({ type: "text", token: turn.say, last: true });
      if (turn.endCall) {
        out.push({
          type: "end",
          handoffData: JSON.stringify({ name: next.name, prompt: next.prompt }),
        });
      }
      return { session: next, out };
    }
    case "error": {
      console.error("ConversationRelay error:", msg.description);
      return { session, out: [] };
    }
    default:
      return { session, out: [] };
  }
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd voice-server && npx vitest run src/handler.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 8: Implement `voice-server/src/server.ts` (the socket glue — not unit tested)**

```ts
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import twilioSdk from "twilio";
import { Client } from "@upstash/qstash";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { createHash } from "node:crypto";
import { dispatch, type Session } from "./handler.ts";

const PORT = parseInt(process.env.PORT || "8080", 10);
const PUBLIC_WSS = process.env.CONVERSATION_RELAY_WS_URL || "";

const qstash = new Client({ token: process.env.QSTASH_TOKEN! });
const ratelimit = new Ratelimit({
  redis: new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! }),
  limiter: Ratelimit.fixedWindow(3, "7 d"),
  prefix: "ratelimit:free-comics",
});

const deps = {
  publish: async (job: { phoneNumber: string; prompt: string; style?: string }) => {
    const hash = createHash("sha256")
      .update(`${job.phoneNumber}:${job.prompt}:${job.style ?? ""}:`)
      .digest("hex")
      .slice(0, 16);
    await qstash.publishJSON({
      url: `${process.env.PUBLIC_BASE_URL?.replace(/\/$/, "")}/api/twilio/generate-worker`,
      body: { ...job, source: "voice" },
      deduplicationId: `${job.phoneNumber}-${hash}`,
      retries: 2,
    });
  },
  getRemaining: (id: string) => ratelimit.getRemaining(id),
};

const server = createServer();
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const sig = req.headers["x-twilio-signature"] as string | undefined;
  const ok = !!sig && twilioSdk.validateRequest(process.env.TWILIO_AUTH_TOKEN!, sig, PUBLIC_WSS, {});
  if (!ok) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  let session: Session = { step: "awaiting_name" };
  ws.on("message", async (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    try {
      const result = await dispatch(session, msg, deps);
      session = result.session;
      for (const out of result.out) ws.send(JSON.stringify(out));
    } catch (err) {
      console.error("dispatch error:", err);
    }
  });
});

server.listen(PORT, () => console.log(`voice-server listening on ${PORT}`));
```

- [ ] **Step 9: Typecheck + commit**

Run: `cd voice-server && npx tsc --noEmit` (expect no errors; if `@types/ws`/`@types/node` missing, they're in devDeps — ensure installed).
```bash
git add voice-server/package.json voice-server/tsconfig.json voice-server/src/
git commit -m "feat: standalone ConversationRelay websocket server

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Deployment scaffolding for the voice server

**Files:**
- Create: `voice-server/Dockerfile`
- Create: `voice-server/fly.toml`
- Create: `voice-server/.dockerignore`

**Interfaces:** none (ops config).

- [ ] **Step 1: `voice-server/Dockerfile`**

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["node", "--experimental-strip-types", "src/server.ts"]
```

- [ ] **Step 2: `voice-server/.dockerignore`**

```
node_modules
npm-debug.log
*.test.ts
```

- [ ] **Step 3: `voice-server/fly.toml`**

```toml
app = "makecomics-voice"
primary_region = "iad"

[build]

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1

[[vm]]
  size = "shared-cpu-1x"
```

> `auto_stop_machines = false` + `min_machines_running = 1` keep the process alive (a stopped machine would drop live calls). Env/secrets (`TWILIO_AUTH_TOKEN`, `QSTASH_TOKEN`, `UPSTASH_*`, `PUBLIC_BASE_URL`, `CONVERSATION_RELAY_WS_URL`) are set via `fly secrets set` — documented in the README (Task 6).

- [ ] **Step 4: Commit**

```bash
git add voice-server/Dockerfile voice-server/.dockerignore voice-server/fly.toml
git commit -m "chore: docker + fly deployment scaffolding for voice server

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Env + documentation

**Files:**
- Modify: `.example.env`
- Create: `voice-server/README.md`
- Modify: root `README.md`

- [ ] **Step 1: Add env var to `.example.env`**

Append:
```
# Twilio Voice (ConversationRelay) — the public wss:// URL of the voice-server
CONVERSATION_RELAY_WS_URL=
```

- [ ] **Step 2: Create `voice-server/README.md`**

Document: what it is (the ConversationRelay WS server), that it MUST run as a persistent process (not serverless), local run (`npm install && npm start`, expose via a tunnel like ngrok for testing → set `CONVERSATION_RELAY_WS_URL` to the wss URL), deploy (`fly launch`/`fly deploy`, `fly secrets set ...` for TWILIO_AUTH_TOKEN/QSTASH_TOKEN/UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN/PUBLIC_BASE_URL/CONVERSATION_RELAY_WS_URL), and the env vars it needs. Note it publishes to the SAME QStash worker as SMS, so the comic is delivered by text.

- [ ] **Step 3: Add a "Create comics by phone call" section to root `README.md`**

Describe: call the Twilio number → a voice assistant asks your name and comic idea → the comic is generated and texted to you. Setup:
1. Deploy the `voice-server/` (see its README) to a long-lived host; note its public `wss://` URL.
2. Set `CONVERSATION_RELAY_WS_URL` to that URL (in the Next app AND the voice-server).
3. Configure the Twilio number's **Voice webhook** → `<PUBLIC_BASE_URL>/api/twilio/voice` (HTTP POST).
4. **Accept the AI/ML Features Addendum** in Twilio Console → Voice → Settings → Privacy & Security (ConversationRelay returns error 64110 "Account Opted Out" without it).
5. The same Twilio number, QStash, and OpenAI setup from the SMS channel are reused.

- [ ] **Step 4: Commit**

```bash
git add .example.env README.md voice-server/README.md
git commit -m "docs: document voice (ConversationRelay) channel + env

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: End-to-end verification (automated portion)

**Files:** none.

- [ ] **Step 1: App test suite + build**

Run: `pnpm test` (expect 41: 36 + 5 voice-conversation) and `pnpm build 2>&1 | grep -iE "Compiled successfully|Failed to compile"`.
Expected: all pass; Compiled successfully.

- [ ] **Step 2: Voice-server tests + typecheck**

Run: `cd voice-server && npx vitest run && npx tsc --noEmit`.
Expected: handler tests pass (5); no type errors.

- [ ] **Step 3: Route + server inventory**

Run:
```bash
ls app/api/twilio/voice/route.ts voice-server/src/server.ts voice-server/src/handler.ts voice-server/Dockerfile
grep -n "ConversationRelay" app/api/twilio/voice/route.ts
grep -n "validateRequest\|x-twilio-signature" voice-server/src/server.ts
```
Expected: all exist; ConversationRelay TwiML present; signature validation present on the WS upgrade.

- [ ] **Step 4: Document user/manual steps**

Record in the final report (cannot be automated here): deploy voice-server to a long-lived host; set `CONVERSATION_RELAY_WS_URL`; configure the Voice webhook; accept the AI/ML addendum; live call test.

---

## Self-Review

**Spec coverage (design §4.6 Voice / phase 2):**
- Voice webhook → ConversationRelay TwiML → Task 2. ✔
- Standalone persistent WS server (not serverless) → Tasks 4, 5. ✔
- Twilio does STT/TTS; server exchanges text; scripted name→prompt→enqueue→end → Tasks 3, 4. ✔
- Signature validation on WS handshake → Task 4 (server.ts upgrade handler). ✔
- Reuses the same generation job + SMS/MMS delivery (source `voice`) → Task 4 deps.publish. ✔
- Server-funded + rate-limit peek before enqueue → Task 4 dispatch. ✔
- publishGenerationJob importable without Next `/nextjs` subpath → Task 1 split. ✔
- AI/ML addendum + voice webhook config documented → Task 6. ✔

**Placeholder scan:** none — every code step has complete code.

**Type consistency:** `handleVoiceTurn`/`VoiceSession` identical in Task 3 (lib) and the Task 4 copy. `dispatch` signature + `Deps` identical in Task 4 impl and test. `publishGenerationJob` job shape (`phoneNumber`, `prompt`, `style`, `source`) matches the Phase B `GenerationJob` the worker parses.

**Known intentional duplication:** `voice-conversation.ts` is copied into `voice-server/src/` because the voice server is a separate deployable that can't use the Next `@/` alias. Flagged in Task 4 Step 1. Acceptable; the shared-workspace-package alternative is out of scope.

**Deferred / user-only:** deploying the WS server, accepting the AI/ML addendum, configuring the Voice webhook, and the live call test require the user's Twilio account + a host.
