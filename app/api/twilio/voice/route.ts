import { type NextRequest } from "next/server";
import { getEnabledChannels, getMarketingContact } from "@/lib/marketing-contact";
import { validateTwilioSignature } from "@/lib/twilio";

export const runtime = "nodejs";

function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const params: Record<string, string> = {};
  new URLSearchParams(rawBody).forEach((v, k) => {
    params[k] = v;
  });

  const publicBaseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (!publicBaseUrl) {
    return new Response("Voice service unavailable", { status: 503 });
  }
  const url = `${publicBaseUrl}/api/twilio/voice`;
  const signature = request.headers.get("x-twilio-signature");
  try {
    if (!validateTwilioSignature({ signature, url, params })) {
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
  if (!configuredNumber) {
    return new Response("Voice service unavailable", { status: 503 });
  }
  if (params.To !== configuredNumber) {
    return new Response("Unexpected Voice sender", { status: 403 });
  }

  const configuredWsUrl = process.env.CONVERSATION_RELAY_WS_URL;
  let relayUrl: URL;
  try {
    relayUrl = new URL(configuredWsUrl || "");
  } catch {
    console.error("CONVERSATION_RELAY_WS_URL is missing or invalid");
    return new Response("Voice service unavailable", { status: 503 });
  }
  if (
    relayUrl.protocol !== "wss:" ||
    relayUrl.pathname !== "/relay" ||
    relayUrl.username || relayUrl.password || relayUrl.hash
  ) {
    console.error("CONVERSATION_RELAY_WS_URL must point to the secure /relay endpoint");
    return new Response("Voice service unavailable", { status: 503 });
  }

  const wsUrl = escapeXmlAttr(relayUrl.toString());
  const actionUrl = escapeXmlAttr(`${publicBaseUrl}/api/twilio/voice/action`);
  const greeting = escapeXmlAttr(
    "Welcome to Twilio Comics! Tell me your comic idea. If you have a finished story, say continue to add another page.",
  );

  const xml = `<?xml version="1.0" encoding="UTF-8"?><Response><Connect action="${actionUrl}" method="POST"><ConversationRelay url="${wsUrl}" welcomeGreeting="${greeting}" ttsProvider="Google" transcriptionProvider="Deepgram" language="en-US" interruptible="any"/></Connect></Response>`;

  return new Response(xml, { headers: { "Content-Type": "text/xml", "Cache-Control": "no-store" } });
}
