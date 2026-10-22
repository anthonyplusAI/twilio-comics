import type {
  AgentCollected,
  ComicAgentCurrent,
  ComicAgentResult,
  ComicAgentTurn,
} from "@/lib/comic-agent";

/** The live call keeps this snapshot and saves each completed user turn. */
export interface VoiceConversationSnapshot {
  id: string;
  state: string;
  collected: AgentCollected;
  activeStoryId: string | null;
  updatedAt: Date;
}

export interface VoiceConversationUpdate {
  state: string;
  collected: AgentCollected;
  activeStoryId: string | null;
}

export interface VoiceSubmitInput {
  idempotencyKey: string;
  userId: string;
  source: "voice";
  recipientAddress: string;
  senderAddress: string;
  prompt: string;
  style: string;
  characterImageUrls: string[];
  targetStoryId?: string;
}

export interface VoiceRelayDependencies {
  expectedAccountSid: string;
  senderAddress: string;
  authorizeCall: (input: {
    callSid: string;
    from: string;
    to: string;
    authorization: string;
  }) => boolean | Promise<boolean>;
  load: (from: string) => Promise<VoiceConversationSnapshot>;
  save: (
    previous: VoiceConversationSnapshot,
    update: VoiceConversationUpdate,
  ) => Promise<VoiceConversationSnapshot | null>;
  advance: (current: ComicAgentCurrent, turn: ComicAgentTurn) => Promise<ComicAgentResult>;
  identity: (from: string) => Promise<{ userId: string }>;
  submit: (input: VoiceSubmitInput) => Promise<{ accepted: boolean; job: { status: string } }>;
  lookupJob: (idempotencyKey: string) => Promise<{ status: string } | null>;
  onCallStart?: (event: { callSid: string; from: string; to: string }) => Promise<void>;
  onTurn?: (event: {
    callSid: string;
    from: string;
    sequence: number;
    role: "caller" | "agent";
    content: string;
  }) => Promise<void>;
  onError?: (context: string, error: unknown) => void;
}

export type VoiceRelayOutbound =
  | { type: "text"; token: string; last: true }
  | { type: "end"; handoffData: string };

export interface VoiceRelayInbound {
  type?: string;
  accountSid?: string;
  callSid?: string;
  from?: string;
  to?: string;
  last?: boolean;
  voicePrompt?: string;
  customParameters?: Record<string, unknown>;
}

export interface VoiceRelaySession {
  handle: (message: VoiceRelayInbound, receivedAt?: number) => Promise<VoiceRelayOutbound[]>;
  close: () => void;
  timeout: () => VoiceRelayOutbound[];
}

type EndResult = "queued" | "quota_rejected" | "checking" | "invalid_setup" | "stale" | "service_error" | "limit_reached";

const DUPLICATE_FINAL_WINDOW_MS = 1_500;
const MAX_VOICE_TURNS = 20;
const MAX_VOICE_SESSION_MS = 10 * 60_000;
const TWILIO_CALL_SID = /^CA[0-9a-f]{32}$/i;
const TWILIO_ACCOUNT_SID = /^AC[0-9a-f]{32}$/i;
const E164 = /^\+[1-9]\d{6,14}$/;

function text(token: string): VoiceRelayOutbound[] {
  return [{ type: "text", token, last: true }];
}

function end(result: EndResult, turn: number): VoiceRelayOutbound[] {
  return [{ type: "end", handoffData: JSON.stringify({ result, turn }) }];
}

function draftFingerprint(collected: AgentCollected): string {
  return JSON.stringify({
    prompt: collected.prompt,
    style: collected.style,
    characterImageUrls: collected.characterImageUrls,
    targetStoryId: collected.targetStoryId,
  });
}

