import { randomUUID } from "node:crypto";
import { advanceComicAgent, type AgentCollected } from "@/lib/comic-agent";
import { getOrCreateChannelIdentity } from "@/lib/channel-identities";
import { submitGenerationJob } from "@/lib/generation-jobs";
import {
  checkpointInboundTurn,
  claimConversationLease,
  completeInboundReply,
  getInboundMessage,
  getOldestOpenInboundMessage,
  markInboundProcessing,
  releaseConversationLease,
  renewConversationLease,
  type StoredInboundMessage,
} from "@/lib/twilio-events";
import { sendChannelMessage } from "@/lib/twilio";

const CONVERSATION_LEASE_SECONDS = 5 * 60;
const MAX_TURNS_PER_RUN = 12;
const MAX_AGENT_ATTEMPTS = 3;
const QUOTA_REPLY =
  "You've reached the free limit of 3 comics this week. Your draft is saved; try again after your quota resets.";
const AGENT_FAILURE_REPLY =
  "Sorry, I couldn't process that message. Your saved draft is unchanged. Please send it again or send NEW to start over.";

export class ConversationLeaseBusyError extends Error {
  constructor() {
    super("Conversation lease is owned by another worker");
    this.name = "ConversationLeaseBusyError";
  }
}

function imageUrls(message: StoredInboundMessage): string[] {
  return message.mediaUrls
    .filter((_, index) => message.mediaContentTypes[index]?.toLowerCase().startsWith("image/"))
    .slice(0, 2);
}

async function processOneMessage(
  message: StoredInboundMessage,
  conversation: NonNullable<Awaited<ReturnType<typeof claimConversationLease>>>,
  leaseOwner: string,
): Promise<void> {
  let replyBody = message.replyBody;
  let submission = message.submission;
  let collectedAfterCheckpoint: AgentCollected = conversation.collected || {};
  let activeStoryIdAfterCheckpoint = conversation.activeStoryId;

  if (message.status !== "reply_pending") {
    await markInboundProcessing(message.messageSid);
    let nextState = conversation.state;
    try {
      const advance = await advanceComicAgent(
        {
          state: conversation.state,
          collected: conversation.collected || {},
          activeStoryId: conversation.activeStoryId,
        },
        {
          text: message.body,
          channel: message.channel,
          imageUrls: imageUrls(message),
        },
      );
      replyBody = advance.reply;
      submission = advance.action === "submit" ? advance.submission || null : null;
      collectedAfterCheckpoint = submission
        ? { ...advance.collected, generationRequestKey: `twilio-message:${message.messageSid}` }
        : advance.collected;
      activeStoryIdAfterCheckpoint = advance.activeStoryId;
      nextState = advance.nextState;
    } catch (error) {
      // A model turn that fails repeatedly must not hold every later text from
      // this sender behind it forever. Leave the prior draft untouched and
      // checkpoint a deterministic outbox reply before calling Twilio.
      if (message.attemptCount + 1 < MAX_AGENT_ATTEMPTS) throw error;
      console.warn("Inbound comic agent exhausted retries", {
        messageSid: message.messageSid,
        attempts: message.attemptCount + 1,
      });
      replyBody = AGENT_FAILURE_REPLY;
      submission = null;
    }
    await checkpointInboundTurn({
      messageSid: message.messageSid,
      conversationId: conversation.id,
      leaseOwner,
      state: nextState,
      collected: collectedAfterCheckpoint,
      activeStoryId: activeStoryIdAfterCheckpoint,
      replyBody: replyBody || AGENT_FAILURE_REPLY,
      submission,
    });
  }

  if (submission) {
    const identity = await getOrCreateChannelIdentity(message.channel, message.fromAddress);
    const job = await submitGenerationJob({
      idempotencyKey: `twilio-message:${message.messageSid}`,
      userId: identity.userId,
      source: message.channel,
      recipientAddress: message.fromAddress,
      senderAddress: message.toAddress,
      prompt: submission.prompt,
      style: submission.style,
      characterImageUrls: submission.characterImageUrls,
      targetStoryId: submission.targetStoryId,
    });

    if (!job.accepted) {
      const savedDraft = { ...collectedAfterCheckpoint };
      delete savedDraft.generationRequestKey;
      await checkpointInboundTurn({
        messageSid: message.messageSid,
        conversationId: conversation.id,
        leaseOwner,
        state: "confirming",
        collected: savedDraft,
        activeStoryId: activeStoryIdAfterCheckpoint,
        replyBody: QUOTA_REPLY,
        submission: null,
      });
      replyBody = QUOTA_REPLY;
      submission = null;
    }
  }

  if (!replyBody?.trim()) {
    throw new Error(`Inbound message ${message.messageSid} has no saved reply`);
  }
  const stillLeased = await renewConversationLease(
    conversation.id,
    leaseOwner,
    CONVERSATION_LEASE_SECONDS,
  );
  if (!stillLeased) throw new ConversationLeaseBusyError();

  const outboundSid = await sendChannelMessage({
    channel: message.channel,
    to: message.fromAddress,
    from: message.toAddress,
    body: replyBody,
  });
  await completeInboundReply(message.messageSid, outboundSid);
}

/** Process through the target SID in receipt order, under one phone/channel lease. */
export async function processInboundMessage(messageSid: string): Promise<void> {
  const target = await getInboundMessage(messageSid);
  if (!target || target.status === "completed") return;

  const leaseOwner = randomUUID();
  const leased = await claimConversationLease(
    target.channel,
    target.fromAddress,
    leaseOwner,
    CONVERSATION_LEASE_SECONDS,
  );
  if (!leased) throw new ConversationLeaseBusyError();

  try {
    for (let count = 0; count < MAX_TURNS_PER_RUN; count++) {
      const message = await getOldestOpenInboundMessage(target.channel, target.fromAddress);
      if (!message) {
        const latest = await getInboundMessage(messageSid);
        if (!latest || latest.status === "completed") return;
        throw new Error(`Inbound message ${messageSid} disappeared from open receipts`);
      }

      const conversation = await renewConversationLease(
        leased.id,
        leaseOwner,
        CONVERSATION_LEASE_SECONDS,
      );
      if (!conversation) throw new ConversationLeaseBusyError();

      await processOneMessage(message, conversation, leaseOwner);
      if (message.messageSid === messageSid) return;
    }
    throw new Error("Too many earlier inbound turns; retry the remaining work");
  } finally {
    await releaseConversationLease(leased.id, leaseOwner);
  }
}
