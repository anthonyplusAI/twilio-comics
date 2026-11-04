import type { VoiceCallPhotoReadiness } from "@/lib/voice-call-photo-readiness";

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function voiceTwiMLResponse(xml: string): Response {
  return new Response(`${XML_HEADER}<Response>${xml}</Response>`, {
    headers: { "Content-Type": "text/xml", "Cache-Control": "no-store" },
  });
}

export function voiceHangupTwiML(message: string): Response {
  return voiceTwiMLResponse(`<Say>${escapeXml(message)}</Say><Hangup/>`);
}

/** Never collect verification digits with ConversationRelay ASR. */
export function voiceVerificationGatherTwiML(
  publicBaseUrl: string,
  attempt: number,
  prompt: string,
): Response {
  const action = escapeXml(`${publicBaseUrl}/api/twilio/voice/verify?attempt=${attempt}`);
  return voiceTwiMLResponse(
    `<Gather action="${action}" method="POST" input="dtmf" numDigits="6" ` +
    `timeout="30" actionOnEmptyResult="true"><Say>${escapeXml(prompt)}</Say></Gather>`,
  );
}

export function getConversationRelayUrl(): string | null {
  try {
    const url = new URL(process.env.CONVERSATION_RELAY_WS_URL || "");
    if (url.protocol !== "wss:" || url.pathname !== "/relay" ||
        url.username || url.password || url.hash || url.search) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function voiceMissingPhotoPrompt(canText: boolean): string {
  return canText
    ? "I can't find a saved reference photo for this call. Text one or two photos to this number from the same phone you're calling on. Wait for the Photo saved reply, then call again."
    : "I can't find a saved reference photo for this call. Photo setup for calls is unavailable right now. Please try again later.";
}

function voiceGreeting(readiness: VoiceCallPhotoReadiness): string {
  const disclosure =
    "Welcome to Twilio Comics. Our AI agent transcribes this call. " +
    "We text comic links to the number you're calling from. " +
    "Hang up now if you don't want a text. You can find privacy and terms on our website. ";
  if (readiness.kind === "photos") {
    return disclosure +
      `I found ${readiness.count >= 2 ? "two saved reference photos" : "one saved reference photo"}. ` +
      "Tell me who is in your comic and what happens. I'll ask which style you want, then recap your idea. You can correct anything, then say create it when you're ready.";
  }
  if (readiness.kind === "continuation") {
    if (readiness.phase === "draft") {
      return disclosure +
        "Your next-page draft is saved. Tell me what to add or change. " +
        "I'll recap it; say create it when you're ready.";
    }
    return disclosure +
      "Your finished comic is ready. Say continue to add a new page. " +
      "For a new comic, hang up and text new photos to this number, then call back.";
  }
  return disclosure +
    "I'm still creating your comic. I'll text the link when it's ready. " +
    "Say status for an update, or new to start over after this result.";
}

/** Authorization is sent only in Twilio's signed, short-lived setup message. */
export function voiceConversationRelayTwiML(
  publicBaseUrl: string,
  relayUrl: string,
  authorization: string,
  readiness: VoiceCallPhotoReadiness,
): Response {
  if (readiness.kind === "missing" ||
      (readiness.kind === "photos" && readiness.count < 1)) {
    return voiceHangupTwiML(
      "I couldn't find a saved photo for this call. Text a reference photo to this number from your phone, then call again.",
    );
  }
  const greeting = voiceGreeting(readiness);
  return voiceTwiMLResponse(
    `<Connect action="${escapeXml(`${publicBaseUrl}/api/twilio/voice/action`)}" method="POST">` +
    `<ConversationRelay url="${escapeXml(relayUrl)}" ` +
    `welcomeGreeting="${escapeXml(greeting)}" welcomeGreetingInterruptible="none" ` +
    `ttsProvider="Google" transcriptionProvider="Deepgram" language="en-US" interruptible="any">` +
    `<Parameter name="authorization" value="${escapeXml(authorization)}"/>` +
    `</ConversationRelay></Connect>`,
  );
}
