import { randomUUID } from "node:crypto";
import { recordActivityEvent } from "@/lib/activity-events";
import { advanceComicAgent, type AgentCollected } from "@/lib/comic-agent";
import { CONVERSATION_RESUME_DAYS } from "@/lib/conversation-policy";
import { getOrCreateChannelIdentity } from "@/lib/channel-identities";
import { channelStoryLink, latestStoryLinkForSms } from "@/lib/channel-story-link";
import { submitGenerationJob } from "@/lib/generation-jobs";
import { isDailyGenerationCapacityRejection } from "@/lib/generation-policy";
import { reserveMessageAgentTurn } from "@/lib/message-agent-budget";
import {
  checkpointInboundTurn,
  claimConversationLease,
  completeInboundOptedOutReply,
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
  `You've reached the daily message limit of 100. Your comic draft is saved for ${CONVERSATION_RESUME_DAYS} days; try again tomorrow.`;
const AGENT_TURN_LIMIT_REPLY =
  `You've reached the message limit for now. Your comic draft is saved for ${CONVERSATION_RESUME_DAYS} days; try again later.`;
const QUOTA_REPLY =
  `You've reached the free limit of 3 comics this week. Your draft is saved for ${CONVERSATION_RESUME_DAYS} days; try again after your quota resets.`;
const CAPACITY_REPLY =
  `Today's comic studio is full. Your draft is saved for ${CONVERSATION_RESUME_DAYS} days; please try again tomorrow.`;
const GENERATION_CHECKING_REPLY =
  "I'm checking your comic request. If it starts, I'll text the result here. You can send STATUS to check later.";
const GENERATION_FAILURE_REPLY =
  "I couldn't start your comic yet. Your draft is saved; reply CREATE to try again.";
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

function isTwilioOptOut(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, status } = error as { code?: unknown; status?: unknown };
  // https://www.twilio.com/docs/api/errors/21610: sending stays blocked
  // until the recipient opts back in. Other failures remain retryable.
  return code === 21610 && status === 400;
}

function isStatusCommand(text: string): boolean {
  return text.trim().replace(/[.!?,;:…。！？]+$/u, "").trim().toUpperCase() === "STATUS";
}

async function processOneMessage(
  message: StoredInboundMessage,
  conversation: NonNullable<Awaited<ReturnType<typeof claimConversationLease>>>,
  leaseOwner: string,
): Promise<void> {
  if (conversation.channel !== message.channel || conversation.phoneNumber !== message.fromAddress) {
    throw new Error("Conversation identity changed while processing inbound message");
  }
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
        let completedStoryStatusId: string | null = null;
        const statusRequested = isStatusCommand(message.body);
        let advancedSuccessfully = false;
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
          advancedSuccessfully = true;
          if (
            conversation.state === "done" && conversation.activeStoryId &&
            statusRequested && advance.nextState === "done" &&
            advance.activeStoryId === conversation.activeStoryId
          ) {
            completedStoryStatusId = conversation.activeStoryId;
          }
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
        if (advancedSuccessfully && statusRequested && nextState !== "generating") {
          const latest = message.channel === "sms"
            ? await latestStoryLinkForSms({
                address: message.fromAddress,
                senderAddress: message.toAddress,
              })
            : null;
          if (latest) {
            if (nextState === "done" && activeStoryIdAfterCheckpoint === latest.storyId) {
              replyBody = `${replyBody} View it here: ${latest.link}`;
            } else if (nextState === "confirming") {
              replyBody = `${replyBody} Your latest completed comic: ${latest.link}`;
            } else {
              const fromCall = latest.source === "voice" ? " from your call" : "";
              replyBody = `Your latest comic${fromCall} is ready. View it here: ${latest.link} Send a new idea to start another by text.`;
            }
          } else if (completedStoryStatusId) {
            const link = await channelStoryLink({
              storyId: completedStoryStatusId,
              channel: message.channel,
              address: message.fromAddress,
            });
            replyBody = link
              ? `${replyBody} View it here: ${link}`
              : "I can't show that comic link right now. Send STATUS to try again later, or NEW to start another story.";
          }
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
      if (job.job.status === "quota_rejected" || job.job.status === "failed") {
        const savedDraft = { ...collectedAfterCheckpoint };
        delete savedDraft.generationRequestKey;
        const rejectionReply = withInitialSmsDisclosure(
          job.job.status === "failed" ? GENERATION_FAILURE_REPLY
            : isDailyGenerationCapacityRejection(job.job) ? CAPACITY_REPLY : QUOTA_REPLY,
          firstSmsReply,
        );
        await checkpointInboundTurn({
          messageSid: message.messageSid,
          conversationId: conversation.id,
          leaseOwner,
          state: "confirming",
          collected: savedDraft,
          activeStoryId: activeStoryIdAfterCheckpoint,
          replyBody: rejectionReply,
          submission: null,
        });
        replyBody = rejectionReply;
        submission = null;
      } else {
        // Another publisher is still admitting this idempotent request. Keep
        // its generation checkpoint until that publisher or recovery resolves it.
        const checkingReply = withInitialSmsDisclosure(GENERATION_CHECKING_REPLY, firstSmsReply);
        await checkpointInboundTurn({
          messageSid: message.messageSid,
          conversationId: conversation.id,
          leaseOwner,
          state: "generating",
          collected: collectedAfterCheckpoint,
          activeStoryId: activeStoryIdAfterCheckpoint,
          replyBody: checkingReply,
          submission,
        });
        replyBody = checkingReply;
      }
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

  let outboundSid: string;
  try {
    outboundSid = await sendChannelMessage({
      channel: message.channel,
      to: message.fromAddress,
      from: message.toAddress,
      body: replyBody,
      ...(process.env.PUBLIC_BASE_URL ? {
        statusCallback: `${process.env.PUBLIC_BASE_URL.replace(/\/$/, "")}/api/twilio/status?inboundSid=${encodeURIComponent(message.messageSid)}#rc=3&rp=5xx,ct,rt`,
      } : {}),
    });
  } catch (error) {
    if (!isTwilioOptOut(error)) throw error;
    await completeInboundOptedOutReply(message.messageSid);
    return;
  }
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
