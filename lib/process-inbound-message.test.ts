import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getInboundMessage: vi.fn(),
  claimConversationLease: vi.fn(),
  renewConversationLease: vi.fn(),
  getOldestOpenInboundMessage: vi.fn(),
  getInboundMessagePosition: vi.fn(),
  markInboundProcessing: vi.fn(),
  checkpointInboundTurn: vi.fn(),
  completeInboundReply: vi.fn(),
  completeInboundOptedOutReply: vi.fn(),
  completeInboundWithoutReply: vi.fn(),
  releaseConversationLease: vi.fn(),
  advanceComicAgent: vi.fn(),
  getOrCreateChannelIdentity: vi.fn(),
  channelStoryLink: vi.fn(),
  latestStoryLinkForSms: vi.fn(),
  submitGenerationJob: vi.fn(),
  sendChannelMessage: vi.fn(),
  recordActivityEvent: vi.fn(),
  reserveMessageAgentTurn: vi.fn(),
}));

vi.mock("@/lib/twilio-events", () => ({
  getInboundMessage: h.getInboundMessage,
  claimConversationLease: h.claimConversationLease,
  renewConversationLease: h.renewConversationLease,
  getOldestOpenInboundMessage: h.getOldestOpenInboundMessage,
  getInboundMessagePosition: h.getInboundMessagePosition,
  markInboundProcessing: h.markInboundProcessing,
  checkpointInboundTurn: h.checkpointInboundTurn,
  completeInboundReply: h.completeInboundReply,
  completeInboundOptedOutReply: h.completeInboundOptedOutReply,
  completeInboundWithoutReply: h.completeInboundWithoutReply,
  releaseConversationLease: h.releaseConversationLease,
}));
vi.mock("@/lib/comic-agent", () => ({ advanceComicAgent: h.advanceComicAgent }));
vi.mock("@/lib/channel-identities", () => ({
  getOrCreateChannelIdentity: h.getOrCreateChannelIdentity,
}));
vi.mock("@/lib/channel-story-link", () => ({
  channelStoryLink: h.channelStoryLink,
  latestStoryLinkForSms: h.latestStoryLinkForSms,
}));
vi.mock("@/lib/generation-jobs", () => ({ submitGenerationJob: h.submitGenerationJob }));
vi.mock("@/lib/twilio", () => ({ sendChannelMessage: h.sendChannelMessage }));
vi.mock("@/lib/activity-events", () => ({ recordActivityEvent: h.recordActivityEvent }));
vi.mock("@/lib/message-agent-budget", () => ({ reserveMessageAgentTurn: h.reserveMessageAgentTurn }));

import { processInboundMessage } from "@/lib/process-inbound-message";

type Receipt = {
  messageSid: string;
  channel: "sms" | "whatsapp";
  fromAddress: string;
  toAddress: string;
  body: string;
  mediaUrls: string[];
  mediaContentTypes: string[];
  status: "pending" | "processing" | "reply_pending" | "completed";
  replyBody: string | null;
  outboundSid: string | null;
  submission: {
    prompt: string;
    style: string;
    characterImageUrls: string[];
    targetStoryId?: string;
  } | null;
  attemptCount: number;
  createdAt: Date;
};

const FROM = "+15551112222";
const TO = "+15553334444";
let receipts: Record<string, Receipt>;
let conversation: {
  id: string;
  phoneNumber: string;
  channel: string;
  state: string;
  collected: Record<string, unknown>;
  activeStoryId: string | null;
  leaseOwner: string | null;
};
let sends: Array<{ body: string; to: string; from: string; channel: string }>;

