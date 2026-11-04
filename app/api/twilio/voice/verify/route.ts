import { type NextRequest } from "next/server";
import { getEnabledChannels, getMarketingContact } from "@/lib/marketing-contact";
import { validateTwilioSignature } from "@/lib/twilio";
import { readTwilioWebhookForm } from "@/lib/twilio-webhook-body";
import { createVoiceCallAuthorization } from "@/lib/voice-call-authorization";
import { reserveVoiceCallBudget } from "@/lib/voice-call-budget";
import { getVoiceCallPhotoReadiness } from "@/lib/voice-call-photo-readiness";
import { getExperienceSettings } from "@/lib/photo-experience-settings";
import {
  getConversationRelayUrl,
  voiceConversationRelayTwiML,
  voiceHangupTwiML,
  voiceMissingPhotoPrompt,
  voiceVerificationGatherTwiML,
} from "@/lib/voice-twiml";
import { checkVoiceVerification, isVoiceVerificationConfigured } from "@/lib/voice-verification";

export const runtime = "nodejs";

const E164 = /^\+[1-9]\d{6,14}$/;
const CALL_SID = /^CA[0-9a-f]{32}$/i;
const SIX_DIGITS = /^\d{6}$/;
const MAX_ATTEMPTS = 3;

/** Twilio posts the DTMF code here; it must never enter Relay or the transcript. */
export async function POST(request: NextRequest): Promise<Response> {
  const attemptParam = request.nextUrl.searchParams.get("attempt");
  const attempt = attemptParam ? Number(attemptParam) : NaN;
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_ATTEMPTS ||
      request.nextUrl.search !== `?attempt=${attempt}`) {
    return new Response("Invalid verification attempt", { status: 400 });
  }
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
      url: `${publicBaseUrl}/api/twilio/voice/verify?attempt=${attempt}`,
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
  const relayUrl = getConversationRelayUrl();
  const authSecret = process.env.AUTH_SECRET;
  if (!configuredNumber || !process.env.TWILIO_ACCOUNT_SID ||
      !isVoiceVerificationConfigured() || !relayUrl || !authSecret) {
    return new Response("Voice service unavailable", { status: 503 });
  }
  if (params.AccountSid !== process.env.TWILIO_ACCOUNT_SID || params.To !== configuredNumber) {
    return new Response("Unexpected Voice sender", { status: 403 });
  }
  if (!CALL_SID.test(params.CallSid || "") || !E164.test(params.From || "")) {
    return new Response("Invalid Voice call", { status: 400 });
  }

  const code = params.Digits || "";
  if (SIX_DIGITS.test(code)) {
    let verified: boolean;
    try {
      verified = await checkVoiceVerification(params.From, code);
    } catch (error) {
      console.error("Voice caller verification check failed", error instanceof Error ? error.name : "unknown");
      return voiceHangupTwiML(
        "I couldn't verify this call right now. Please call again later.",
      );
    }
    if (verified) {
      let readiness: Awaited<ReturnType<typeof getVoiceCallPhotoReadiness>>;
      try {
        const settings = await getExperienceSettings();
        if (settings.voicePhotoMode === "none") {
          return voiceHangupTwiML(
            "Voice comics are paused because a reference photo is required. Please use a photo-enabled option on our start page.",
          );
        }
        readiness = await getVoiceCallPhotoReadiness(params.From, settings);
      } catch (error) {
        console.error("Voice photo readiness check failed", error instanceof Error ? error.name : "unknown");
        return voiceHangupTwiML(
          "I couldn't check your photos right now. Please call again later.",
        );
      }
      if (readiness.kind === "missing") {
        return voiceHangupTwiML(voiceMissingPhotoPrompt(enabledChannels.includes("sms")));
      }
      try {
        const budget = await reserveVoiceCallBudget({
          callSid: params.CallSid,
          fromAddress: params.From,
          toAddress: params.To,
        });
        if (!budget.allowed) {
          return voiceHangupTwiML(budget.reason === "rate_limit"
            ? "Your number has reached the Voice call limit for the last 24 hours. Please try again later."
            : "I couldn't start the comic conversation right now. Please try again later.");
        }
        const authorization = createVoiceCallAuthorization({
          callSid: params.CallSid,
          from: params.From,
          to: params.To,
        }, authSecret);
        return voiceConversationRelayTwiML(publicBaseUrl, relayUrl, authorization, readiness);
      } catch (error) {
        console.error("Voice conversation start failed", error instanceof Error ? error.name : "unknown");
        return voiceHangupTwiML(
          "I couldn't start your comic conversation right now. Please call again later.",
        );
      }
    }
  }

  if (attempt >= MAX_ATTEMPTS) {
    return voiceHangupTwiML(
      "I couldn't verify this call. Please call again if you want to try a new code.",
    );
  }
  return voiceVerificationGatherTwiML(
    publicBaseUrl,
    attempt + 1,
    SIX_DIGITS.test(code)
      ? "That code didn't work. Please enter the six digit code from your text on the keypad."
      : "I didn't get a full code. Please enter the six digit code from your text on the keypad.",
  );
}
