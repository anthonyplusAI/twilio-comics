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

/** Authorization is sent only in Twilio's signed, short-lived setup message. */
export function voiceConversationRelayTwiML(
  publicBaseUrl: string,
  relayUrl: string,
  authorization: string,
): Response {
  const greeting =
    "Welcome to Twilio Comics. Our AI agent transcribes this call to create your comic. " +
    "If you approve it, I'll text a link to the number you're calling from. " +
    "Hang up now if you don't want a text. You can find privacy and terms on our website. " +
    "Tell me your comic idea, or say continue to add a page to a finished story.";
  return voiceTwiMLResponse(
    `<Connect action="${escapeXml(`${publicBaseUrl}/api/twilio/voice/action`)}" method="POST">` +
    `<ConversationRelay url="${escapeXml(relayUrl)}" ` +
    `welcomeGreeting="${escapeXml(greeting)}" welcomeGreetingInterruptible="none" ` +
    `ttsProvider="Google" transcriptionProvider="Deepgram" language="en-US" interruptible="any">` +
    `<Parameter name="authorization" value="${escapeXml(authorization)}"/>` +
    `</ConversationRelay></Connect>`,
  );
}
