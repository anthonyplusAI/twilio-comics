import {
  boolean,
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
import { relations } from "drizzle-orm";
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
        style?: string;
        characterImageUrls?: string[];
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
  ],
);

export const twilioInboundMessages = pgTable("twilio_inbound_messages", {
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
});

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
