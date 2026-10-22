import { randomUUID } from "node:crypto";
import { recordActivityEvent } from "@/lib/activity-events";
import { advanceComicAgent, type AgentCollected } from "@/lib/comic-agent";
import { getOrCreateChannelIdentity } from "@/lib/channel-identities";
import { submitGenerationJob } from "@/lib/generation-jobs";
import { reserveMessageAgentTurn } from "@/lib/message-agent-budget";
import {
  checkpointInboundTurn,
  claimConversationLease,
  completeInboundReply,
  completeInboundWithoutReply,
  getInboundMessage,
  getInboundMessagePosition,
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
const MAX_DAILY_MESSAGE_TURNS = 100;
const INITIAL_SMS_PREFIX = "Twilio Comics: ";
const INITIAL_SMS_SUFFIX = " Reply HELP for help, STOP to opt out. Msg & data rates may apply.";
const DAILY_LIMIT_REPLY =
  "You've reached the daily message limit of 100. Your comic draft is saved; try again tomorrow.";
const AGENT_TURN_LIMIT_REPLY =
  "You've reached the message limit for now. Your comic draft is saved; try again later.";
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

function withInitialSmsDisclosure(body: string, firstSmsReply: boolean): string {
  return firstSmsReply ? `${INITIAL_SMS_PREFIX}${body}${INITIAL_SMS_SUFFIX}` : body;
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
  let firstSmsReply = message.channel === "sms" && Boolean(replyBody?.startsWith(INITIAL_SMS_PREFIX));
  let collectedAfterCheckpoint: AgentCollected = conversation.collected || {};
  let activeStoryIdAfterCheckpoint = conversation.activeStoryId;

  if (message.status !== "reply_pending") {
    await markInboundProcessing(message.messageSid);
    let nextState = conversation.state;
    const position = await getInboundMessagePosition(message);
    firstSmsReply = message.channel === "sms" && position.firstMessage;
    const rateLimited = position.dailyCount > MAX_DAILY_MESSAGE_TURNS;
    if (rateLimited) {
      // Repeating a paid SMS for every message in a flood would turn the
      // safety limit into another unbounded cost. The first denial explains it.
      replyBody = position.dailyCount === MAX_DAILY_MESSAGE_TURNS + 1
        ? DAILY_LIMIT_REPLY
        : "";
      submission = null;
    } else {
      const budget = await reserveMessageAgentTurn({
        messageSid: message.messageSid,
        channel: message.channel,
        fromAddress: message.fromAddress,
        toAddress: message.toAddress,
      });
      if (!budget.allowed) {
        if (budget.reason !== "rate_limit") {
          throw new Error(`Message agent budget unavailable: ${budget.reason}`);
        }
        replyBody = budget.sendNotice ? AGENT_TURN_LIMIT_REPLY : "";
        submission = null;
      } else {
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
      }
    }
    if (replyBody !== "") {
      replyBody = withInitialSmsDisclosure(replyBody || AGENT_FAILURE_REPLY, firstSmsReply);
    }
    await checkpointInboundTurn({
      messageSid: message.messageSid,
      conversationId: conversation.id,
      leaseOwner,
      state: nextState,
      collected: collectedAfterCheckpoint,
      activeStoryId: activeStoryIdAfterCheckpoint,
      replyBody,
      submission,
    });
    if (rateLimited) {
      await recordActivityEvent({
        eventKey: `message:${message.messageSid}:rate_limited`,
        channel: message.channel,
        kind: "message.rate_limited",
        direction: "inbound",
        address: message.fromAddress,
        messageSid: message.messageSid,
        status: "rejected",
        details: { dailyCount: position.dailyCount, dailyLimit: MAX_DAILY_MESSAGE_TURNS },
      }).catch((error) => console.error("Message limit history failed", error));
    }
  }

  if (replyBody === "") {
    if (submission) throw new Error(`Silent inbound message ${message.messageSid} has a submission`);
    await completeInboundWithoutReply(message.messageSid);
    return;
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
      const quotaReply = withInitialSmsDisclosure(QUOTA_REPLY, firstSmsReply);
      await checkpointInboundTurn({
        messageSid: message.messageSid,
        conversationId: conversation.id,
        leaseOwner,
        state: "confirming",
        collected: savedDraft,
        activeStoryId: activeStoryIdAfterCheckpoint,
        replyBody: quotaReply,
        submission: null,
      });
      replyBody = quotaReply;
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
    ...(process.env.PUBLIC_BASE_URL ? {
      statusCallback: `${process.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/twilio/status?inboundSid=${encodeURIComponent(message.messageSid)}#rc=3&rp=5xx,ct,rt`,
    } : {}),
  });
  await recordActivityEvent({
    eventKey: `message:${outboundSid}:outbound`,
    channel: message.channel,
    kind: "message.outbound",
    direction: "outbound",
    address: message.fromAddress,
    messageSid: outboundSid,
    content: replyBody,
    status: "accepted",
    details: { inReplyTo: message.messageSid, purpose: "agent_reply" },
  }).catch((error) => console.error("Agent reply history failed", error));
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