function receipt(
  messageSid: string,
  body: string,
  createdAt: string,
  overrides: Partial<Receipt> = {},
): Receipt {
  return {
    messageSid,
    channel: "sms",
    fromAddress: FROM,
    toAddress: TO,
    body,
    mediaUrls: [],
    mediaContentTypes: [],
    status: "pending",
    replyBody: null,
    outboundSid: null,
    submission: null,
    attemptCount: 0,
    createdAt: new Date(createdAt),
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  receipts = {
    SM1: receipt("SM1", "A robot detective", "2026-10-01T00:00:01Z"),
  };
  conversation = {
    id: "conversation-1",
    phoneNumber: FROM,
    channel: "sms",
    state: "collecting",
    collected: {},
    activeStoryId: null,
    leaseOwner: null,
  };
  sends = [];
  h.getInboundMessage.mockImplementation(async (sid: string) => receipts[sid] ?? null);
  h.claimConversationLease.mockImplementation(async (_channel: string, _from: string, owner: string) => {
    if (conversation.leaseOwner) return null;
    conversation.leaseOwner = owner;
    return { ...conversation };
  });
  h.renewConversationLease.mockImplementation(async (_id: string, owner: string) =>
    conversation.leaseOwner === owner ? { ...conversation } : null,
  );
  h.getOldestOpenInboundMessage.mockImplementation(async (channel: string, from: string) => {
    const row = Object.values(receipts)
      .filter((row) => row.channel === channel && row.fromAddress === from && row.status !== "completed")
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    // A database SELECT returns a new snapshot, not a mutable row reference.
    return row ? { ...row } : null;
  });
  h.markInboundProcessing.mockImplementation(async (sid: string) => {
    receipts[sid].status = "processing";
    receipts[sid].attemptCount += 1;
  });
  h.checkpointInboundTurn.mockImplementation(async (input: {
    messageSid: string;
    state: string;
    collected: Record<string, unknown>;
    activeStoryId: string | null;
    replyBody: string;
    submission: Receipt["submission"];
  }) => {
    conversation.state = input.state;
    conversation.collected = input.collected;
    conversation.activeStoryId = input.activeStoryId;
    receipts[input.messageSid].status = "reply_pending";
    receipts[input.messageSid].replyBody = input.replyBody;
    receipts[input.messageSid].submission = input.submission;
  });
  h.completeInboundReply.mockImplementation(async (sid: string, outboundSid: string) => {
    receipts[sid].status = "completed";
    receipts[sid].outboundSid = outboundSid;
  });
  h.completeInboundOptedOutReply.mockImplementation(async (sid: string) => {
    receipts[sid].status = "completed";
  });
  h.completeInboundWithoutReply.mockImplementation(async (sid: string) => {
    receipts[sid].status = "completed";
  });
  h.releaseConversationLease.mockImplementation(async (_id: string, owner: string) => {
    if (conversation.leaseOwner === owner) conversation.leaseOwner = null;
  });
  h.getOrCreateChannelIdentity.mockResolvedValue({ userId: "channel-user" });
  h.channelStoryLink.mockResolvedValue(null);
  h.latestStoryLinkForSms.mockResolvedValue(null);
  h.getInboundMessagePosition.mockResolvedValue({ dailyCount: 1, firstMessage: false });
  h.submitGenerationJob.mockResolvedValue({ accepted: true, job: { id: "job-1" }, remaining: 2 });
  h.sendChannelMessage.mockImplementation(async (message: { body: string; to: string; from: string; channel: string }) => {
    sends.push(message);
    return `SM-out-${sends.length}`;
  });
  h.recordActivityEvent.mockResolvedValue(undefined);
  h.reserveMessageAgentTurn.mockResolvedValue({ allowed: true, duplicate: false });
});

