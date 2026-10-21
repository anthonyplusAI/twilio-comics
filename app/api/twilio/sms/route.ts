import { type NextRequest } from "next/server";
import { sendInboundMessage } from "@/lib/generation-queue";
import { getEnabledChannels, getMarketingContact } from "@/lib/marketing-contact";
import { recordInboundMessage } from "@/lib/twilio-events";
import { parseInboundMessage, validateTwilioSignature } from "@/lib/twilio";

export const runtime = "nodejs";

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

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

export async function POST(request: NextRequest): Promise<Response> {
  const rawBody = await request.text();
  const params: Record<string, string> = {};
  new URLSearchParams(rawBody).forEach((value, key) => {
    params[key] = value;
  });

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

  if (
    Object.hasOwn(params, "OptOutType") ||
    TWILIO_CONTROL_KEYWORDS.has(inbound.body.toUpperCase())
  ) {
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

    if (receipt.shouldEnqueue) {
      await sendInboundMessage(inbound.messageSid);
    }
    return emptyTwiml();
  } catch (error) {
    console.error("Twilio messaging webhook failed", error);
    return new Response("Temporary messaging failure", { status: 503 });
  }
}
