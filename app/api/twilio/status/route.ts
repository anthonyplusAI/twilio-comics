import { type NextRequest } from "next/server";
import {
  isDeliveryStatus,
  recordFallbackMessageStatus,
  recordGeneratedMessageStatus,
  sendFailedMmsTextFallback,
} from "@/lib/twilio-delivery";
import { validateTwilioSignature } from "@/lib/twilio";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const MESSAGE_SID = /^(SM|MM)[0-9a-f]{32}$/i;

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

  const callbackUrl = `${publicBaseUrl}${request.nextUrl.pathname}${request.nextUrl.search}`;
  if (!validateTwilioSignature({
    signature: request.headers.get("x-twilio-signature"),
    url: callbackUrl,
    params,
  })) {
    return new Response("Invalid signature", { status: 403 });
  }

  const jobId = request.nextUrl.searchParams.get("jobId") || "";
  const fallback = request.nextUrl.searchParams.get("fallback");
  const messageSid = params.MessageSid || "";
  const status = params.MessageStatus || "";
  if (!UUID.test(jobId) || !MESSAGE_SID.test(messageSid) || !status ||
      (fallback !== null && fallback !== "1")) {
    return new Response("Invalid delivery callback", { status: 400 });
  }
  if (!isDeliveryStatus(status)) {
    // Twilio can add status values. Acknowledge an unrecognized value rather
    // than repeatedly retrying a callback we cannot interpret yet.
    return new Response(null, { status: 204 });
  }

  try {
    const record = fallback === "1"
      ? recordFallbackMessageStatus
      : recordGeneratedMessageStatus;
    const recorded = await record({
      jobId,
      messageSid,
      status,
      errorCode: params.ErrorCode?.slice(0, 32) || null,
    });
    if (!fallback && recorded && (status === "failed" || status === "undelivered")) {
      console.warn("Comic message delivery failed", { jobId, errorCode: params.ErrorCode || null });
    }
  } catch (error) {
    console.error("Failed to record Twilio message status", error);
    return new Response("Temporary delivery status failure", { status: 503 });
  }

  if (!fallback && (status === "failed" || status === "undelivered")) {
    try {
      await sendFailedMmsTextFallback(jobId);
    } catch (error) {
      // The recovery Job retries bounded fallback attempts after transient
      // failures; acknowledge this callback to avoid a burst of duplicates.
      console.error("Failed to send comic text fallback", jobId, error);
    }
  }
  return new Response(null, { status: 204 });
}
