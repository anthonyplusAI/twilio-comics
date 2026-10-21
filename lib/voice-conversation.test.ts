import { describe, expect, it } from "vitest";
import * as voice from "@/lib/voice-conversation";
import {
  advanceComicAgent,
  type AgentCollected,
  type ComicAgentModel,
} from "@/lib/comic-agent";

const ACCOUNT_SID = `AC${"a".repeat(32)}`;
const CALL_SID = `CA${"b".repeat(32)}`;
const FROM = "+15551234567";
const TO = "+15557654321";
const SMS_FROM = "+15550001111";
const STORY_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";

type Stored = {
  id: string;
  state: string;
  collected: AgentCollected;
  activeStoryId: string | null;
  updatedAt: Date;
};

type RelaySession = {
  handle: (message: Record<string, unknown>, receivedAt?: number) => Promise<Array<Record<string, unknown>>>;
  close: () => void;
};

type RelayFactory = (deps: Record<string, unknown>) => RelaySession;

const setup = {
  type: "setup",
  accountSid: ACCOUNT_SID,
  callSid: CALL_SID,
  sessionId: `VX${"c".repeat(32)}`,
  from: FROM,
  to: TO,
};

const model: ComicAgentModel = async (input) => {
  const last = input.history.at(-1)?.content || "";
  if (last === "yes, but add a dragon") {
    return {
      reply: "The detective and a dragon chase the thief.",
      prompt: "A robot detective and a dragon chase a thief in the rain",
      style: "manga",
      readyForConfirmation: true,
    };
  }
  return {
    reply: `A comic about ${last}.`,
    prompt: last,
    style: "manga",
    readyForConfirmation: true,
  };
};

function harness(overrides: {
  initial?: Partial<Stored>;
  model?: ComicAgentModel;
  submit?: (input: Record<string, unknown>) => Promise<{ accepted: boolean; job: { id: string; status: string } }>;
  lookupJob?: (key: string) => Promise<{ status: string } | null>;
} = {}) {
  let row: Stored = {
    id: "voice-conversation",
    state: "collecting",
    collected: {},
    activeStoryId: null,
    updatedAt: new Date(1_000),
    ...overrides.initial,
  };
  const submitted: Array<Record<string, unknown>> = [];
  const atSubmit: Stored[] = [];
  const activeModel = overrides.model || model;
  const deps = {
    expectedAccountSid: ACCOUNT_SID,
    senderAddress: SMS_FROM,
    load: async (from: string) => {
      expect(from).toBe(FROM);
      row.updatedAt = new Date(row.updatedAt.getTime() + 1);
      return structuredClone(row);
    },
    save: async (previous: Stored, next: Pick<Stored, "state" | "collected" | "activeStoryId">) => {
      if (previous.updatedAt.getTime() !== row.updatedAt.getTime()) return null;
      row = { ...row, ...next, updatedAt: new Date(row.updatedAt.getTime() + 1) };
      return structuredClone(row);
    },
    advance: (current: { state: string; collected: AgentCollected; activeStoryId: string | null }, turn: { text: string; channel: "voice" }) =>
      advanceComicAgent(current, turn, activeModel),
    identity: async (from: string) => {
      expect(from).toBe(FROM);
      return { userId: "voice-user" };
    },
    submit: async (input: Record<string, unknown>) => {
      submitted.push(input);
      atSubmit.push(structuredClone(row));
      return overrides.submit ? overrides.submit(input) : { accepted: true, job: { id: JOB_ID, status: "queued" } };
    },
    lookupJob: overrides.lookupJob || (async () => null),
  };
  const create = () => {
    const factory = (voice as unknown as { createVoiceRelaySession?: RelayFactory }).createVoiceRelaySession;
    expect(factory).toBeTypeOf("function");
    return factory!(deps);
  };
  return {
    create,
    submitted,
    atSubmit,
    completeExternally: () => {
      row = {
        ...row,
        state: "done",
        collected: {},
        activeStoryId: STORY_ID,
        updatedAt: new Date(row.updatedAt.getTime() + 1),
      };
    },
    get row() { return structuredClone(row); },
  };
}

