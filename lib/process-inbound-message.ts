import { randomUUID } from "node:crypto";
import { recordActivityEvent } from "@/lib/activity-events";
import { advanceComicAgent, type AgentCollected } from "@/lib/comic-agent";
import { CONVERSATION_RESUME_DAYS } from "@/lib/conversation-policy";
import { channelUserId, getOrCreateChannelIdentity } from "@/lib/channel-identities";
import {
  clearStagedCameraPhotoReferences,
  getStagedCameraPhotoReferences,
} from "@/lib/browser-photo-staging";
import { channelStoryLink, latestStoryLinkForSms } from "@/lib/channel-story-link";
import { submitGenerationJob } from "@/lib/generation-jobs";
import { isDailyGenerationCapacityRejection } from "@/lib/generation-policy";
import { reserveMessageAgentTurn } from "@/lib/message-agent-budget";
import { getMarketingContact } from "@/lib/marketing-contact";
import { getExperienceSettings } from "@/lib/photo-experience-settings";
import { getPublicEnabledChannels } from "@/lib/public-channel-readiness";
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
const INITIAL_SMS_PREFIX = "Twilio Comics\n\n";
const INITIAL_SMS_SUFFIX = "\n\nReply HELP for help; STOP to opt out. Msg & data rates may apply.";
const DAILY_LIMIT_REPLY =
  `You've reached the daily message limit of 100. Your comic draft is saved for ${CONVERSATION_RESUME_DAYS} days; try again tomorrow.`;
const AGENT_TURN_LIMIT_REPLY =
  `You've reached the message limit for now. Your comic draft is saved for ${CONVERSATION_RESUME_DAYS} days; try again later.`;
const QUOTA_REPLY =
  `You've reached the free limit of 3 comics this week. Your draft is saved for ${CONVERSATION_RESUME_DAYS} days; try again after your quota resets.`;
const CAPACITY_REPLY =
  `Today's comic studio is full. Your draft is saved for ${CONVERSATION_RESUME_DAYS} days; please try again tomorrow.`;
const GENERATION_CHECKING_REPLY =
  "I'm checking your comic request. If it starts, I'll text the result here.\n\nReply STATUS to check later.";
const GENERATION_FAILURE_REPLY =
  "I couldn't start your comic yet. Your draft is saved.\n\nReply CREATE to try again.";
const AGENT_FAILURE_REPLY =
  "Sorry, I couldn't process that message. Your saved draft is unchanged.\n\nSend it again, or reply NEW to start over.";
const UNSUPPORTED_ATTACHMENT_REPLY =
  "I couldn't use that attachment. Please send a photo or text your comic idea.";
const SKIPPED_ATTACHMENT_NOTICE =
  "I skipped the non-photo attachment; only photos can be used as references.";

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

function hasNonImageAttachment(message: StoredInboundMessage): boolean {
  return message.mediaUrls.some((_, index) =>
    !message.mediaContentTypes[index]?.toLowerCase().startsWith("image/"));
}

function unsupportedAttachmentReply(state: string): string {
  if (state === "generating") {
    return "I couldn't use that attachment. I'm still creating your comic.\n\nReply STATUS for an update.";
  }
  if (state === "confirming") {
    return "I couldn't use that attachment. Your idea is saved.\n\nSend a photo, or reply CREATE.";
  }
  if (state === "done") {
    return "I couldn't use that attachment. Send a photo or text a new comic idea.";
  }
  return UNSUPPORTED_ATTACHMENT_REPLY;
}

function isTwilioOptOut(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, status } = error as { code?: unknown; status?: unknown };
  // https://www.twilio.com/docs/api/errors/21610: sending stays blocked
  // until the recipient opts back in. Other failures remain retryable.
  return code === 21610 && status === 400;
}

function normalizedCommand(text: string): string {
  return text.trim().replace(/[.!?,;:…。！？]+$/u, "").trim().toUpperCase();
}