/** One controller per signed ConversationRelay WebSocket. The server serializes its events. */
export function createVoiceRelaySession(deps: VoiceRelayDependencies): VoiceRelaySession {
  let closed = false;
  let ended = false;
  let callSid: string | undefined;
  let from: string | undefined;
  let to: string | undefined;
  let snapshot: VoiceConversationSnapshot | undefined;
  let startedAt: number | undefined;
  let turn = 0;
  let lastFinalText: string | undefined;
  let lastFinalAt = -Infinity;
  let approvalKey: string | undefined;
  let handling = 0;
  let timeoutPending = false;

  function finish(result: EndResult): VoiceRelayOutbound[] {
    ended = true;
    return end(result, turn);
  }

  async function recordTurn(role: "caller" | "agent", content: string): Promise<boolean> {
    if (!callSid || !from || turn < 1) return true;
    try {
      await deps.onTurn?.({ callSid, from, sequence: turn, role, content });
      return true;
    } catch (error) {
      deps.onError?.("voice turn history failed", error);
      return false;
    }
  }

  async function speak(token: string): Promise<VoiceRelayOutbound[]> {
    if (closed || timeoutPending) return [];
    await recordTurn("agent", token);
    return closed || timeoutPending ? [] : text(token);
  }

  async function processMessage(message: VoiceRelayInbound, receivedAt: number): Promise<VoiceRelayOutbound[]> {
    if (closed || ended) return [];

    if (message.type === "setup") {
      if (snapshot) {
        if (message.callSid === callSid && message.from === from) return [];
        return finish("invalid_setup");
      }
      if (
        !TWILIO_ACCOUNT_SID.test(deps.expectedAccountSid) ||
        message.accountSid !== deps.expectedAccountSid ||
        !message.callSid || !TWILIO_CALL_SID.test(message.callSid) ||
        !message.from || !E164.test(message.from) ||
        !message.to || !E164.test(message.to) ||
        !E164.test(deps.senderAddress)
      ) {
        return finish("invalid_setup");
      }
      const authorization = message.customParameters?.authorization;
      if (typeof authorization !== "string" || !authorization || authorization.length > 100) {
        return finish("invalid_setup");
      }
      try {
        if (!(await deps.authorizeCall({
          callSid: message.callSid,
          from: message.from,
          to: message.to,
          authorization,
        }))) {
          return finish("invalid_setup");
        }
      } catch (error) {
        deps.onError?.("voice call authorization failed", error);
        return finish("invalid_setup");
      }
      try {
        snapshot = await deps.load(message.from);
      } catch (error) {
        deps.onError?.("voice conversation load failed", error);
        return finish("service_error");
      }
      callSid = message.callSid;
      from = message.from;
      to = message.to;
      startedAt = receivedAt;
      try {
        await deps.onCallStart?.({ callSid, from, to });
      } catch (error) {
        deps.onError?.("voice call history failed", error);
      }
      return [];
    }

    if (message.type !== "prompt" || message.last !== true) return [];
    if (!snapshot || !callSid || !from || !to) {
      return finish("invalid_setup");
    }

    if (startedAt !== undefined && receivedAt - startedAt >= MAX_VOICE_SESSION_MS) {
      return finish("limit_reached");
    }
    if (turn >= MAX_VOICE_TURNS) return finish("limit_reached");

    const utterance = (message.voicePrompt || "").trim();
    if (!utterance) {
      return text("I didn't catch that. Please say your comic idea or tell me what to change.");
    }
    const normalized = utterance.toLowerCase().replace(/\s+/g, " ");
    if (
      normalized === lastFinalText &&
      receivedAt >= lastFinalAt &&
      receivedAt - lastFinalAt < DUPLICATE_FINAL_WINDOW_MS
    ) {
      return [];
    }
    lastFinalText = normalized;
    lastFinalAt = receivedAt;
    turn += 1;
    if (!(await recordTurn("caller", utterance))) {
      return closed ? [] : finish("service_error");
    }
    if (closed) return [];

    let advanced: ComicAgentResult;
    try {
      advanced = await deps.advance(
        {
          state: snapshot.state,
          collected: snapshot.collected,
          activeStoryId: snapshot.activeStoryId,
        },
        { text: utterance, channel: "voice" },
      );
      if (closed || ended) return [];
    } catch (error) {
      deps.onError?.("voice agent failed", error);
      lastFinalText = undefined;
      return speak("I had trouble with that idea. Please say it again and I'll try again.");
    }

    if (advanced.action === "submit") {
      if (!advanced.submission) {
        deps.onError?.("voice agent omitted submission", new Error("Missing submission"));
        lastFinalText = undefined;
        return speak("I couldn't start your comic. Please say create it again to try again.");
      }
      approvalKey ||= `twilio-call:${callSid}:turn:${turn}`;
      const beforeSubmission = snapshot;
      try {
        const saved = await deps.save(snapshot, {
          state: "generating",
          collected: { ...advanced.collected, generationRequestKey: approvalKey },
          activeStoryId: advanced.activeStoryId,
        });
        if (!saved) {
          return finish("stale");
        }
        snapshot = saved;
      } catch (error) {
        deps.onError?.("voice submission checkpoint failed", error);
        lastFinalText = undefined;
        return speak("I couldn't save your request. Please say create it again to try again.");
      }

      async function rollback(): Promise<boolean> {
        try {
          const restored = await deps.save(snapshot!, {
            state: beforeSubmission.state,
            collected: beforeSubmission.collected,
            activeStoryId: beforeSubmission.activeStoryId,
          });
          if (!restored) return false;
          snapshot = restored;
          return true;
        } catch (error) {
          deps.onError?.("voice submission rollback failed", error);
          return false;
        }
      }

      let submission: { accepted: boolean; job: { status: string } };
      try {
        const identity = await deps.identity(from);
        submission = await deps.submit({
          idempotencyKey: approvalKey,
          userId: identity.userId,
          source: "voice",
          recipientAddress: from,
          senderAddress: deps.senderAddress,
          prompt: advanced.submission.prompt,
          style: advanced.submission.style,
          characterImageUrls: advanced.submission.characterImageUrls,
          ...(advanced.submission.targetStoryId
            ? { targetStoryId: advanced.submission.targetStoryId }
            : {}),
        });
      } catch (error) {
        deps.onError?.("voice generation enqueue failed", error);
        let jobStatus: string | null | undefined;
        try {
          jobStatus = (await deps.lookupJob(approvalKey))?.status ?? null;
        } catch (lookupError) {
          deps.onError?.("voice job status lookup failed", lookupError);
        }
        if (["queued", "processing", "succeeded"].includes(jobStatus || "")) {
          return finish("queued");
        }
        if (jobStatus === null || jobStatus === "quota_rejected" || jobStatus === "failed") {
          if (await rollback()) {
            if (jobStatus === "quota_rejected") {
              return finish("quota_rejected");
            }
            if (jobStatus === "failed") approvalKey = undefined;
            lastFinalText = undefined;
            return speak("I couldn't start your comic yet. Please say create it again to try again.");
          }
        }
        return finish("checking");
      }
      if (!submission.accepted) {
        const status = submission.job.status;
        // A pending job may still be published by recovery or claimed by a
        // worker. Keep its request key so completion can update this draft.
        if (status !== "quota_rejected" && status !== "failed") {
          return finish(["queued", "processing", "succeeded"].includes(status) ? "queued" : "checking");
        }
        if (!(await rollback())) {
          return finish("checking");
        }
        if (status === "quota_rejected") {
          return finish("quota_rejected");
        }
        approvalKey = undefined;
        lastFinalText = undefined;
        return speak("That comic attempt failed. Please say create it again to try again.");
      }
      return finish("queued");
    }

    if (draftFingerprint(snapshot.collected) !== draftFingerprint(advanced.collected)) {
      approvalKey = undefined;
    }
    try {
      const saved = await deps.save(snapshot, {
        state: advanced.nextState,
        collected: advanced.collected,
        activeStoryId: advanced.activeStoryId,
      });
      if (!saved) {
        return finish("stale");
      }
      snapshot = saved;
    } catch (error) {
      deps.onError?.("voice conversation save failed", error);
      lastFinalText = undefined;
      return speak("I couldn't save that idea. Please say it again to try again.");
    }
    return speak(advanced.reply);
  }

  async function handle(message: VoiceRelayInbound, receivedAt = Date.now()): Promise<VoiceRelayOutbound[]> {
    if (closed || ended || timeoutPending) return [];
    handling += 1;
    try {
      return await processMessage(message, receivedAt);
    } finally {
      handling -= 1;
    }
  }

  return {
    handle,
    close: () => { closed = true; },
    timeout: () => {
      if (closed || ended) return [];
      timeoutPending = true;
      return handling > 0 ? [] : finish("limit_reached");
    },
  };
}
