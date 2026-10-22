import { type NextRequest } from "next/server";
import { recordAgentMessageStatus } from "@/lib/twilio-events";
import {
  isDeliveryStatus,
  recordFallbackMessageStatus,
  recordFailedGenerationNoticeStatus,
  recordGeneratedMessageStatus,
  sendFailedMmsTextFallback,
} from "@/lib/twilio-delivery";
import { validateTwilioSignature } from "@/lib/twilio";
import { readTwilioWebhookForm } from "@/lib/twilio-webhook-body";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const MESSAGE_SID = /^(SM|MM)[0-9a-f]{32}$/i;

export async function POST(request: NextRequest): Promise<Response> {
  const form = await readTwilioWebhookForm(request);
  if (!form.ok) return form.response;
  const { params } = form;

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

  const jobId = request.nextUrl.searchParams.get("jobId");
  const inboundSid = request.nextUrl.searchParams.get("inboundSid");
  const fallback = request.nextUrl.searchParams.get("fallback");
  const failure = request.nextUrl.searchParams.get("failure");
  const messageSid = params.MessageSid || "";
  const status = params.MessageStatus || "";
  if (Boolean(jobId) === Boolean(inboundSid) ||
      (jobId !== null && !UUID.test(jobId)) ||
      (inboundSid !== null && !MESSAGE_SID.test(inboundSid)) ||
      !MESSAGE_SID.test(messageSid) || !status ||
      (fallback !== null && (fallback !== "1" || !jobId)) ||
      (failure !== null && (failure !== "1" || !jobId || fallback !== null))) {
    return new Response("Invalid delivery callback", { status: 400 });
  }
  if (!isDeliveryStatus(status)) {
    // Twilio can add status values. Acknowledge an unrecognized value rather
    // than repeatedly retrying a callback we cannot interpret yet.
    return new Response(null, { status: 204 });
  }

  if (inboundSid) {
    try {
      await recordAgentMessageStatus({
        inboundSid,
        messageSid,
        status,
        errorCode: params.ErrorCode?.slice(0, 32) || null,
      });
    } catch (error) {
      console.error("Failed to record agent message status", error);
      return new Response("Temporary delivery status failure", { status: 503 });
    }
    return new Response(null, { status: 204 });
  }

  if (failure === "1") {
    try {
      await recordFailedGenerationNoticeStatus({
        jobId: jobId!,
        messageSid,
        status,
        errorCode: params.ErrorCode?.slice(0, 32) || null,
      });
    } catch (error) {
      console.error("Failed to record generation notice status", error);
      return new Response("Temporary delivery status failure", { status: 503 });
    }
    return new Response(null, { status: 204 });
  }

  try {
    const record = fallback === "1"
      ? recordFallbackMessageStatus
      : recordGeneratedMessageStatus;
    const recorded = await record({
      jobId: jobId!,
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
      await sendFailedMmsTextFallback(jobId!);
    } catch (error) {
      // The recovery Job retries bounded fallback attempts after transient
      // failures; acknowledge this callback to avoid a burst of duplicates.
      console.error("Failed to send comic text fallback", jobId, error);
    }
  }
  return new Response(null, { status: 204 });
}