function isStatusCommand(text: string): boolean {
  return normalizedCommand(text) === "STATUS";
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
        const command = normalizedCommand(message.body);
        const resetOrDiscard = message.channel === "sms" &&
          ["NEW", "RESET", "RESTART", "DISCARD"].includes(command);
        // Read the stage before the reset turn. A new upload made while the
        // turn runs must not be cleared with the old photo set.
        const resetStageRefs = resetOrDiscard && conversation.state !== "generating"
          ? await getStagedCameraPhotoReferences(
              message.fromAddress,
              channelUserId(message.fromAddress),
            )
          : [];
        let advancedSuccessfully = false;
        try {
          const attachedPhotos = imageUrls(message);
          const unsupportedAttachment = hasNonImageAttachment(message);
          if (!message.body.trim() && !attachedPhotos.length && unsupportedAttachment) {
            replyBody = unsupportedAttachmentReply(conversation.state);
            submission = null;
          } else {
            const approval = message.channel === "sms" &&
              ["CREATE", "CREATE IT"].includes(command);
            const smsSettings = message.channel === "sms" ? await getExperienceSettings() : null;
            // Snapshot the staged set before CREATE. The conditional clear
            // below must not erase a fresh upload made during this turn.
            const stagedForSubmission = approval && smsSettings?.cameraEnabled
              ? await getStagedCameraPhotoReferences(
                  message.fromAddress,
                  channelUserId(message.fromAddress),
                )
              : null;
            let agentCollected = conversation.collected || {};
            // An MMS takes priority over kiosk photos already added to this SMS
            // draft. The user is choosing a new photo source by sending it.
            if (message.channel === "sms" && attachedPhotos.length &&
                agentCollected.characterImageUrls?.some((ref) => ref.startsWith("blob:uploads/"))) {
              agentCollected = { ...agentCollected, characterImageUrls: [] };
            }
            let turnPhotos = attachedPhotos;
            if (smsSettings?.cameraEnabled && !attachedPhotos.length && !resetOrDiscard &&
                (conversation.state === "done" || !agentCollected.characterImageUrls?.length)) {
              turnPhotos = stagedForSubmission ?? await getStagedCameraPhotoReferences(
                message.fromAddress,
                channelUserId(message.fromAddress),
              );
            }
            const advance = await advanceComicAgent(
              {
                state: conversation.state,
                collected: agentCollected,
                activeStoryId: conversation.activeStoryId,
              },
              {
                text: message.body,
                channel: message.channel,
                imageUrls: turnPhotos,
              },
            );
            replyBody = advance.reply;
            if (message.channel === "sms" && !message.body.trim() &&
                attachedPhotos.some((photo) =>
                  advance.collected.characterImageUrls?.includes(photo) &&
                  !conversation.collected?.characterImageUrls?.includes(photo)) &&
                advance.nextState === "collecting" && smsSettings?.voicePhotoMode !== "none") {
              const contact = getMarketingContact(
                process.env.TWILIO_PHONE_NUMBER,
                process.env.TWILIO_WHATSAPP_NUMBER,
              );
              if (getPublicEnabledChannels(contact, process.env.TWILIO_ENABLED_CHANNELS).includes("voice")) {
                replyBody = "Photo saved. Text your idea, or call us from this phone after this reply to tell it by voice.";
              }
            }
            if (unsupportedAttachment) {
              replyBody = `${replyBody.trim()}\n\n${SKIPPED_ATTACHMENT_NOTICE}`.trim();
            }
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
        if (advancedSuccessfully && resetOrDiscard && nextState !== "generating" &&
            resetStageRefs.length) {
          await clearStagedCameraPhotoReferences(message.fromAddress, resetStageRefs);
        }
        if (advancedSuccessfully && statusRequested && nextState !== "generating") {
          const latest = message.channel === "sms"
            ? await latestStoryLinkForSms({
                address: message.fromAddress,
                senderAddress: message.toAddress,
              })
            : null;
          // The source lookup proves a fresh active Voice story. For an SMS
          // result, also require this SMS conversation to still own the story;
          // an empty reset draft must not reveal retained job history.
          const eligibleLatest = latest && (
            latest.source === "voice" ||
            (conversation.activeStoryId !== null && conversation.activeStoryId === latest.storyId)
          ) ? latest : null;
          if (eligibleLatest) {
            if (nextState === "done" && activeStoryIdAfterCheckpoint === eligibleLatest.storyId) {
              replyBody = `Your comic is ready:\n${eligibleLatest.link}\n\nReply CONTINUE within ${CONVERSATION_RESUME_DAYS} days for another page, or NEW for a new comic.`;
            } else if (nextState === "confirming") {
              replyBody = `${replyBody}\n\nYour latest completed comic:\n${eligibleLatest.link}`;
            } else {
              const fromCall = eligibleLatest.source === "voice" ? " from your call" : "";
              replyBody = `Your latest comic${fromCall} is ready:\n${eligibleLatest.link}\n\nSend a new idea to start another by text.`;
            }
          } else if (completedStoryStatusId) {
            const link = await channelStoryLink({
              storyId: completedStoryStatusId,
              channel: message.channel,
              address: message.fromAddress,
            });
            replyBody = link
              ? `Your comic is ready:\n${link}\n\nReply CONTINUE within ${CONVERSATION_RESUME_DAYS} days for another page, or NEW for a new comic.`
              : "I can't show that comic link right now.\n\nReply STATUS to try again later, or NEW to start another story.";
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

    if ((job.accepted || job.job.status === "failed") && message.channel === "sms") {
      const submittedCameraRefs = submission.characterImageUrls
        .filter((ref) => ref.startsWith("blob:uploads/"));
      if (submittedCameraRefs.length) {
        // The job was admitted and owns its copied references. It may have
        // finished, including with a worker failure, before a receipt retry.
        // Keep any photo staged since this CREATE turn for the next comic.
        try {
          await clearStagedCameraPhotoReferences(message.fromAddress, submittedCameraRefs);
        } catch (error) {
          // A staging cleanup outage must not suppress the confirmation for a
          // job that is already queued and may already be running.
          console.error("Camera photo stage cleanup failed after SMS job admission", {
            messageSid: message.messageSid,
            jobId: job.job.id,
            error,
          });
        }
      }
    }

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
