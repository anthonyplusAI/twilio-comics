import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import type { AdapterAccountType } from "next-auth/adapters";

export const users = pgTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("email_verified", { mode: "date" }),
  image: text("image"),
  kind: text("kind").default("oauth").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const accounts = pgTable(
  "accounts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => [
    primaryKey({ columns: [account.provider, account.providerAccountId] }),
    index("accounts_user_id_idx").on(account.userId),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    sessionToken: text("session_token").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (session) => [index("sessions_user_id_idx").on(session.userId)],
);

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (token) => [primaryKey({ columns: [token.identifier, token.token] })],
);

export const channelIdentities = pgTable(
  "channel_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").default("twilio").notNull(),
    channel: text("channel").notNull(),
    address: text("address").notNull(),
    normalizedAddress: text("normalized_address").notNull(),
    verifiedAt: timestamp("verified_at").defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (identity) => [
    uniqueIndex("channel_identity_provider_channel_address_idx").on(
      identity.provider,
      identity.channel,
      identity.normalizedAddress,
    ),
    index("channel_identity_user_id_idx").on(identity.userId),
    index("channel_identity_provider_address_idx").on(
      identity.provider,
      identity.normalizedAddress,
    ),
  ],
);

export const stories = pgTable(
  "stories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    slug: text("slug").notNull().unique(),
    description: text("description"),
    style: text("style").default("noir").notNull(),
    source: text("source").default("web").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    usesOwnApiKey: boolean("uses_own_api_key").default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (story) => [index("stories_user_id_idx").on(story.userId)],
);

