import { sql } from "drizzle-orm";
import { CONVERSATION_RESUME_DAYS } from "@/lib/conversation-policy";
import { db } from "@/lib/db";
import type { TwilioMessageChannel } from "@/lib/twilio";

const E164 = /^\+[1-9]\d{6,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9-]{1,160}$/;

export interface LatestSmsStoryLink {
  storyId: string;
  source: "sms" | "voice";
  link: string;
}

function publicBaseUrl(): URL | null {
  const configured = process.env.PUBLIC_BASE_URL;
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol === "https:") return url;
    if (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      return url;
    }
  } catch {
    // Invalid configuration cannot produce a safe public link.
  }
  return null;
}

/** Only the existing exact sender/channel identity may receive its story link. */
export async function channelStoryLink(input: {
  storyId: string;
  channel: TwilioMessageChannel;
  address: string;
}): Promise<string | null> {
  const base = publicBaseUrl();
  const whatsapp = input.channel === "whatsapp";
  const prefixed = /^whatsapp:/i.test(input.address);
  const normalizedAddress = input.address.replace(/^whatsapp:/i, "");
  if (!base || !UUID.test(input.storyId) || whatsapp !== prefixed ||
      !E164.test(normalizedAddress)) return null;

  const result = await db.execute(sql`
    SELECT story.slug
    FROM stories AS story
    JOIN channel_identities AS identity ON identity.user_id = story.user_id
    WHERE story.id = ${input.storyId}::uuid
      AND identity.provider = 'twilio'
      AND identity.channel = ${input.channel}
      AND identity.address = ${input.address}
      AND identity.normalized_address = ${normalizedAddress}
    LIMIT 1
  `);
  const rows = Array.isArray(result)
    ? result : "rows" in result && Array.isArray(result.rows) ? result.rows : null;
  if (!rows) throw new Error("Unexpected story access query result");
  const slug = (rows[0] as { slug?: unknown } | undefined)?.slug;
  if (typeof slug !== "string" || !SLUG.test(slug)) return null;
  return new URL(`/story/${encodeURIComponent(slug)}`, base).toString();
}

/**
 * Find the most recently completed SMS or phone-call comic for this SMS sender.
 * The inbound webhook has already verified the Twilio request and created the
 * SMS identity. A matching Voice identity, job owner, story owner, recipient,
 * and Twilio destination are all required before returning a Voice result.
 * The source-channel conversation must still point at the completed story.
 * An expiry reset clears that marker, while the job and story remain in admin
 * history. Voice results also require a job created and completed within 24
 * hours; a late completion must not reopen an expired caller's link.
 */
export async function latestStoryLinkForSms(input: {
  address: string;
  senderAddress: string;
}): Promise<LatestSmsStoryLink | null> {
  const base = publicBaseUrl();
  if (!base || !E164.test(input.address) || !E164.test(input.senderAddress)) return null;

  const result = await db.execute(sql`
    SELECT story.id AS story_id, story.slug, job.source
    FROM generation_jobs AS job
    JOIN stories AS story
      ON story.id = job.story_id AND story.user_id = job.user_id
    JOIN channel_identities AS sms_identity
      ON sms_identity.user_id = job.user_id
    JOIN channel_identities AS source_identity
      ON source_identity.user_id = job.user_id
    JOIN conversations AS source_conversation
      ON source_conversation.channel = job.source
      AND source_conversation.phone_number = sms_identity.address
      AND source_conversation.state = 'done'
      AND source_conversation.active_story_id = story.id
    WHERE sms_identity.provider = 'twilio'
      AND sms_identity.channel = 'sms'
      AND sms_identity.address = ${input.address}
      AND sms_identity.normalized_address = ${input.address}
      AND source_identity.provider = 'twilio'
      AND source_identity.channel = job.source
      AND source_identity.address = ${input.address}
      AND source_identity.normalized_address = ${input.address}
      AND job.source IN ('sms', 'voice')
      AND job.recipient_address = ${input.address}
      AND job.sender_address = ${input.senderAddress}
      AND job.completed_at IS NOT NULL
      AND job.completed_at >= NOW() - (${CONVERSATION_RESUME_DAYS} * INTERVAL '1 day')
      AND (job.source <> 'voice' OR (
        job.created_at >= NOW() - INTERVAL '24 hours'
        AND job.completed_at >= NOW() - INTERVAL '24 hours'
      ))
      AND (
        job.status = 'succeeded'
        OR (job.status = 'failed' AND EXISTS (
          SELECT 1
          FROM pages AS page
          WHERE page.id = job.id
            AND page.story_id = story.id
            AND page.generated_image_url IS NOT NULL
        ))
      )
    ORDER BY job.completed_at DESC NULLS LAST, job.created_at DESC, job.id DESC
    LIMIT 1
  `);
  const rows = Array.isArray(result)
    ? result : "rows" in result && Array.isArray(result.rows) ? result.rows : null;
  if (!rows) throw new Error("Unexpected latest story access query result");
  const row = rows[0] as { story_id?: unknown; slug?: unknown; source?: unknown } | undefined;
  if (!row || typeof row.story_id !== "string" || !UUID.test(row.story_id) ||
      typeof row.slug !== "string" || !SLUG.test(row.slug) ||
      (row.source !== "sms" && row.source !== "voice")) return null;
  return {
    storyId: row.story_id,
    source: row.source,
    link: new URL(`/story/${encodeURIComponent(row.slug)}`, base).toString(),
  };
}
