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
      SELECT stories.dub_key, stories.dub_short_url, stories.dub_link_id
      FROM public.users,
           public.generation_jobs,
           public.activity_events,
           public.voice_calls,
           public.admin_login_attempts,
           public.admin_credentials,
           public.experience_settings,
           public.stories AS stories
      LIMIT 0
    `);

    const credentials = await db.execute(sql`
      SELECT username, password_hash
      FROM public.admin_credentials
      LIMIT 1
    `);
    const active = credentials.rows[0] as
      | { username?: string; password_hash?: string }
      | undefined;
    if (active) {
      if (!active.username?.trim() || !active.password_hash?.trim()) {
        return response(false, "configuration", 503);
      }
    } else if (!process.env.ADMIN_USERNAME?.trim() ||
               !process.env.ADMIN_PASSWORD_HASH?.trim()) {
      return response(false, "configuration", 503);
    }

    // Admin rotation needs writes on a table created by the migration role.
    // Catch a missing default grant before publishing the new app revision.
    const privileges = await db.execute(sql`
      SELECT
        has_table_privilege(current_user, 'public.admin_credentials', 'INSERT') AS can_insert,
        has_table_privilege(current_user, 'public.admin_credentials', 'UPDATE') AS can_update
    `);
    const grants = privileges.rows[0] as
      | { can_insert?: boolean; can_update?: boolean }
      | undefined;
    if (!grants?.can_insert || !grants?.can_update) {
      return response(false, "database", 503);
    }
    return response(true, null, 200);
  } catch (error) {
    console.error("Readiness database check failed", error instanceof Error ? error.name : "unknown");
    return response(false, "database", 503);
  }
}