export const pages = pgTable(
  "pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storyId: uuid("story_id")
      .references(() => stories.id, { onDelete: "cascade" })
      .notNull(),
    pageNumber: integer("page_number").notNull(),
    prompt: text("prompt").notNull(),
    characterImageUrls: jsonb("character_image_urls")
      .$type<string[]>()
      .default([])
      .notNull(),
    generatedImageUrl: text("generated_image_url"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (page) => [
    uniqueIndex("pages_story_page_number_idx").on(
      page.storyId,
      page.pageNumber,
    ),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    phoneNumber: text("phone_number").notNull(),
    channel: text("channel").default("sms").notNull(),
    state: text("state").default("collecting").notNull(),
    collected: jsonb("collected")
      .$type<{
        name?: string;
        prompt?: string;
        blockedPrompt?: string;
        style?: string;
        characterImageUrls?: string[];
        photoHandoffFingerprint?: string;
        photoHandoffResetAt?: string;
        suppressPhotoHandoff?: boolean;
        targetStoryId?: string;
        generationRequestKey?: string;
        messages?: Array<{ role: "user" | "assistant"; content: string }>;
      }>()
      .default({})
      .notNull(),
    activeStoryId: uuid("active_story_id").references(() => stories.id, {
      onDelete: "set null",
    }),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (conversation) => [
    uniqueIndex("conversations_channel_phone_idx").on(
      conversation.channel,
      conversation.phoneNumber,
    ),
  ],
);

export const freeTierQuotas = pgTable("free_tier_quotas", {
  subject: text("subject").primaryKey(),
  windowStartedAt: timestamp("window_started_at").defaultNow().notNull(),
  used: integer("used").default(0).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const freeTierQuotaClaims = pgTable(
  "free_tier_quota_claims",
  {
    claimKey: text("claim_key").primaryKey(),
    subject: text("subject").notNull(),
    windowStartedAt: timestamp("window_started_at").defaultNow().notNull(),
    status: text("status").default("pending").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (claim) => [index("quota_claims_subject_idx").on(claim.subject)],
);

export const generationJobs = pgTable(
  "generation_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    source: text("source").notNull(),
    recipientAddress: text("recipient_address").notNull(),
    senderAddress: text("sender_address").notNull(),
    prompt: text("prompt").notNull(),
    style: text("style").default("noir").notNull(),
    characterImageUrls: jsonb("character_image_urls")
      .$type<string[]>()
      .default([])
      .notNull(),
    quotaClaimKey: text("quota_claim_key").notNull().unique(),
    status: text("status").default("pending").notNull(),
    storyId: uuid("story_id").references(() => stories.id, {
      onDelete: "set null",
    }),
    targetStoryId: uuid("target_story_id").references(() => stories.id, {
      onDelete: "set null",
    }),
    imageUrl: text("image_url"),
    deliverySid: text("delivery_sid"),
    deliveryStatus: text("delivery_status"),
    deliveryErrorCode: text("delivery_error_code"),
    deliveryUpdatedAt: timestamp("delivery_updated_at"),
    deliveryHadMedia: boolean("delivery_had_media").default(false).notNull(),
    deliveryFallbackSid: text("delivery_fallback_sid"),
    deliveryFallbackStatus: text("delivery_fallback_status"),
    deliveryFallbackErrorCode: text("delivery_fallback_error_code"),
    deliveryFallbackAttempts: integer("delivery_fallback_attempts").default(0).notNull(),
    deliveryFallbackLeaseExpiresAt: timestamp("delivery_fallback_lease_expires_at"),
    deliveryFallbackUpdatedAt: timestamp("delivery_fallback_updated_at"),
    attemptCount: integer("attempt_count").default(0).notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    lastError: text("last_error"),
    queuedAt: timestamp("queued_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (job) => [
    index("generation_jobs_status_lease_idx").on(
      job.status,
      job.leaseExpiresAt,
    ),
    index("generation_jobs_user_created_idx").on(job.userId, job.createdAt),
    index("generation_jobs_source_created_idx").on(job.source, job.createdAt),
    index("generation_jobs_recipient_created_idx").on(job.recipientAddress, job.createdAt),
  ],
);

export const twilioInboundMessages = pgTable(
  "twilio_inbound_messages",
  {
    messageSid: text("message_sid").primaryKey(),
    channel: text("channel").notNull(),
    fromAddress: text("from_address").notNull(),
    toAddress: text("to_address").notNull(),
    body: text("body").default("").notNull(),
    mediaUrls: jsonb("media_urls").$type<string[]>().default([]).notNull(),
    mediaContentTypes: jsonb("media_content_types")
      .$type<string[]>()
      .default([])
      .notNull(),
    status: text("status").default("pending").notNull(),
    replyBody: text("reply_body"),
    outboundSid: text("outbound_sid"),
    submission: jsonb("submission").$type<{
      prompt: string;
      style: string;
      characterImageUrls: string[];
      targetStoryId?: string;
    } | null>(),
    responseTwiml: text("response_twiml"),
    attemptCount: integer("attempt_count").default(0).notNull(),
    leaseExpiresAt: timestamp("lease_expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (message) => [
    index("twilio_inbound_channel_created_idx").on(message.channel, message.createdAt),
    index("twilio_inbound_from_created_idx").on(message.fromAddress, message.createdAt),
  ],
);

/** Append-only operational history. The Container Apps image never owns this data. */
export const activityEvents = pgTable(
  "activity_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventKey: text("event_key").notNull(),
    occurredAt: timestamp("occurred_at").defaultNow().notNull(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    channel: text("channel").notNull(),
    kind: text("kind").notNull(),
    direction: text("direction"),
    address: text("address"),
    callSid: text("call_sid"),
    messageSid: text("message_sid"),
    jobId: uuid("job_id"),
    storyId: uuid("story_id"),
    content: text("content"),
    status: text("status"),
    details: jsonb("details").$type<Record<string, unknown>>(),
  },
  (event) => [
    uniqueIndex("activity_events_event_key_idx").on(event.eventKey),
    index("activity_events_occurred_at_idx").on(event.occurredAt),
    index("activity_events_user_time_idx").on(event.userId, event.occurredAt),
    index("activity_events_address_time_idx").on(event.address, event.occurredAt),
    index("activity_events_call_time_idx").on(event.callSid, event.occurredAt),
    index("activity_events_job_time_idx").on(event.jobId, event.occurredAt),
  ],
);

export const voiceCalls = pgTable(
  "voice_calls",
  {
    callSid: text("call_sid").primaryKey(),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    fromAddress: text("from_address").notNull(),
    toAddress: text("to_address").notNull(),
    status: text("status").default("active").notNull(),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    endedAt: timestamp("ended_at"),
    durationSeconds: integer("duration_seconds"),
    turnCount: integer("turn_count").default(0).notNull(),
    errorCode: text("error_code"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (call) => [
    index("voice_calls_started_at_idx").on(call.startedAt),
    index("voice_calls_from_started_idx").on(call.fromAddress, call.startedAt),
    index("voice_calls_user_started_idx").on(call.userId, call.startedAt),
    index("voice_calls_status_idx").on(call.status),
  ],
);

export const adminLoginAttempts = pgTable("admin_login_attempts", {
  key: text("key").primaryKey(),
  windowStartedAt: timestamp("window_started_at").defaultNow().notNull(),
  failedCount: integer("failed_count").default(0).notNull(),
  blockedUntil: timestamp("blocked_until"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/** Dashboard rotations live in PostgreSQL; an absent row uses the initial Azure secret. */
export const adminCredentials = pgTable(
  "admin_credentials",
  {
    id: integer("id").primaryKey().default(1),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (credentials) => [
    check("admin_credentials_singleton_check", sql`${credentials.id} = 1`),
  ],
);

export type VoicePhotoMode = "sms" | "camera" | "none";

/** A single PostgreSQL row keeps the public Voice photo path stable across deploys. */
export const experienceSettings = pgTable(
  "experience_settings",
  {
    id: integer("id").primaryKey().default(1),
    voicePhotoMode: text("voice_photo_mode")
      .$type<VoicePhotoMode>()
      .default("sms")
      .notNull(),
    cameraEnabled: boolean("camera_enabled").default(false).notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (settings) => [
    check("experience_settings_singleton_check", sql`${settings.id} = 1`),
    check(
      "experience_settings_voice_photo_mode_check",
      sql`${settings.voicePhotoMode} IN ('sms', 'camera', 'none')`,
    ),
  ],
);

export const feedback = pgTable("feedback", {
  id: serial("id").primaryKey(),
  message: text("message").notNull(),
  userId: text("user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const storiesRelations = relations(stories, ({ many, one }) => ({
  owner: one(users, { fields: [stories.userId], references: [users.id] }),
  pages: many(pages),
}));

export const pagesRelations = relations(pages, ({ one }) => ({
  story: one(stories, {
    fields: [pages.storyId],
    references: [stories.id],
  }),
}));

export type Feedback = typeof feedback.$inferSelect;
export type NewFeedback = typeof feedback.$inferInsert;
export type Story = typeof stories.$inferSelect;
export type NewStory = typeof stories.$inferInsert;
export type Page = typeof pages.$inferSelect;
export type NewPage = typeof pages.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type ChannelIdentity = typeof channelIdentities.$inferSelect;
export type GenerationJob = typeof generationJobs.$inferSelect;
export type ActivityEvent = typeof activityEvents.$inferSelect;
export type NewActivityEvent = typeof activityEvents.$inferInsert;
export type VoiceCall = typeof voiceCalls.$inferSelect;
