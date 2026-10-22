import { type NextRequest } from "next/server";
import { recordVoiceCallEnd, recordVoiceTurn } from "@/lib/activity-events";
import { getEnabledChannels, getMarketingContact } from "@/lib/marketing-contact";
import { validateTwilioSignature } from "@/lib/twilio";
import { readTwilioWebhookForm } from "@/lib/twilio-webhook-body";

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

const CALL_SID = /^CA[0-9a-f]{32}$/i;

function handoff(raw: string | undefined): { result?: string; turn?: number } {
  if (!raw || raw.length > 256) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "result" in parsed) {
      const data = parsed as { result?: unknown; turn?: unknown };
      return {
        result: typeof data.result === "string" ? data.result : undefined,
        turn: typeof data.turn === "number" && Number.isInteger(data.turn) && data.turn > 0 && data.turn <= 21
          ? data.turn
          : undefined,
      };
    }
  } catch {
    // A dropped socket has no application handoff payload.
  }
  return {};
}

function durationSeconds(value: string | undefined): number | null {
  if (!value || !/^\d{1,6}$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds <= 86_400 ? seconds : null;
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

  const form = await readTwilioWebhookForm(request);
  if (!form.ok) return form.response;
  const { params } = form;
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

  const handoffData = handoff(params.HandoffData);
  const callDuration = durationSeconds(params.CallDuration);
  const relayDuration = durationSeconds(params.SessionDuration);
  const duration = callDuration ?? relayDuration;
  const knownResults = new Set([
    "queued", "quota_rejected", "capacity_rejected", "checking", "invalid_setup", "stale", "service_error", "limit_reached",
  ]);
  const result = handoffData.result && knownResults.has(handoffData.result)
    ? handoffData.result
    : params.CallStatus === "completed" ? "completed" : "disconnected";

  const retry = retryInstruction();
  let spoken: string | undefined;
  switch (params.CallStatus === "completed" ? "completed" : result) {
    case "queued":
      spoken = "Your comic is being created. I'll text your comic to this number when it's ready. Goodbye.";
      break;
    case "quota_rejected":
      spoken = "You've reached the free comic limit for this week. Please try again later. Goodbye.";
      break;
    case "capacity_rejected":
      spoken = "Today's comic studio is full. Your idea is saved. Please call again tomorrow. Goodbye.";
      break;
    case "checking":
      spoken = "I'm checking your comic request. If it started, I'll text the result when it's ready. Please call again for status if nothing arrives.";
      break;
    case "invalid_setup":
      spoken = "I couldn't set up this call. Please call again from a number that can receive text messages.";
      break;
    case "stale":
      spoken = "Another call changed this comic conversation. Please call again from this number.";
      break;
    case "service_error":
      spoken = `I couldn't connect to your comic conversation right now. Please ${retry}.`;
      break;
    case "limit_reached":
      spoken = "This call has reached its time limit. Your saved idea is still here. Please call again to continue. Goodbye.";
      break;
    case "completed":
      break;
    default:
      spoken = `The call connection was lost. If you approved a comic, we'll text it when it's ready. Otherwise, please ${retry}.`;
  }

  if (CALL_SID.test(params.CallSid || "") && params.From && params.To) {
    try {
      await recordVoiceCallEnd({
        callSid: params.CallSid,
        fromAddress: params.From,
        toAddress: params.To,
        status: result,
        durationSeconds: duration,
        durationSource: callDuration !== null ? "call"
          : relayDuration !== null ? "conversation_relay" : "measured",
        errorCode: /^\d{1,8}$/.test(params.ErrorCode || "") ? params.ErrorCode : null,
        sessionStatus: params.SessionStatus?.slice(0, 32) || null,
        callStatus: params.CallStatus?.slice(0, 32) || null,
      });
    } catch (error) {
      console.error("Voice action summary failed", error instanceof Error ? error.name : "unknown");
    }
    if (spoken) {
      try {
        await recordVoiceTurn({
          callSid: params.CallSid,
          address: params.From,
          sequence: handoffData.turn || 0,
          role: "agent",
          phase: "action",
          content: spoken,
        });
      } catch (error) {
        console.error("Voice action transcript failed", error instanceof Error ? error.name : "unknown");
      }
    }
  }

  return twiml(spoken);
}
