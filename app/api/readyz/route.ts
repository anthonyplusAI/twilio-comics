import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { getEnabledChannels, getMarketingContact, type MarketingChannel } from "@/lib/marketing-contact";
import { getConversationRelayUrl } from "@/lib/voice-twiml";
import { isVoiceVerificationConfigured } from "@/lib/voice-verification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REQUIRED = [
  "DATABASE_URL",
  "AUTH_SECRET",
  "ADMIN_USERNAME",
  "ADMIN_PASSWORD_HASH",
  "AZURE_STORAGE_BLOB_ENDPOINT",
  "AZURE_STORAGE_QUEUE_ENDPOINT",
  "AZURE_STORAGE_CONTAINER_NAME",
  "AZURE_STORAGE_QUEUE_NAME",
  "AZURE_CLIENT_ID",
  "MEDIA_SIGNING_SECRET",
  "OPENAI_API_KEY",
  "PUBLIC_BASE_URL",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
] as const;
const ACCOUNT_SID = /^AC[0-9a-f]{32}$/i;

function validPublicOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) &&
      !url.username && !url.password && !url.search && !url.hash &&
      url.pathname === "/";
  } catch {
    return false;
  }
}

function response(ready: boolean, dependency: string | null, status: number): Response {
  return Response.json(
    ready
      ? { ready: true, release: process.env.RELEASE_SHA || "unknown" }
      : { ready: false, dependency },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * Deployment smoke probe. Liveness stays at /api/healthz; this checks that the
 * new revision can reach the migrated durable database and has release config.
 */
export async function GET(): Promise<Response> {
  if (REQUIRED.some((name) => !process.env[name]?.trim())) {
    return response(false, "configuration", 503);
  }
  if (!ACCOUNT_SID.test(process.env.TWILIO_ACCOUNT_SID || "") ||
      !validPublicOrigin(process.env.PUBLIC_BASE_URL || "")) {
    return response(false, "configuration", 503);
  }

  const contact = getMarketingContact(
    process.env.TWILIO_PHONE_NUMBER,
    process.env.TWILIO_WHATSAPP_NUMBER,
  );
  const requested = process.env.TWILIO_ENABLED_CHANNELS?.split(",")
    .map((channel) => channel.trim().toLowerCase())
    .filter(Boolean) ?? [];
  const enabled = getEnabledChannels(contact, process.env.TWILIO_ENABLED_CHANNELS);
  if (requested.some((channel) => !enabled.includes(channel as MarketingChannel))) {
    return response(false, "configuration", 503);
  }
  if (enabled.includes("voice") &&
      (!isVoiceVerificationConfigured() || !getConversationRelayUrl())) {
    return response(false, "configuration", 503);
  }

  try {
    // A connection to an empty or unrelated PostgreSQL database is not ready.
    // These tables are required by the channel and admin release paths.
    await db.execute(sql`
      SELECT 1
      FROM public.users,
           public.generation_jobs,
           public.activity_events,
           public.voice_calls,
           public.admin_login_attempts
      LIMIT 0
    `);
    return response(true, null, 200);
  } catch (error) {
    console.error("Readiness database check failed", error instanceof Error ? error.name : "unknown");
    return response(false, "database", 503);
  }
}
