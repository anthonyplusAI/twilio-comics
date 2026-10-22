import { and, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  channelIdentities,
  conversations,
  generationJobs,
  stories,
  twilioInboundMessages,
  users,
  voiceCalls,
} from "@/lib/schema";

const USER_PAGE_SIZE = 20;
const ACTIVITY_PAGE_SIZE = 40;
const RAW_RECORD_LIMIT = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows?: T[] }).rows ?? (result as T[]);
}

function numeric(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

interface AdminCountRow {
  phone_users?: string | number | null;
  sms_inbound?: string | number | null;
  sms_inbound_7d?: string | number | null;
  message_agent_turns_denied?: string | number | null;
  message_agent_turns_denied_7d?: string | number | null;
  voice_calls?: string | number | null;
  voice_calls_7d?: string | number | null;
  voice_calls_rate_limited?: string | number | null;
  voice_verifications?: string | number | null;
  voice_verifications_denied?: string | number | null;
  voice_duration_seconds?: string | number | null;
  voice_turns?: string | number | null;
  comic_requests?: string | number | null;
  comic_requests_7d?: string | number | null;
  comics_completed?: string | number | null;
  comics_failed?: string | number | null;
  delivered?: string | number | null;
  delivery_failed?: string | number | null;
  outbound_messages?: string | number | null;
  outbound_messages_7d?: string | number | null;
  event_count?: string | number | null;
}

export function summarizeAdminCounts(row: AdminCountRow) {
  return {
    phoneUsers: numeric(row.phone_users),
    smsInbound: numeric(row.sms_inbound),
    smsInbound7d: numeric(row.sms_inbound_7d),
    messageAgentTurnsDenied: numeric(row.message_agent_turns_denied),
    messageAgentTurnsDenied7d: numeric(row.message_agent_turns_denied_7d),
    voiceCalls: numeric(row.voice_calls),
    voiceCalls7d: numeric(row.voice_calls_7d),
    voiceCallsRateLimited: numeric(row.voice_calls_rate_limited),
    voiceVerifications: numeric(row.voice_verifications),
    voiceVerificationsDenied: numeric(row.voice_verifications_denied),
    voiceDurationSeconds: numeric(row.voice_duration_seconds),
    voiceTurns: numeric(row.voice_turns),
    comicRequests: numeric(row.comic_requests),
    comicRequests7d: numeric(row.comic_requests_7d),
    comicsCompleted: numeric(row.comics_completed),
    comicsFailed: numeric(row.comics_failed),
    delivered: numeric(row.delivered),
    deliveryFailed: numeric(row.delivery_failed),
    outboundMessages: numeric(row.outbound_messages),
    outboundMessages7d: numeric(row.outbound_messages_7d),
    eventCount: numeric(row.event_count),
  };
}

export type AdminCounts = ReturnType<typeof summarizeAdminCounts>;

interface AdminTrendRow {
  day: string | Date;
  sms_inbound: string | number;
  voice_calls: string | number;
  comics_completed: string | number;
}

export interface AdminTrendDay {
  day: string;
  smsInbound: number;
  voiceCalls: number;
  comicsCompleted: number;
}

export interface AdminActivityRow {
  id: string;
  occurred_at: Date | string;
  user_id: string | null;
  channel: string;
  kind: string;
  direction: string | null;
  address: string | null;
  call_sid: string | null;
  message_sid: string | null;
  job_id: string | null;
  story_id: string | null;
  content: string | null;
  status: string | null;
  details: Record<string, unknown> | null;
}

export interface AdminDashboard {
  counts: AdminCounts;
  trend: AdminTrendDay[];
  recentActivity: AdminActivityRow[];
}

/** One round trip for lifetime and trailing-week counters from durable rows. */
export async function getAdminDashboard(): Promise<AdminDashboard> {
  const [countsResult, trendResult, activityResult] = await Promise.all([
    db.execute(sql`
      SELECT
        (SELECT COUNT(DISTINCT user_id) FROM channel_identities
          WHERE channel IN ('sms', 'voice')) AS phone_users,
        (SELECT COUNT(*) FROM twilio_inbound_messages
          WHERE channel = 'sms') AS sms_inbound,
        (SELECT COUNT(*) FROM twilio_inbound_messages
          WHERE channel = 'sms' AND created_at >= NOW() - INTERVAL '7 days') AS sms_inbound_7d,
        (SELECT COUNT(*) FROM activity_events
          WHERE kind = 'message.agent_turn.denied') AS message_agent_turns_denied,
        (SELECT COUNT(*) FROM activity_events
          WHERE kind = 'message.agent_turn.denied' AND occurred_at >= NOW() - INTERVAL '7 days') AS message_agent_turns_denied_7d,
        (SELECT COUNT(*) FROM voice_calls
          WHERE status <> 'rate_limited') AS voice_calls,
        (SELECT COUNT(*) FROM voice_calls
          WHERE status <> 'rate_limited'
            AND started_at >= NOW() - INTERVAL '7 days') AS voice_calls_7d,
        (SELECT COUNT(*) FROM voice_calls
          WHERE status = 'rate_limited') AS voice_calls_rate_limited,
        (SELECT COUNT(*) FROM activity_events
          WHERE kind = 'voice.verification.requested') AS voice_verifications,
        (SELECT COUNT(*) FROM activity_events
          WHERE kind = 'voice.verification.denied') AS voice_verifications_denied,
        (SELECT COALESCE(SUM(duration_seconds), 0) FROM voice_calls
          WHERE status <> 'rate_limited') AS voice_duration_seconds,
        (SELECT COALESCE(SUM(turn_count), 0) FROM voice_calls
          WHERE status <> 'rate_limited') AS voice_turns,
        (SELECT COUNT(*) FROM generation_jobs) AS comic_requests,
        (SELECT COUNT(*) FROM generation_jobs
          WHERE created_at >= NOW() - INTERVAL '7 days') AS comic_requests_7d,
        (SELECT COUNT(*) FROM generation_jobs WHERE status = 'succeeded') AS comics_completed,
        (SELECT COUNT(*) FROM generation_jobs WHERE status = 'failed') AS comics_failed,
        (SELECT COUNT(*) FROM generation_jobs
          WHERE delivery_status IN ('delivered', 'read')
             OR delivery_fallback_status IN ('delivered', 'read')) AS delivered,
        (SELECT COUNT(*) FROM generation_jobs
          WHERE delivery_status IN ('failed', 'undelivered')
            AND COALESCE(delivery_fallback_status, '') NOT IN ('delivered', 'read')) AS delivery_failed,
        (SELECT COUNT(*) FROM activity_events
          WHERE (kind = 'message.outbound' AND channel = 'sms')
             OR (kind = 'generation.delivery' AND status = 'accepted'
               AND channel IN ('sms', 'voice'))) AS outbound_messages,
        (SELECT COUNT(*) FROM activity_events
          WHERE occurred_at >= NOW() - INTERVAL '7 days'
            AND ((kind = 'message.outbound' AND channel = 'sms')
              OR (kind = 'generation.delivery' AND status = 'accepted'
                AND channel IN ('sms', 'voice')))) AS outbound_messages_7d,
        (SELECT COUNT(*) FROM activity_events) AS event_count
    `),
    db.execute(sql`
      WITH days AS (
        SELECT generate_series(CURRENT_DATE - 13, CURRENT_DATE, INTERVAL '1 day')::date AS day
      ),
      sms AS (
        SELECT created_at::date AS day, COUNT(*) AS total
        FROM twilio_inbound_messages
        WHERE channel = 'sms' AND created_at >= CURRENT_DATE - 13
        GROUP BY created_at::date
      ),
      calls AS (
        SELECT started_at::date AS day, COUNT(*) AS total
        FROM voice_calls
        WHERE started_at >= CURRENT_DATE - 13
          AND status <> 'rate_limited'
        GROUP BY started_at::date
      ),
      comics AS (
        SELECT completed_at::date AS day, COUNT(*) AS total
        FROM generation_jobs
        WHERE status = 'succeeded' AND completed_at >= CURRENT_DATE - 13
        GROUP BY completed_at::date
      )
      SELECT days.day,
        COALESCE(sms.total, 0) AS sms_inbound,
        COALESCE(calls.total, 0) AS voice_calls,
        COALESCE(comics.total, 0) AS comics_completed
      FROM days
      LEFT JOIN sms ON sms.day = days.day
      LEFT JOIN calls ON calls.day = days.day
      LEFT JOIN comics ON comics.day = days.day
      ORDER BY days.day
    `),
    db.execute(sql`
      SELECT id, occurred_at, user_id, channel, kind, direction, address,
        call_sid, message_sid, job_id, story_id, content, status, details
      FROM activity_events
      ORDER BY occurred_at DESC, id DESC
      LIMIT 12
    `),
  ]);

  return {
    counts: summarizeAdminCounts(rowsOf<AdminCountRow>(countsResult)[0] ?? {}),
    trend: rowsOf<AdminTrendRow>(trendResult).map((row) => ({
      day: row.day instanceof Date
        ? row.day.toISOString().slice(0, 10)
        : String(row.day).slice(0, 10),
      smsInbound: numeric(row.sms_inbound),
      voiceCalls: numeric(row.voice_calls),
      comicsCompleted: numeric(row.comics_completed),
    })),
    recentActivity: rowsOf<AdminActivityRow>(activityResult),
  };
}

export interface AdminUserRow {
  id: string;
  name: string | null;
  email: string | null;
  kind: string;
  created_at: Date | string;
  addresses: string | null;
  comic_count: string | number;
  last_activity_at: Date | string;
}

function searchTerm(value: string): string {
  return value.trim().slice(0, 100).toLocaleLowerCase("en-US");
}

/** Bound search supports literal substrings in ID, name, email, or phone. */
export function buildAdminUserSearchQuery(
  search: string,
  offset: number,
  limit: number,
): SQL {
  const term = searchTerm(search);
  const filter = term
    ? sql`(
        POSITION(${term} IN LOWER(u.id)) > 0 OR
        POSITION(${term} IN LOWER(COALESCE(u.name, ''))) > 0 OR
        POSITION(${term} IN LOWER(COALESCE(u.email, ''))) > 0 OR
        EXISTS (
          SELECT 1 FROM channel_identities AS match_identity
          WHERE match_identity.user_id = u.id
            AND POSITION(${term} IN LOWER(match_identity.normalized_address)) > 0
        )
      )`
    : sql`TRUE`;

  return sql`
    SELECT u.id, u.name, u.email, u.kind, u.created_at,
      (SELECT STRING_AGG(DISTINCT ci.normalized_address, ', ')
        FROM channel_identities AS ci WHERE ci.user_id = u.id) AS addresses,
      (SELECT COUNT(*) FROM generation_jobs AS j WHERE j.user_id = u.id) AS comic_count,
      GREATEST(
        u.created_at,
        COALESCE((SELECT MAX(e.occurred_at) FROM activity_events AS e WHERE e.user_id = u.id), u.created_at),
        COALESCE((SELECT MAX(ci.last_seen_at) FROM channel_identities AS ci WHERE ci.user_id = u.id), u.created_at)
      ) AS last_activity_at
    FROM users AS u
    WHERE ${filter}
    ORDER BY last_activity_at DESC, u.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
}

export async function getAdminUserDirectory(search: string, page: number) {
  const safePage = Number.isSafeInteger(page) && page >= 0 ? page : 0;
  const result = await db.execute(buildAdminUserSearchQuery(
    search,
    safePage * USER_PAGE_SIZE,
    USER_PAGE_SIZE + 1,
  ));
  const rows = rowsOf<AdminUserRow>(result);
  return {
    items: rows.slice(0, USER_PAGE_SIZE),
    hasNext: rows.length > USER_PAGE_SIZE,
    page: safePage,
    search: search.trim().slice(0, 100),
  };
}

export interface ActivityCursor {
  occurredAt: Date;
  id: string;
}

export function encodeActivityCursor(cursor: ActivityCursor): string {
  return Buffer.from(JSON.stringify([
    cursor.occurredAt.toISOString(),
    cursor.id,
  ])).toString("base64url");
}

export function decodeActivityCursor(raw: string | null | undefined): ActivityCursor | null {
  if (!raw || raw.length > 200) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [dateString, id] = parsed;
    if (typeof dateString !== "string" || typeof id !== "string" || !UUID.test(id)) return null;
    const occurredAt = new Date(dateString);
    if (!Number.isFinite(occurredAt.getTime())) return null;
    return { occurredAt, id };
  } catch {
    return null;
  }
}

export function buildActivityHistoryQuery(input: {
  userId: string;
  addresses: string[];
  cursor: ActivityCursor | null;
  limit: number;
}): SQL {
  const addressFilter = input.addresses.length
    ? sql` OR (user_id IS NULL AND address IN (${sql.join(input.addresses.map((address) => sql`${address}`), sql`, `)}))`
    : sql``;
  const before = input.cursor
    ? sql`AND (occurred_at, id) < (${input.cursor.occurredAt.toISOString()}::timestamp, ${input.cursor.id}::uuid)`
    : sql``;
  return sql`
    SELECT id, occurred_at, user_id, channel, kind, direction, address,
      call_sid, message_sid, job_id, story_id, content, status, details
    FROM activity_events
    WHERE (user_id = ${input.userId}${addressFilter})
      ${before}
    ORDER BY occurred_at DESC, id DESC
    LIMIT ${input.limit}
  `;
}

export function paginateActivityRows<T extends { id: string; occurred_at: Date | string }>(
  rows: T[],
  pageSize: number,
) {
  const items = rows.slice(0, pageSize);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > pageSize && last
      ? encodeActivityCursor({ occurredAt: new Date(last.occurred_at), id: last.id })
      : null,
  };
}

export async function getAdminUserHistory(
  userId: string,
  addresses: string[],
  cursorString: string | null | undefined,
) {
  const cursor = decodeActivityCursor(cursorString);
  const result = await db.execute(buildActivityHistoryQuery({
    userId,
    addresses: [...new Set(addresses)],
    cursor,
    limit: ACTIVITY_PAGE_SIZE + 1,
  }));
  return paginateActivityRows(rowsOf<AdminActivityRow>(result), ACTIVITY_PAGE_SIZE);
}

export async function getAdminUserProfile(userId: string) {
  const [user] = await db.select({
    id: users.id,
    name: users.name,
    email: users.email,
    kind: users.kind,
    createdAt: users.createdAt,
    updatedAt: users.updatedAt,
  }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return null;

  const identities = await db.select().from(channelIdentities)
    .where(eq(channelIdentities.userId, userId))
    .orderBy(desc(channelIdentities.lastSeenAt));
  const addresses = [...new Set(identities.flatMap((identity) => [
    identity.address,
    identity.normalizedAddress,
  ]))];

  const [messages, calls, jobs, comicStories, activeConversations] = await Promise.all([
    addresses.length
      ? db.select().from(twilioInboundMessages)
        .where(inArray(twilioInboundMessages.fromAddress, addresses))
        .orderBy(desc(twilioInboundMessages.createdAt))
        .limit(RAW_RECORD_LIMIT)
      : Promise.resolve([]),
    db.select().from(voiceCalls)
      .where(addresses.length
        ? or(
          eq(voiceCalls.userId, userId),
          and(isNull(voiceCalls.userId), inArray(voiceCalls.fromAddress, addresses)),
        )
        : eq(voiceCalls.userId, userId))
      .orderBy(desc(voiceCalls.startedAt))
      .limit(RAW_RECORD_LIMIT),
    db.select().from(generationJobs)
      .where(eq(generationJobs.userId, userId))
      .orderBy(desc(generationJobs.createdAt))
      .limit(RAW_RECORD_LIMIT),
    db.select().from(stories)
      .where(eq(stories.userId, userId))
      .orderBy(desc(stories.createdAt))
      .limit(RAW_RECORD_LIMIT),
    addresses.length
      ? db.select().from(conversations)
        .where(inArray(conversations.phoneNumber, addresses))
        .orderBy(desc(conversations.updatedAt))
        .limit(RAW_RECORD_LIMIT)
      : Promise.resolve([]),
  ]);

  return {
    user,
    identities,
    addresses,
    messages,
    calls,
    jobs,
    stories: comicStories,
    conversations: activeConversations,
  };
}
