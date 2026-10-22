import { type NextRequest } from "next/server";
import { getEnabledChannels, getMarketingContact } from "@/lib/marketing-contact";
import { validateTwilioSignature } from "@/lib/twilio";
import { readTwilioWebhookForm } from "@/lib/twilio-webhook-body";
import {
  finishVoiceVerificationStart,
  reserveVoiceVerificationStart,
} from "@/lib/voice-verification-budget";
import { getConversationRelayUrl, voiceHangupTwiML, voiceVerificationGatherTwiML } from "@/lib/voice-twiml";
import { isVoiceVerificationConfigured, startVoiceVerification } from "@/lib/voice-verification";

export const runtime = "nodejs";

const E164 = /^\+[1-9]\d{6,14}$/;
const CALL_SID = /^CA[0-9a-f]{32}$/i;

export async function POST(request: NextRequest): Promise<Response> {
  const form = await readTwilioWebhookForm(request);
  if (!form.ok) return form.response;
  const { params } = form;

  const publicBaseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (!publicBaseUrl) {
    return new Response("Voice service unavailable", { status: 503 });
  }
  try {
    if (!validateTwilioSignature({
      signature: request.headers.get("x-twilio-signature"),
      url: `${publicBaseUrl}/api/twilio/voice`,
      params,
    })) {
      return new Response("Invalid signature", { status: 403 });
    }
  } catch {
    return new Response("Voice service unavailable", { status: 503 });
  }

  const contact = getMarketingContact(
    process.env.TWILIO_PHONE_NUMBER,
    process.env.TWILIO_WHATSAPP_NUMBER,
  );
  const configuredNumber = getEnabledChannels(contact, process.env.TWILIO_ENABLED_CHANNELS)
    .includes("voice") ? contact.phoneNumber : null;
  if (!configuredNumber || !process.env.TWILIO_ACCOUNT_SID ||
      !isVoiceVerificationConfigured() || !process.env.AUTH_SECRET ||
      !getConversationRelayUrl()) {
    return new Response("Voice service unavailable", { status: 503 });
  }
  if (params.AccountSid !== process.env.TWILIO_ACCOUNT_SID || params.To !== configuredNumber) {
    return new Response("Unexpected Voice sender", { status: 403 });
  }
  if (!CALL_SID.test(params.CallSid || "")) {
    return new Response("Invalid Voice call", { status: 400 });
  }
  if (!E164.test(params.From || "")) {
    return voiceHangupTwiML(
      "Please call from a phone number that can receive text messages, then try again.",
    );
  }

  const reservation = await reserveVoiceVerificationStart({
    callSid: params.CallSid,
    fromAddress: params.From,
    toAddress: params.To,
  });
  if (!reservation.allowed) {
    return voiceHangupTwiML(reservation.reason === "rate_limit"
      ? "This number has requested too many verification codes. Please try again later."
      : "I couldn't start verification for this call. Please try again later.");
  }

  if (reservation.sendCode) {
    try {
      await startVoiceVerification(params.From);
    } catch (error) {
      console.error("Voice caller verification could not start", error instanceof Error ? error.name : "unknown");
      await finishVoiceVerificationStart(params.CallSid, "failed").catch((finishError) =>
        console.error("Voice verification failure history could not finish", finishError instanceof Error ? finishError.name : "unknown"),
      );
      return voiceHangupTwiML(
        "I couldn't send a verification code right now. Please try again later.",
      );
    }
    try {
      await finishVoiceVerificationStart(params.CallSid, "sent");
    } catch (error) {
      console.error("Voice verification history could not finish", error instanceof Error ? error.name : "unknown");
      return voiceHangupTwiML(
        "I couldn't complete verification for this call. Please try again later.",
      );
    }
  }

  return voiceVerificationGatherTwiML(
    publicBaseUrl,
    1,
    "To protect your comic ideas, we just sent a text with a six digit code to the phone you are calling from. When it arrives, enter the code on your keypad.",
  );
}