function resultCode(messages: Array<Record<string, unknown>>): string | undefined {
  const end = messages.find((message) => message.type === "end");
  return end && typeof end.handoffData === "string"
    ? (JSON.parse(end.handoffData) as { result?: string }).result
    : undefined;
}

describe("ConversationRelay voice conversation", () => {
  it("treats the first utterance as an idea, lets the caller revise, and submits only after spoken approval", async () => {
    const h = harness();
    const session = h.create();
    expect(await session.handle(setup, 1_000)).toEqual([]);

    const first = await session.handle({ type: "prompt", last: true, voicePrompt: "A robot detective in the rain" }, 2_000);
    expect(first).toEqual([{ type: "text", token: expect.stringMatching(/robot detective/i), last: true }]);
    expect(h.row.state).toBe("confirming");
    expect(h.submitted).toHaveLength(0);

    const revision = await session.handle({ type: "prompt", last: true, voicePrompt: "yes, but add a dragon" }, 5_000);
    expect(revision).toEqual([{ type: "text", token: expect.stringMatching(/dragon/i), last: true }]);
    expect(h.row.collected.prompt).toMatch(/dragon/);
    expect(h.submitted).toHaveLength(0);

    const approved = await session.handle({ type: "prompt", last: true, voicePrompt: "create it" }, 8_000);
    expect(resultCode(approved)).toBe("queued");
    expect(h.row.state).toBe("generating");
    expect((h.row.collected as AgentCollected & { generationRequestKey?: string }).generationRequestKey).toBe(`twilio-call:${CALL_SID}:turn:3`);
    expect(h.atSubmit[0].state).toBe("generating");
    expect((h.atSubmit[0].collected as AgentCollected & { generationRequestKey?: string }).generationRequestKey).toBe(`twilio-call:${CALL_SID}:turn:3`);
    expect(h.submitted).toEqual([expect.objectContaining({
      idempotencyKey: `twilio-call:${CALL_SID}:turn:3`,
      userId: "voice-user",
      source: "voice",
      recipientAddress: FROM,
      senderAddress: SMS_FROM,
      prompt: "A robot detective and a dragon chase a thief in the rain",
      style: "manga",
      characterImageUrls: [],
    })]);
  });

  it("ignores partial prompts and duplicate final transcripts", async () => {
    const h = harness();
    const session = h.create();
    await session.handle(setup, 1_000);
    expect(await session.handle({ type: "prompt", last: false, voicePrompt: "A robot" }, 2_000)).toEqual([]);
    const final = { type: "prompt", last: true, voicePrompt: "A robot detective in the rain" };
    expect(await session.handle(final, 2_100)).toHaveLength(1);
    expect(await session.handle(final, 2_200)).toEqual([]);
    expect(h.row.collected.messages).toHaveLength(2);
  });

  it("keeps the same approval key when job creation fails and the caller retries", async () => {
    let attempts = 0;
    const h = harness({ lookupJob: async () => null, submit: async () => {
      attempts++;
      if (attempts === 1) throw new Error("Database insert failed");
      return { accepted: true, job: { id: JOB_ID, status: "queued" } };
    } });
    const session = h.create();
    await session.handle(setup, 1_000);
    await session.handle({ type: "prompt", last: true, voicePrompt: "A robot detective" }, 2_000);

    const failed = await session.handle({ type: "prompt", last: true, voicePrompt: "create it" }, 5_000);
    expect(failed).toEqual([{ type: "text", token: expect.stringMatching(/try again/i), last: true }]);
    expect(h.row.state).toBe("confirming");
    expect((h.row.collected as AgentCollected & { generationRequestKey?: string }).generationRequestKey).toBeUndefined();

    const retried = await session.handle({ type: "prompt", last: true, voicePrompt: "create it" }, 8_000);
    expect(resultCode(retried)).toBe("queued");
    expect(h.row.state).toBe("generating");
    expect(h.atSubmit.map((row) => row.state)).toEqual(["generating", "generating"]);
    expect(h.submitted.map((input) => input.idempotencyKey)).toEqual([
      `twilio-call:${CALL_SID}:turn:2`,
      `twilio-call:${CALL_SID}:turn:2`,
    ]);
  });

  it("does not move to generating when the free quota is exhausted", async () => {
    const h = harness({ submit: async () => ({ accepted: false, job: { id: JOB_ID, status: "quota_rejected" } }) });
    const session = h.create();
    await session.handle(setup, 1_000);
    await session.handle({ type: "prompt", last: true, voicePrompt: "A robot detective" }, 2_000);

    const approved = await session.handle({ type: "prompt", last: true, voicePrompt: "create it" }, 5_000);
    expect(resultCode(approved)).toBe("quota_rejected");
    expect(h.row.state).toBe("confirming");
    expect((h.row.collected as AgentCollected & { generationRequestKey?: string }).generationRequestKey).toBeUndefined();
  });

  it.each(["pending", "enqueue_failed"])("keeps a %s job checkpoint for recovery", async (status) => {
    const h = harness({
      submit: async () => { throw new Error("Queue request timed out"); },
      lookupJob: async () => ({ status }),
    });
    const session = h.create();
    await session.handle(setup, 1_000);
    await session.handle({ type: "prompt", last: true, voicePrompt: "A robot detective" }, 2_000);

    const response = await session.handle({ type: "prompt", last: true, voicePrompt: "create it" }, 5_000);
    expect(resultCode(response)).toBe("checking");
    expect(h.row.state).toBe("generating");
    expect((h.row.collected as AgentCollected & { generationRequestKey?: string }).generationRequestKey).toBe(`twilio-call:${CALL_SID}:turn:2`);
  });

  it("keeps the checkpoint when a retryable job is returned as unaccepted", async () => {
    const h = harness({ submit: async () => ({ accepted: false, job: { id: JOB_ID, status: "pending" } }) });
    const session = h.create();
    await session.handle(setup, 1_000);
    await session.handle({ type: "prompt", last: true, voicePrompt: "A robot detective" }, 2_000);

    const response = await session.handle({ type: "prompt", last: true, voicePrompt: "create it" }, 5_000);
    expect(resultCode(response)).toBe("checking");
    expect(h.row.state).toBe("generating");
    expect(h.row.collected.generationRequestKey).toBe(`twilio-call:${CALL_SID}:turn:2`);
  });

  it("keeps a queued job after submit reports an ambiguous error", async () => {
    const h = harness({
      submit: async () => { throw new Error("Queue response lost"); },
      lookupJob: async () => ({ status: "queued" }),
    });
    const session = h.create();
    await session.handle(setup, 1_000);
    await session.handle({ type: "prompt", last: true, voicePrompt: "A robot detective" }, 2_000);

    const response = await session.handle({ type: "prompt", last: true, voicePrompt: "create it" }, 5_000);
    expect(resultCode(response)).toBe("queued");
    expect(h.row.state).toBe("generating");
  });

  it("lets the caller retry a permanently failed job with a new approval key", async () => {
    let attempts = 0;
    const h = harness({ submit: async () => {
      attempts++;
      return attempts === 1
        ? { accepted: false, job: { id: JOB_ID, status: "failed" } }
        : { accepted: true, job: { id: "new-job", status: "queued" } };
    } });
    const session = h.create();
    await session.handle(setup, 1_000);
    await session.handle({ type: "prompt", last: true, voicePrompt: "A robot detective" }, 2_000);

    const failed = await session.handle({ type: "prompt", last: true, voicePrompt: "create it" }, 5_000);
    expect(failed).toEqual([{ type: "text", token: expect.stringMatching(/try again/i), last: true }]);
    expect(h.row.state).toBe("confirming");
    expect(resultCode(await session.handle({ type: "prompt", last: true, voicePrompt: "create it" }, 8_000))).toBe("queued");
    expect(h.submitted[1].idempotencyKey).not.toBe(h.submitted[0].idempotencyKey);
  });

  it("does not overwrite a completed story when the worker finishes before submit returns", async () => {
    const completeWorker: { run?: () => void } = {};
    const h = harness({ submit: async () => {
      completeWorker.run?.();
      return { accepted: true, job: { id: JOB_ID, status: "succeeded" } };
    } });
    completeWorker.run = h.completeExternally;
    const session = h.create();
    await session.handle(setup, 1_000);
    await session.handle({ type: "prompt", last: true, voicePrompt: "A robot detective" }, 2_000);

    expect(resultCode(await session.handle({ type: "prompt", last: true, voicePrompt: "create it" }, 5_000))).toBe("queued");
    expect(h.atSubmit[0].state).toBe("generating");
    expect(h.row.state).toBe("done");
    expect(h.row.activeStoryId).toBe(STORY_ID);
  });

  it("keeps the draft available after a model failure", async () => {
    let calls = 0;
    const h = harness({ model: async (input) => {
      calls++;
      if (calls === 1) throw new Error("OpenAI timeout");
      return model(input);
    } });
    const session = h.create();
    await session.handle(setup, 1_000);

    const failed = await session.handle({ type: "prompt", last: true, voicePrompt: "A robot detective" }, 2_000);
    expect(failed).toEqual([{ type: "text", token: expect.stringMatching(/try again/i), last: true }]);
    expect(h.row.state).toBe("collecting");

    await session.handle({ type: "prompt", last: true, voicePrompt: "A robot detective" }, 5_000);
    expect(h.row.state).toBe("confirming");
  });

  it("rejects missing setup identity and does not load a conversation", async () => {
    const h = harness();
    const session = h.create();
    expect(resultCode(await session.handle({ type: "prompt", last: true, voicePrompt: "A comic" }, 1_000))).toBe("invalid_setup");
    expect(h.row.updatedAt.getTime()).toBe(1_000);
  });

  it("does not let an older call overwrite a newer call", async () => {
    const h = harness();
    const older = h.create();
    await older.handle(setup, 1_000);
    const newer = h.create();
    await newer.handle({ ...setup, callSid: `CA${"d".repeat(32)}` }, 1_500);

    const stale = await older.handle({ type: "prompt", last: true, voicePrompt: "An old comic" }, 2_000);
    expect(resultCode(stale)).toBe("stale");
    expect(h.row.state).toBe("collecting");

    await newer.handle({ type: "prompt", last: true, voicePrompt: "A new comic" }, 3_000);
    expect(h.row.collected.prompt).toBe("A new comic");
  });

  it("loads a completed story and carries its ID into a continued page", async () => {
    const h = harness({ initial: { state: "done", activeStoryId: STORY_ID } });
    const session = h.create();
    await session.handle(setup, 1_000);
    const continueReply = await session.handle({ type: "prompt", last: true, voicePrompt: "continue" }, 2_000);
    expect(continueReply).toEqual([{ type: "text", token: expect.stringMatching(/next page/i), last: true }]);
    expect(h.row.collected.targetStoryId).toBe(STORY_ID);

    await session.handle({ type: "prompt", last: true, voicePrompt: "The detective reaches Mars" }, 5_000);
    const approved = await session.handle({ type: "prompt", last: true, voicePrompt: "create it" }, 8_000);
    expect(resultCode(approved)).toBe("queued");
    expect(h.submitted[0].targetStoryId).toBe(STORY_ID);
  });

  it("stops handling new turns after the WebSocket closes", async () => {
    const h = harness();
    const session = h.create();
    await session.handle(setup, 1_000);
    session.close();
    expect(await session.handle({ type: "prompt", last: true, voicePrompt: "A robot" }, 2_000)).toEqual([]);
    expect(h.row.state).toBe("collecting");
  });
});
