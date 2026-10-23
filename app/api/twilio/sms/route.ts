import { type NextRequest } from "next/server";
import { recordActivityEvent } from "@/lib/activity-events";
import { getOrCreateChannelIdentity } from "@/lib/channel-identities";
import { sendInboundMessage } from "@/lib/generation-queue";
import { COMIC_START_MESSAGE, getEnabledChannels, getMarketingContact } from "@/lib/marketing-contact";
import {
  ConversationLeaseBusyError,
  processInboundMessage,
} from "@/lib/process-inbound-message";
import { getOldestOpenInboundMessage, recordInboundMessage } from "@/lib/twilio-events";
import { parseInboundMessage, validateTwilioSignature } from "@/lib/twilio";
import { readTwilioWebhookForm } from "@/lib/twilio-webhook-body";

export const runtime = "nodejs";

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
// Leave time for a durable queue publish before Twilio's 15-second webhook
// read timeout. An inline turn that runs longer keeps its sender lease, while
// the queued copy waits and then observes the completed receipt.
const INLINE_WEBHOOK_BUDGET_MS = 8_000;
const FAST_SMS_COMMANDS = new Set(["NEW", "RESET", "RESTART", "DISCARD", "CONTINUE", "STATUS"]);

// Twilio owns these control keywords and may already have sent its own reply.
// CANCEL in particular opts an SMS recipient out, so the comic command is DISCARD.
const TWILIO_CONTROL_KEYWORDS = new Set([
  "STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "REVOKE", "OPTOUT",
  "START", "UNSTOP", "YES", "HELP", "INFO",
]);

function emptyTwiml(): Response {
  return new Response(EMPTY_TWIML, {
    headers: { "Content-Type": "text/xml", "Cache-Control": "no-store" },
  });
}

function normalizedCommand(text: string): string {
  return text.trim().replace(/[.!?,;:…。！？]+$/u, "").trim().toUpperCase();
}

function canProcessInline(body: string, channel: string, mediaCount: number): boolean {
  if (channel !== "sms" || mediaCount !== 0) return false;
  const command = normalizedCommand(body);
  return command === normalizedCommand(COMIC_START_MESSAGE) || FAST_SMS_COMMANDS.has(command);
}

async function processWithDeadline(messageSid: string, remainingMs: number): Promise<boolean> {
  if (remainingMs <= 0) return false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  // A timed-out turn is intentionally not cancelled: cancelling between the
  // Twilio API accepting an SMS and its receipt checkpoint could resend it.
  // The promise handles late failures after the webhook returns.
  const processing = processInboundMessage(messageSid).then(
    () => true,
    (error: unknown) => {
      if (!(error instanceof ConversationLeaseBusyError)) {
        console.error("Inline SMS processing failed; queueing its receipt", error);
      }
      return false;
    },
  );
  try {
    return await Promise.race([
      processing,
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), remainingMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const startedAt = Date.now();
  const form = await readTwilioWebhookForm(request);
  if (!form.ok) return form.response;
  const { params } = form;

  const publicBaseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (!publicBaseUrl) {
    return new Response("Messaging service unavailable", { status: 503 });
  }

  const signature = request.headers.get("x-twilio-signature");
  const url = `${publicBaseUrl}${request.nextUrl.pathname}${request.nextUrl.search}`;
  if (!validateTwilioSignature({ signature, url, params })) {
    return new Response("Invalid signature", { status: 403 });
  }

  const inbound = parseInboundMessage(params);
  if (!inbound.messageSid || !inbound.from || !inbound.to) {
    return new Response("Missing Twilio message fields", { status: 400 });
  }

  const expectedChannel = request.nextUrl.pathname === "/api/twilio/whatsapp"
    ? "whatsapp"
    : "sms";
  if (inbound.channel !== expectedChannel) {
    return new Response("Incorrect messaging channel", { status: 400 });
  }

  const contact = getMarketingContact(
    process.env.TWILIO_PHONE_NUMBER,
    process.env.TWILIO_WHATSAPP_NUMBER,
  );
  if (!getEnabledChannels(contact, process.env.TWILIO_ENABLED_CHANNELS).includes(inbound.channel)) {
    return new Response("Messaging service unavailable", { status: 503 });
  }
  const configuredSender = inbound.channel === "whatsapp"
    ? contact.whatsappNumber && `whatsapp:${contact.whatsappNumber}`
    : contact.phoneNumber;
  if (!configuredSender) {
    return new Response("Messaging service unavailable", { status: 503 });
  }
  if (inbound.to !== configuredSender) {
    return new Response("Unexpected messaging sender", { status: 403 });
  }

  let userId: string;
  try {
    // Create a participant on the first text, including STOP/HELP. Otherwise
    // drafts that never become a comic disappear from the admin directory.
    userId = (await getOrCreateChannelIdentity(inbound.channel, inbound.from)).userId;
  } catch (error) {
    console.error("Inbound messaging identity failed", error);
    return new Response("Temporary messaging failure", { status: 503 });
  }

  if (
    Object.hasOwn(params, "OptOutType") ||
    TWILIO_CONTROL_KEYWORDS.has(inbound.body.toUpperCase())
  ) {
    await recordActivityEvent({
      eventKey: `message:${inbound.messageSid}:inbound`,
      userId,
      channel: inbound.channel,
      kind: "message.inbound",
      direction: "inbound",
      address: inbound.from,
      messageSid: inbound.messageSid,
      content: inbound.body,
      status: "control",
      details: { optOutType: params.OptOutType?.slice(0, 32) || null },
    }).catch((error) => console.error("Inbound control history failed", error));
    return emptyTwiml();
  }

  try {
    const receipt = await recordInboundMessage({
      messageSid: inbound.messageSid,
      channel: inbound.channel,
      fromAddress: inbound.from,
      toAddress: inbound.to,
      body: inbound.body,
      mediaUrls: inbound.mediaUrls,
      mediaContentTypes: inbound.mediaContentTypes,
    });

    await recordActivityEvent({
      eventKey: `message:${inbound.messageSid}:inbound`,
      userId,
      channel: inbound.channel,
      kind: "message.inbound",
      direction: "inbound",
      address: inbound.from,
      messageSid: inbound.messageSid,
      content: inbound.body,
      status: "received",
      details: {
        mediaCount: inbound.mediaUrls.length,
        mediaContentTypes: inbound.mediaContentTypes,
      },
    }).catch((error) => console.error("Inbound activity history failed", error));

    if (receipt.shouldEnqueue) {
      let completedInline = false;
      if (canProcessInline(inbound.body, inbound.channel, inbound.mediaUrls.length)) {
        try {
          // Do not pull an earlier arbitrary idea into the public webhook.
          // The worker can process that sender's receipts in order instead.
          const oldest = await getOldestOpenInboundMessage(inbound.channel, inbound.from);
          if (oldest?.messageSid === inbound.messageSid) {
            completedInline = await processWithDeadline(
              inbound.messageSid,
              INLINE_WEBHOOK_BUDGET_MS - (Date.now() - startedAt),
            );
          }
        } catch (error) {
          console.error("Inline SMS readiness check failed; queueing its receipt", error);
        }
      }
      if (!completedInline) await sendInboundMessage(inbound.messageSid);
    }
    return emptyTwiml();
  } catch (error) {
    console.error("Twilio messaging webhook failed", error);
    return new Response("Temporary messaging failure", { status: 503 });
  }
}
