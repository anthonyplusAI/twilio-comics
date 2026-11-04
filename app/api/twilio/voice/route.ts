import { type NextRequest } from "next/server";
import { getEnabledChannels, getMarketingContact } from "@/lib/marketing-contact";
import { getExperienceSettings } from "@/lib/photo-experience-settings";
import { getVoiceCallPhotoReadiness } from "@/lib/voice-call-photo-readiness";
import { validateTwilioSignature } from "@/lib/twilio";
import { readTwilioWebhookForm } from "@/lib/twilio-webhook-body";
import {
  finishVoiceVerificationStart,
  reserveVoiceVerificationStart,
} from "@/lib/voice-verification-budget";
import { getConversationRelayUrl, voiceHangupTwiML, voiceMissingPhotoPrompt, voiceVerificationGatherTwiML } from "@/lib/voice-twiml";
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
  const enabledChannels = getEnabledChannels(contact, process.env.TWILIO_ENABLED_CHANNELS);
  const configuredNumber = enabledChannels.includes("voice") ? contact.phoneNumber : null;
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

  let photoMode: Awaited<ReturnType<typeof getExperienceSettings>>;
  try {
    photoMode = await getExperienceSettings();
  } catch (error) {
    console.error("Voice photo availability check failed", error instanceof Error ? error.name : "unknown");
    return new Response("Voice service unavailable", { status: 503 });
  }
  if (photoMode.voicePhotoMode === "none") {
    return voiceHangupTwiML(
      "Voice comics are paused because a reference photo is required. Please use a photo-enabled option on our start page.",
    );
  }
  try {
    const readiness = await getVoiceCallPhotoReadiness(params.From, photoMode);
    if (readiness.kind === "missing") {
      if (!enabledChannels.includes("sms")) {
        return voiceHangupTwiML(
          "A reference photo is required before a comic can be created, but photo setup is unavailable right now. Please try again later.",
        );
      }
      return voiceHangupTwiML(voiceMissingPhotoPrompt(enabledChannels.includes("sms")));
    }
  } catch (error) {
    console.error("Voice photo readiness check failed", error instanceof Error ? error.name : "unknown");
    return voiceHangupTwiML("I couldn't check your photos right now. Please try your call again later.");
  }

  const reservation = await reserveVoiceVerificationStart({
    callSid: params.CallSid,
    fromAddress: params.From,
    toAddress: params.To,
  });
  if (!reservation.allowed) {
    return voiceHangupTwiML(reservation.reason === "rate_limit"
      ? "We've reached a temporary verification limit. Please try again later."
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
