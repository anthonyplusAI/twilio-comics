import { type NextRequest } from "next/server";
import { getEnabledChannels, getMarketingContact } from "@/lib/marketing-contact";
import { validateTwilioSignature } from "@/lib/twilio";

export const runtime = "nodejs";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function twiml(message?: string): Response {
  const xml = message
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(message)}</Say><Hangup/></Response>`
    : '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
  return new Response(xml, {
    headers: { "Content-Type": "text/xml", "Cache-Control": "no-store" },
  });
}

function handoffResult(raw: string | undefined): string | undefined {
  if (!raw || raw.length > 256) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "result" in parsed) {
      return typeof parsed.result === "string" ? parsed.result : undefined;
    }
  } catch {
    // A dropped socket has no application handoff payload.
  }
  return undefined;
}

function retryInstruction(): string {
  const contact = getMarketingContact(
    process.env.TWILIO_PHONE_NUMBER,
    process.env.TWILIO_WHATSAPP_NUMBER,
  );
  const channels = getEnabledChannels(contact, process.env.TWILIO_ENABLED_CHANNELS);
  const options: string[] = [];

  if (channels.includes("voice")) options.push("call again");
  if (channels.includes("sms")) {
    options.push("text your idea to this number");
  } else if (channels.includes("whatsapp")) {
    options.push("start a WhatsApp chat from our website");
  }

  return options.length ? options.join(" or ") : "try again later";
}

/** Twilio requests this signed URL when <Connect><ConversationRelay> exits. */
export async function POST(request: NextRequest): Promise<Response> {
  const publicBaseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  if (!publicBaseUrl) {
    return new Response("Voice service unavailable", { status: 503 });
  }

  const params: Record<string, string> = {};
  new URLSearchParams(await request.text()).forEach((value, key) => {
    params[key] = value;
  });
  const signature = request.headers.get("x-twilio-signature");
  const signedUrl = `${publicBaseUrl}/api/twilio/voice/action`;
  try {
    if (!validateTwilioSignature({ signature, url: signedUrl, params })) {
      return new Response("Invalid signature", { status: 403 });
    }
  } catch (error) {
    console.error("Voice action signature validation unavailable", error);
    return new Response("Voice service unavailable", { status: 503 });
  }

  if (params.CallStatus === "completed") return twiml();

  const retry = retryInstruction();

  switch (handoffResult(params.HandoffData)) {
    case "queued":
      return twiml("Your comic is being created. I'll text your comic to this number when it's ready. Goodbye.");
    case "quota_rejected":
      return twiml("You've reached the free comic limit for this week. Please try again later. Goodbye.");
    case "checking":
      return twiml("I'm checking your comic request. If it started, I'll text the result when it's ready. Please call again for status if nothing arrives.");
    case "invalid_setup":
      return twiml("I couldn't set up this call. Please call again from a number that can receive text messages.");
    case "stale":
      return twiml("Another call changed this comic conversation. Please call again from this number.");
    case "service_error":
      return twiml(`I couldn't connect to your comic conversation right now. Please ${retry}.`);
    default:
      return twiml(`The call connection was lost. If you approved a comic, we'll text it when it's ready. Otherwise, please ${retry}.`);
  }
}