describe("ordered inbound messaging processor", () => {
  it("returns a finished comic URL to STATUS from the same SMS identity", async () => {
    const storyId = "eb2aeaf7-5b1e-4a43-b8df-ea42f851cb80";
    const link = "https://comics.example.com/story/robot-detective";
    conversation.state = "done";
    conversation.activeStoryId = storyId;
    receipts.SM1.body = "  status!  ";
    h.advanceComicAgent.mockResolvedValue({
      nextState: "done",
      collected: {},
      activeStoryId: storyId,
      reply: "Your comic is ready. Send CONTINUE or NEW.",
      action: "none",
    });
    h.channelStoryLink.mockResolvedValue(link);

    await processInboundMessage("SM1");

    expect(h.channelStoryLink).toHaveBeenCalledExactlyOnceWith({
      storyId, channel: "sms", address: FROM,
    });
    expect(sends[0].body).toBe(`Your comic is ready. Send CONTINUE or NEW. View it here: ${link}`);
    expect(conversation).toMatchObject({ state: "done", activeStoryId: storyId });
    expect(receipts.SM1.status).toBe("completed");
  });

  it("recovers a Voice comic by SMS STATUS after the caller opts back in", async () => {
    const storyId = "eb2aeaf7-5b1e-4a43-b8df-ea42f851cb80";
    const link = "https://comics.example.com/story/phone-call-hero";
    receipts.SM1.body = "STATUS";
    h.advanceComicAgent.mockResolvedValue({
      nextState: "collecting",
      collected: {},
      activeStoryId: null,
      reply: "I'm ready for your comic idea.",
      action: "none",
    });
    h.latestStoryLinkForSms.mockResolvedValue({ storyId, source: "voice", link });

    await processInboundMessage("SM1");

    expect(h.latestStoryLinkForSms).toHaveBeenCalledExactlyOnceWith({
      address: FROM,
      senderAddress: TO,
    });
    expect(h.channelStoryLink).not.toHaveBeenCalled();
    expect(sends[0].body).toBe(
      `Your latest comic from your call is ready. View it here: ${link} Send a new idea to start another by text.`,
    );
    expect(conversation).toMatchObject({ state: "collecting", activeStoryId: null });
    expect(receipts.SM1.status).toBe("completed");
  });

  it("answers an expired Voice result STATUS with a new-idea invitation", async () => {
    receipts.SM1.body = "STATUS";
    h.advanceComicAgent.mockResolvedValue({
      nextState: "collecting",
      collected: {},
      activeStoryId: null,
      reply: "I'm ready for your comic idea. Tell me what should happen.",
      action: "none",
    });
    // The database lookup has no eligible completed job after its 14-day window.
    h.latestStoryLinkForSms.mockResolvedValue(null);

    await processInboundMessage("SM1");

    expect(h.latestStoryLinkForSms).toHaveBeenCalledOnce();
    expect(h.channelStoryLink).not.toHaveBeenCalled();
    expect(sends[0].body).toBe("I'm ready for your comic idea. Tell me what should happen.");
    expect(sends[0].body).not.toContain("/story/");
  });

  it("returns a newer Voice comic instead of an older completed SMS comic", async () => {
    const olderSmsStoryId = "eb2aeaf7-5b1e-4a43-b8df-ea42f851cb80";
    const newerVoiceStoryId = "d06c70f2-f0af-464b-b992-2d4040a6fd87";
    const link = "https://comics.example.com/story/newer-phone-call";
    conversation.state = "done";
    conversation.activeStoryId = olderSmsStoryId;
    receipts.SM1.body = "STATUS";
    h.advanceComicAgent.mockResolvedValue({
      nextState: "done",
      collected: {},
      activeStoryId: olderSmsStoryId,
      reply: "Your comic is ready. Send CONTINUE or NEW.",
      action: "none",
    });
    h.latestStoryLinkForSms.mockResolvedValue({
      storyId: newerVoiceStoryId, source: "voice", link,
    });

    await processInboundMessage("SM1");

    expect(sends[0].body).toContain(link);
    expect(sends[0].body).not.toContain("Send CONTINUE");
    expect(h.channelStoryLink).not.toHaveBeenCalled();
    expect(conversation.activeStoryId).toBe(olderSmsStoryId);
  });

  it("gives a recoverable STATUS response when the finished story is missing", async () => {
    const storyId = "eb2aeaf7-5b1e-4a43-b8df-ea42f851cb80";
    conversation.state = "done";
    conversation.activeStoryId = storyId;
    receipts.SM1.body = "STATUS";
    h.advanceComicAgent.mockResolvedValue({
      nextState: "done",
      collected: {},
      activeStoryId: storyId,
      reply: "Your comic is ready.",
      action: "none",
    });

    await processInboundMessage("SM1");

    expect(h.channelStoryLink).toHaveBeenCalledOnce();
    expect(sends[0].body).toMatch(/can't show that comic link.*status.*new/i);
    expect(sends[0].body).not.toMatch(/comic is ready/i);
    expect(conversation).toMatchObject({ state: "done", activeStoryId: storyId });
  });

  it("does not disclose a comic when the conversation identity differs from the sender", async () => {
    conversation.state = "done";
    conversation.activeStoryId = "eb2aeaf7-5b1e-4a43-b8df-ea42f851cb80";
    conversation.phoneNumber = "+15550009999";
    receipts.SM1.body = "STATUS";

    await expect(processInboundMessage("SM1")).rejects.toThrow(/identity changed/i);

    expect(h.channelStoryLink).not.toHaveBeenCalled();
    expect(h.advanceComicAgent).not.toHaveBeenCalled();
    expect(h.sendChannelMessage).not.toHaveBeenCalled();
  });

  it("introduces Twilio Comics and opt-out instructions on only the first SMS reply", async () => {
    receipts.SM2 = receipt("SM2", "Make it manga", "2026-10-01T00:00:02Z");
    h.getInboundMessagePosition.mockImplementation(async (message: Receipt) => ({
      dailyCount: message.messageSid === "SM1" ? 1 : 2,
      firstMessage: message.messageSid === "SM1",
    }));
    h.advanceComicAgent.mockImplementation(async (_current: unknown, turn: { text: string }) => ({
      nextState: "collecting",
      collected: { prompt: turn.text },
      activeStoryId: null,
      reply: `Draft: ${turn.text}`,
      action: "none",
    }));

    await processInboundMessage("SM2");

    expect(sends[0].body).toMatch(/^Twilio Comics: Draft: A robot detective/);
    expect(sends[0].body).toMatch(/HELP.*STOP.*Msg & data rates may apply/i);
    expect(sends[1].body).toBe("Draft: Make it manga");
  });

  it("caps SMS AI turns at 100 per sender per UTC day without changing the saved draft", async () => {
    conversation.state = "confirming";
    conversation.collected = { prompt: "Saved robot detective", style: "noir" };
    h.getInboundMessagePosition.mockResolvedValue({ dailyCount: 101, firstMessage: false });

    await processInboundMessage("SM1");

    expect(h.advanceComicAgent).not.toHaveBeenCalled();
    expect(h.submitGenerationJob).not.toHaveBeenCalled();
    expect(conversation.state).toBe("confirming");
    expect(conversation.collected).toEqual({ prompt: "Saved robot detective", style: "noir" });
    expect(sends[0].body).toMatch(/daily message limit.*try again/i);
    expect(h.recordActivityEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: "message:SM1:rate_limited",
      kind: "message.rate_limited",
      address: FROM,
      details: { dailyCount: 101, dailyLimit: 100 },
    }));
  });

  it("silently completes later texts above the daily receipt cap", async () => {
    h.getInboundMessagePosition.mockResolvedValue({ dailyCount: 102, firstMessage: false });

    await processInboundMessage("SM1");

    expect(h.advanceComicAgent).not.toHaveBeenCalled();
    expect(h.reserveMessageAgentTurn).not.toHaveBeenCalled();
    expect(sends).toEqual([]);
    expect(receipts.SM1).toMatchObject({ status: "completed", replyBody: "", outboundSid: null });
  });

  it("sends one AI-turn limit notice without changing the draft", async () => {
    conversation.state = "confirming";
    conversation.collected = { prompt: "Saved robot detective", style: "noir" };
    h.reserveMessageAgentTurn.mockResolvedValue({
      allowed: false, reason: "rate_limit", sendNotice: true,
    });

    await processInboundMessage("SM1");

    expect(h.reserveMessageAgentTurn).toHaveBeenCalledWith({
      messageSid: "SM1", channel: "sms", fromAddress: FROM, toAddress: TO,
    });
    expect(h.advanceComicAgent).not.toHaveBeenCalled();
    expect(conversation.state).toBe("confirming");
    expect(conversation.collected).toEqual({ prompt: "Saved robot detective", style: "noir" });
    expect(sends[0].body).toMatch(/message limit.*draft is saved.*later/i);
  });

  it("does not send another paid reply for a repeat AI-turn denial", async () => {
    h.reserveMessageAgentTurn.mockResolvedValue({
      allowed: false, reason: "rate_limit", sendNotice: false,
    });

    await processInboundMessage("SM1");

    expect(h.advanceComicAgent).not.toHaveBeenCalled();
    expect(sends).toEqual([]);
    expect(receipts.SM1).toMatchObject({ status: "completed", replyBody: "", outboundSid: null });
  });

  it("keeps a silent denial retryable from its checkpoint without reserving or sending again", async () => {
    h.reserveMessageAgentTurn.mockResolvedValue({
      allowed: false, reason: "rate_limit", sendNotice: false,
    });
    h.completeInboundWithoutReply.mockRejectedValueOnce(new Error("database unavailable"))
      .mockImplementationOnce(async (sid: string) => { receipts[sid].status = "completed"; });

    await expect(processInboundMessage("SM1")).rejects.toThrow("database unavailable");
    expect(receipts.SM1).toMatchObject({ status: "reply_pending", replyBody: "" });

    await processInboundMessage("SM1");

    expect(h.reserveMessageAgentTurn).toHaveBeenCalledOnce();
    expect(h.advanceComicAgent).not.toHaveBeenCalled();
    expect(sends).toEqual([]);
    expect(receipts.SM1.status).toBe("completed");
  });

  it("does not call OpenAI or Twilio when the durable turn budget is unavailable", async () => {
    h.reserveMessageAgentTurn.mockResolvedValue({ allowed: false, reason: "unavailable" });

    await expect(processInboundMessage("SM1")).rejects.toThrow(/budget unavailable/i);

    expect(h.advanceComicAgent).not.toHaveBeenCalled();
    expect(h.sendChannelMessage).not.toHaveBeenCalled();
    expect(receipts.SM1.status).toBe("processing");
  });

  it("tracks the agent SMS reply and requests a signed delivery callback", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://comics.example.com");
    h.advanceComicAgent.mockResolvedValue({
      nextState: "confirming",
      collected: { prompt: "A robot detective", style: "noir" },
      activeStoryId: null,
      reply: "Reply CREATE to approve.",
      action: "none",
    });

    try {
      await processInboundMessage("SM1");
    } finally {
      vi.unstubAllEnvs();
    }

    expect(h.sendChannelMessage).toHaveBeenCalledWith(expect.objectContaining({
      statusCallback: "https://comics.example.com/api/twilio/status?inboundSid=SM1#rc=3&rp=5xx,ct,rt",
    }));
    expect(h.recordActivityEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: "message:SM-out-1:outbound",
      kind: "message.outbound",
      channel: "sms",
      direction: "outbound",
      address: FROM,
      messageSid: "SM-out-1",
      content: "Reply CREATE to approve.",
      details: { inReplyTo: "SM1", purpose: "agent_reply" },
    }));
  });

  it("completes an accepted SMS reply even if activity storage fails", async () => {
    h.advanceComicAgent.mockResolvedValue({
      nextState: "confirming",
      collected: { prompt: "A robot detective", style: "noir" },
      activeStoryId: null,
      reply: "Reply CREATE to approve.",
      action: "none",
    });
    h.recordActivityEvent.mockRejectedValue(new Error("analytics unavailable"));

    await expect(processInboundMessage("SM1")).resolves.toBeUndefined();

    expect(receipts.SM1).toMatchObject({ status: "completed", outboundSid: "SM-out-1" });
    expect(h.sendChannelMessage).toHaveBeenCalledOnce();
    expect(h.recordActivityEvent).toHaveBeenCalledOnce();
  });

  it("saves an idea and its reply before sending one outbound SMS", async () => {
    h.advanceComicAgent.mockResolvedValue({
      nextState: "confirming",
      collected: { prompt: "A robot detective in the rain", style: "noir" },
      activeStoryId: null,
      reply: "A robot detective in the rain. Reply CREATE to approve.",
      action: "none",
    });

    await processInboundMessage("SM1");

    expect(h.advanceComicAgent).toHaveBeenCalledWith(
      { state: "collecting", collected: {}, activeStoryId: null },
      { text: "A robot detective", channel: "sms", imageUrls: [] },
    );
    expect(conversation.state).toBe("confirming");
    expect(receipts.SM1).toMatchObject({
      status: "completed",
      replyBody: "A robot detective in the rain. Reply CREATE to approve.",
      outboundSid: "SM-out-1",
    });
    expect(sends).toEqual([{
      channel: "sms",
      to: FROM,
      from: TO,
      body: "A robot detective in the rain. Reply CREATE to approve.",
    }]);
    expect(h.submitGenerationJob).not.toHaveBeenCalled();
  });

  it("processes the earlier text first when a later queue item starts first", async () => {
    receipts.SM2 = receipt("SM2", "Make it manga", "2026-10-01T00:00:02Z");
    h.advanceComicAgent.mockImplementation(async (current: { state: string }, turn: { text: string }) => ({
      nextState: "confirming",
      collected: { prompt: turn.text, style: "manga" },
      activeStoryId: null,
      reply: `Draft: ${turn.text}`,
      action: "none",
    }));

    await processInboundMessage("SM2");

    expect(receipts.SM1.status).toBe("completed");
    expect(receipts.SM2.status).toBe("completed");
    expect(h.advanceComicAgent.mock.calls.map(([current]) => current.state)).toEqual([
      "collecting",
      "confirming",
    ]);
    expect(sends.map((message) => message.body)).toEqual([
      "Draft: A robot detective",
      "Draft: Make it manga",
    ]);
  });

  it("passes a photo-only WhatsApp turn to the agent", async () => {
    conversation.channel = "whatsapp";
    conversation.phoneNumber = `whatsapp:${FROM}`;
    receipts.SM1 = receipt("SM1", "", "2026-10-01T00:00:01Z", {
      channel: "whatsapp",
      fromAddress: `whatsapp:${FROM}`,
      toAddress: "whatsapp:+14155238886",
      mediaUrls: ["https://api.twilio.com/reference", "https://api.twilio.com/video"],
      mediaContentTypes: ["image/jpeg", "video/mp4"],
    });
    h.advanceComicAgent.mockResolvedValue({
      nextState: "collecting",
      collected: { characterImageUrls: ["https://api.twilio.com/reference"] },
      activeStoryId: null,
      reply: "Photo received. What's your comic idea?",
      action: "none",
    });

    await processInboundMessage("SM1");

    expect(h.advanceComicAgent).toHaveBeenCalledWith(
      expect.anything(),
      {
        text: "",
        channel: "whatsapp",
        imageUrls: ["https://api.twilio.com/reference"],
      },
    );
    expect(sends[0].channel).toBe("whatsapp");
  });

  it("checkpoints a confirmed draft before publishing its idempotent generation job", async () => {
    conversation.state = "confirming";
    conversation.collected = { prompt: "Robot detective", style: "noir" };
    receipts.SM1.body = "CREATE";
    const submission = { prompt: "Robot detective", style: "noir", characterImageUrls: [] };
    h.advanceComicAgent.mockResolvedValue({
      nextState: "generating",
      collected: { prompt: "Robot detective", style: "noir" },
      activeStoryId: null,
      reply: "I'm creating your comic now.",
      action: "submit",
      submission,
    });
    h.submitGenerationJob.mockImplementation(async () => {
      expect(receipts.SM1.status).toBe("reply_pending");
      expect(receipts.SM1.submission).toEqual(submission);
      expect(conversation.state).toBe("generating");
      expect(conversation.collected.generationRequestKey).toBe("twilio-message:SM1");
      return { accepted: true, job: { id: "job-1" }, remaining: 2 };
    });

    await processInboundMessage("SM1");

    expect(h.submitGenerationJob).toHaveBeenCalledWith({
      idempotencyKey: "twilio-message:SM1",
      userId: "channel-user",
      source: "sms",
      recipientAddress: FROM,
      senderAddress: TO,
      prompt: "Robot detective",
      style: "noir",
      characterImageUrls: [],
      targetStoryId: undefined,
    });
    expect(receipts.SM1.status).toBe("completed");
  });

  it("keeps references attached to a draft after quota rejection", async () => {
    conversation.state = "confirming";
    conversation.collected = { prompt: "Robot detective", style: "noir" };
    receipts.SM1.body = "CREATE";
    receipts.SM1.mediaUrls = ["https://api.twilio.com/photo"];
    receipts.SM1.mediaContentTypes = ["image/jpeg"];
    h.advanceComicAgent.mockResolvedValue({
      nextState: "generating",
      collected: {
        prompt: "Robot detective",
        style: "noir",
        characterImageUrls: ["https://api.twilio.com/photo"],
      },
      activeStoryId: null,
      reply: "I'm creating your comic now.",
      action: "submit",
      submission: {
        prompt: "Robot detective",
        style: "noir",
        characterImageUrls: ["https://api.twilio.com/photo"],
      },
    });
    h.submitGenerationJob.mockResolvedValue({ accepted: false, job: { id: "job-1", status: "quota_rejected" }, remaining: 0 });

    await processInboundMessage("SM1");

    expect(conversation.state).toBe("confirming");
    expect(conversation.collected).toMatchObject({
      characterImageUrls: ["https://api.twilio.com/photo"],
    });
    expect(conversation.collected.generationRequestKey).toBeUndefined();
  });

  it("retries a failed queue submission from the stored checkpoint without rerunning the model", async () => {
    conversation.state = "confirming";
    conversation.collected = { prompt: "Robot detective", style: "noir" };
    receipts.SM1.body = "CREATE";
    h.advanceComicAgent.mockResolvedValue({
      nextState: "generating",
      collected: { prompt: "Robot detective", style: "noir" },
      activeStoryId: null,
      reply: "I'm creating your comic now.",
      action: "submit",
      submission: { prompt: "Robot detective", style: "noir", characterImageUrls: [] },
    });
    h.submitGenerationJob.mockRejectedValueOnce(new Error("Azure Queue unavailable"))
      .mockResolvedValueOnce({ accepted: true, job: { id: "job-1" }, remaining: 2 });

    await expect(processInboundMessage("SM1")).rejects.toThrow("Azure Queue unavailable");
    expect(receipts.SM1.status).toBe("reply_pending");
    expect(sends).toEqual([]);

    await processInboundMessage("SM1");

    expect(h.advanceComicAgent).toHaveBeenCalledOnce();
    expect(h.submitGenerationJob).toHaveBeenCalledTimes(2);
    expect(receipts.SM1.status).toBe("completed");
  });

  it("retries an outbound failure with the saved reply and no extra model call", async () => {
    h.advanceComicAgent.mockResolvedValue({
      nextState: "collecting",
      collected: { prompt: "Robot detective" },
      activeStoryId: null,
      reply: "Tell me the art style you want.",
      action: "none",
    });
    h.sendChannelMessage.mockRejectedValueOnce(Object.assign(new Error("Twilio rate limited"), {
      status: 429,
      code: 20429,
    }))
      .mockResolvedValueOnce("SM-out-2");

    await expect(processInboundMessage("SM1")).rejects.toThrow("Twilio rate limited");
    expect(receipts.SM1.status).toBe("reply_pending");
    expect(h.completeInboundOptedOutReply).not.toHaveBeenCalled();

    await processInboundMessage("SM1");

    expect(h.advanceComicAgent).toHaveBeenCalledOnce();
    expect(receipts.SM1).toMatchObject({ status: "completed", outboundSid: "SM-out-2" });
  });

  it("does not suppress a full Twilio sender queue error", async () => {
    h.advanceComicAgent.mockResolvedValue({
      nextState: "confirming",
      collected: { prompt: "Robot detective" },
      activeStoryId: null,
      reply: "Tell me the art style you want.",
      action: "none",
    });
    h.sendChannelMessage.mockRejectedValueOnce(Object.assign(new Error("Sender queue full"), {
      status: 400,
      code: 21611,
    }));

    await expect(processInboundMessage("SM1")).rejects.toThrow("Sender queue full");
    expect(receipts.SM1.status).toBe("reply_pending");
    expect(h.completeInboundOptedOutReply).not.toHaveBeenCalled();

    await processInboundMessage("SM1");
    expect(receipts.SM1.status).toBe("completed");
    expect(h.advanceComicAgent).toHaveBeenCalledOnce();
  });

  it("closes an opted-out reply so a later inbound turn can proceed without resending it", async () => {
    receipts.SM2 = receipt("SM2", "A second idea", "2026-10-01T00:00:02Z");
    h.advanceComicAgent.mockImplementation(async (_current: unknown, turn: { text: string }) => ({
      nextState: "confirming",
      collected: { prompt: turn.text },
      activeStoryId: null,
      reply: `Draft: ${turn.text}`,
      action: "none",
    }));
    h.sendChannelMessage.mockRejectedValueOnce(Object.assign(new Error("Recipient opted out"), {
      status: 400,
      code: 21610,
    }));

    await processInboundMessage("SM1");
    expect(receipts.SM1).toMatchObject({ status: "completed", outboundSid: null });
    expect(h.completeInboundOptedOutReply).toHaveBeenCalledExactlyOnceWith("SM1");
    expect(h.sendChannelMessage).toHaveBeenCalledTimes(1);

    await processInboundMessage("SM1");
    expect(h.sendChannelMessage).toHaveBeenCalledTimes(1);

    await processInboundMessage("SM2");
    expect(receipts.SM2.status).toBe("completed");
    expect(h.advanceComicAgent).toHaveBeenCalledTimes(2);
  });

  it("keeps a submitted generation checkpoint when the confirmation SMS is opted out", async () => {
    conversation.state = "confirming";
    conversation.collected = { prompt: "Robot detective", style: "noir" };
    receipts.SM1.body = "CREATE";
    const submission = { prompt: "Robot detective", style: "noir", characterImageUrls: [] };
    h.advanceComicAgent.mockResolvedValue({
      nextState: "generating",
      collected: { prompt: "Robot detective", style: "noir" },
      activeStoryId: null,
      reply: "I'm creating your comic now.",
      action: "submit",
      submission,
    });
    h.sendChannelMessage.mockRejectedValueOnce(Object.assign(new Error("Recipient opted out"), {
      status: 400,
      code: 21610,
    }));

    await processInboundMessage("SM1");

    expect(h.submitGenerationJob).toHaveBeenCalledOnce();
    expect(conversation.state).toBe("generating");
    expect(conversation.collected.generationRequestKey).toBe("twilio-message:SM1");
    expect(receipts.SM1).toMatchObject({ status: "completed", submission });
    expect(h.completeInboundOptedOutReply).toHaveBeenCalledExactlyOnceWith("SM1");
  });

  it("does not send a reply after losing the conversation lease", async () => {
    h.advanceComicAgent.mockResolvedValue({
      nextState: "collecting",
      collected: { prompt: "Robot detective" },
      activeStoryId: null,
      reply: "Tell me the art style you want.",
      action: "none",
    });
    h.renewConversationLease.mockResolvedValueOnce({ ...conversation })
      .mockResolvedValueOnce(null);

    await expect(processInboundMessage("SM1")).rejects.toThrow(/lease/i);

    expect(receipts.SM1.status).toBe("reply_pending");
    expect(h.sendChannelMessage).not.toHaveBeenCalled();
  });

  it("keeps a rejected draft ready for approval and sends a quota notice", async () => {
    conversation.state = "confirming";
    conversation.collected = { prompt: "Robot detective", style: "noir" };
    receipts.SM1.body = "CREATE";
    h.advanceComicAgent.mockResolvedValue({
      nextState: "generating",
      collected: { prompt: "Robot detective", style: "noir" },
      activeStoryId: null,
      reply: "I'm creating your comic now.",
      action: "submit",
      submission: { prompt: "Robot detective", style: "noir", characterImageUrls: [] },
    });
    h.submitGenerationJob.mockResolvedValue({ accepted: false, job: { id: "job-1", status: "quota_rejected" }, remaining: 0 });

    await processInboundMessage("SM1");

    expect(conversation.state).toBe("confirming");
    expect(receipts.SM1.submission).toBeNull();
    expect(sends[0].body).toMatch(/limit/i);
  });

  it("explains the daily studio capacity and preserves the confirmed draft", async () => {
    conversation.state = "confirming";
    conversation.collected = { prompt: "Robot detective", style: "noir" };
    receipts.SM1.body = "CREATE";
    h.advanceComicAgent.mockResolvedValue({
      nextState: "generating",
      collected: { prompt: "Robot detective", style: "noir" },
      activeStoryId: null,
      reply: "I'm creating your comic now.",
      action: "submit",
      submission: { prompt: "Robot detective", style: "noir", characterImageUrls: [] },
    });
    h.submitGenerationJob.mockResolvedValue({
      accepted: false,
      job: { id: "job-1", status: "quota_rejected", lastError: "daily_generation_capacity" },
      remaining: 2,
    });

    await processInboundMessage("SM1");

    expect(conversation.state).toBe("confirming");
    expect(conversation.collected.generationRequestKey).toBeUndefined();
    expect(receipts.SM1.submission).toBeNull();
    expect(sends[0].body).toMatch(/today's comic studio is full/i);
    expect(sends[0].body).toMatch(/14 days/i);
    expect(sends[0].body).not.toMatch(/free limit of 3/i);
  });

  it("keeps an admission in progress checkpoint instead of announcing a quota denial", async () => {
    conversation.state = "confirming";
    conversation.collected = { prompt: "Robot detective", style: "noir" };
    receipts.SM1.body = "CREATE";
    h.advanceComicAgent.mockResolvedValue({
      nextState: "generating",
      collected: { prompt: "Robot detective", style: "noir", generationRequestKey: "twilio-message:SM1" },
      activeStoryId: null,
      reply: "I'm creating your comic now.",
      action: "submit",
      submission: { prompt: "Robot detective", style: "noir", characterImageUrls: [] },
    });
    h.submitGenerationJob.mockResolvedValue({
      accepted: false,
      job: { id: "job-1", status: "admitting" },
      remaining: 0,
    });

    await processInboundMessage("SM1");

    expect(conversation.state).toBe("generating");
    expect(conversation.collected.generationRequestKey).toBe("twilio-message:SM1");
    expect(receipts.SM1.submission).toMatchObject({ prompt: "Robot detective" });
    expect(sends[0].body).toMatch(/checking your comic request/i);
    expect(sends[0].body).not.toMatch(/free limit/i);
  });

  it("leaves work retryable when another worker owns the conversation lease", async () => {
    h.claimConversationLease.mockResolvedValue(null);

    await expect(processInboundMessage("SM1")).rejects.toThrow(/lease/i);

    expect(receipts.SM1.status).toBe("pending");
    expect(h.advanceComicAgent).not.toHaveBeenCalled();
    expect(h.sendChannelMessage).not.toHaveBeenCalled();
  });

  it("retries a failed AI turn twice, then sends a saved failure reply and processes later texts", async () => {
    receipts.SM1.body = "A permanently unprocessable idea";
    receipts.SM2 = receipt("SM2", "A friendly dragon", "2026-10-01T00:00:02Z");
    h.advanceComicAgent.mockImplementation(async (_current: unknown, turn: { text: string }) => {
      if (turn.text === "A permanently unprocessable idea") {
        throw new Error("Invalid model response");
      }
      return {
        nextState: "confirming",
        collected: { prompt: "A friendly dragon", style: "manga" },
        activeStoryId: null,
        reply: "A friendly dragon. Reply CREATE to approve.",
        action: "none",
      };
    });

    await expect(processInboundMessage("SM1")).rejects.toThrow("Invalid model response");
    await expect(processInboundMessage("SM1")).rejects.toThrow("Invalid model response");
    expect(receipts.SM1).toMatchObject({ status: "processing", attemptCount: 2 });
    expect(receipts.SM2.status).toBe("pending");
    expect(sends).toEqual([]);

    await processInboundMessage("SM2");

    expect(receipts.SM1).toMatchObject({ status: "completed", attemptCount: 3 });
    expect(receipts.SM1.replyBody).toMatch(/couldn't process.*message/i);
    expect(receipts.SM2.status).toBe("completed");
    expect(sends.map((send) => send.body)).toEqual([
      receipts.SM1.replyBody,
      "A friendly dragon. Reply CREATE to approve.",
    ]);
  });

  it("retries a saved poison-turn reply without another model call when Twilio sending fails", async () => {
    h.advanceComicAgent.mockRejectedValue(new Error("Invalid model response"));
    await expect(processInboundMessage("SM1")).rejects.toThrow("Invalid model response");
    await expect(processInboundMessage("SM1")).rejects.toThrow("Invalid model response");

    h.sendChannelMessage.mockRejectedValueOnce(new Error("Twilio unavailable"));
    await expect(processInboundMessage("SM1")).rejects.toThrow("Twilio unavailable");
    expect(receipts.SM1).toMatchObject({ status: "reply_pending", attemptCount: 3 });
    expect(receipts.SM1.replyBody).toMatch(/couldn't process.*message/i);

    await processInboundMessage("SM1");

    expect(h.advanceComicAgent).toHaveBeenCalledTimes(3);
    expect(receipts.SM1.status).toBe("completed");
    expect(sends).toHaveLength(1);
    expect(sends[0].body).toBe(receipts.SM1.replyBody);
  });
});
