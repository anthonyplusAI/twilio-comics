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
  load: (from: string) => Promise<VoiceConversationSnapshot>;
  save: (
    previous: VoiceConversationSnapshot,
    update: VoiceConversationUpdate,
  ) => Promise<VoiceConversationSnapshot | null>;
  advance: (current: ComicAgentCurrent, turn: ComicAgentTurn) => Promise<ComicAgentResult>;
  identity: (from: string) => Promise<{ userId: string }>;
  submit: (input: VoiceSubmitInput) => Promise<{ accepted: boolean; job: { status: string } }>;
  lookupJob: (idempotencyKey: string) => Promise<{ status: string } | null>;
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
}

export interface VoiceRelaySession {
  handle: (message: VoiceRelayInbound, receivedAt?: number) => Promise<VoiceRelayOutbound[]>;
  close: () => void;
}

type EndResult = "queued" | "quota_rejected" | "checking" | "invalid_setup" | "stale" | "service_error";

const DUPLICATE_FINAL_WINDOW_MS = 1_500;
const TWILIO_CALL_SID = /^CA[0-9a-f]{32}$/i;
const E164 = /^\+[1-9]\d{6,14}$/;

function text(token: string): VoiceRelayOutbound[] {
  return [{ type: "text", token, last: true }];
}

function end(result: EndResult): VoiceRelayOutbound[] {
  return [{ type: "end", handoffData: JSON.stringify({ result }) }];
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
  let turn = 0;
  let lastFinalText: string | undefined;
  let lastFinalAt = -Infinity;
  let approvalKey: string | undefined;

  async function handle(message: VoiceRelayInbound, receivedAt = Date.now()): Promise<VoiceRelayOutbound[]> {
    if (closed || ended) return [];

    if (message.type === "setup") {
      if (snapshot) {
        if (message.callSid === callSid && message.from === from) return [];
        ended = true;
        return end("invalid_setup");
      }
      if (
        message.accountSid !== deps.expectedAccountSid ||
        !message.callSid || !TWILIO_CALL_SID.test(message.callSid) ||
        !message.from || !E164.test(message.from) ||
        !message.to || !E164.test(message.to) ||
        !E164.test(deps.senderAddress)
      ) {
        ended = true;
        return end("invalid_setup");
      }
      try {
        snapshot = await deps.load(message.from);
      } catch (error) {
        deps.onError?.("voice conversation load failed", error);
        ended = true;
        return end("service_error");
      }
      callSid = message.callSid;
      from = message.from;
      to = message.to;
      return [];
    }

    if (message.type !== "prompt" || message.last !== true) return [];
    if (!snapshot || !callSid || !from || !to) {
      ended = true;
      return end("invalid_setup");
    }

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
    } catch (error) {
      deps.onError?.("voice agent failed", error);
      lastFinalText = undefined;
      return text("I had trouble with that idea. Please say it again and I'll try again.");
    }

    if (advanced.action === "submit") {
      if (!advanced.submission) {
        deps.onError?.("voice agent omitted submission", new Error("Missing submission"));
        lastFinalText = undefined;
        return text("I couldn't start your comic. Please say create it again to try again.");
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
          ended = true;
          return end("stale");
        }
        snapshot = saved;
      } catch (error) {
        deps.onError?.("voice submission checkpoint failed", error);
        lastFinalText = undefined;
        return text("I couldn't save your request. Please say create it again to try again.");
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
          ended = true;
          return end("queued");
        }
        if (jobStatus === null || jobStatus === "quota_rejected" || jobStatus === "failed") {
          if (await rollback()) {
            if (jobStatus === "quota_rejected") {
              ended = true;
              return end("quota_rejected");
            }
            if (jobStatus === "failed") approvalKey = undefined;
            lastFinalText = undefined;
            return text("I couldn't start your comic yet. Please say create it again to try again.");
          }
        }
        ended = true;
        return end("checking");
      }
      if (!submission.accepted) {
        const status = submission.job.status;
        // A pending job may still be published by recovery or claimed by a
        // worker. Keep its request key so completion can update this draft.
        if (status !== "quota_rejected" && status !== "failed") {
          ended = true;
          return end(["queued", "processing", "succeeded"].includes(status) ? "queued" : "checking");
        }
        if (!(await rollback())) {
          ended = true;
          return end("checking");
        }
        if (status === "quota_rejected") {
          ended = true;
          return end("quota_rejected");
        }
        approvalKey = undefined;
        lastFinalText = undefined;
        return text("That comic attempt failed. Please say create it again to try again.");
      }
      ended = true;
      return end("queued");
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
        ended = true;
        return end("stale");
      }
      snapshot = saved;
    } catch (error) {
      deps.onError?.("voice conversation save failed", error);
      lastFinalText = undefined;
      return text("I couldn't save that idea. Please say it again to try again.");
    }
    return text(advanced.reply);
  }

  return {
    handle,
    close: () => { closed = true; },
  };
}
