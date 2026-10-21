ALTER TABLE "stories" ADD COLUMN IF NOT EXISTS "uses_own_api_key" boolean DEFAULT false;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"message" text NOT NULL,
	"user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "accounts_provider_provider_account_id_pk" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "channel_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider" text DEFAULT 'twilio' NOT NULL,
	"channel" text NOT NULL,
	"address" text NOT NULL,
	"normalized_address" text NOT NULL,
	"verified_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "free_tier_quota_claims" (
	"claim_key" text PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"window_started_at" timestamp DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "free_tier_quotas" (
	"subject" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp DEFAULT now() NOT NULL,
	"used" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idempotency_key" text NOT NULL,
	"user_id" text NOT NULL,
	"source" text NOT NULL,
	"recipient_address" text NOT NULL,
	"sender_address" text NOT NULL,
	"prompt" text NOT NULL,
	"style" text DEFAULT 'noir' NOT NULL,
	"character_image_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quota_claim_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"story_id" uuid,
	"image_url" text,
	"delivery_sid" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp,
	"last_error" text,
	"queued_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "generation_jobs_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "generation_jobs_quota_claim_key_unique" UNIQUE("quota_claim_key")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "twilio_inbound_messages" (
	"message_sid" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"from_address" text NOT NULL,
	"to_address" text NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"response_twiml" text,
	"attempt_count" integer DEFAULT 1 NOT NULL,
	"lease_expires_at" timestamp DEFAULT NOW() + INTERVAL '2 minutes' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"email" text,
	"email_verified" timestamp,
	"image" text,
	"kind" text DEFAULT 'oauth' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp NOT NULL,
	CONSTRAINT "verification_tokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
INSERT INTO "users" ("id", "kind")
SELECT DISTINCT "user_id", 'legacy'
FROM "stories"
WHERE "user_id" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "users" ("id", "kind")
SELECT DISTINCT "user_id", 'legacy'
FROM "feedback"
WHERE "user_id" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_phone_number_unique";--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_identity_provider_channel_address_idx" ON "channel_identities" USING btree ("provider","channel","normalized_address");--> statement-breakpoint
CREATE INDEX "channel_identity_user_id_idx" ON "channel_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "channel_identity_provider_address_idx" ON "channel_identities" USING btree ("provider","normalized_address");--> statement-breakpoint
CREATE INDEX "quota_claims_subject_idx" ON "free_tier_quota_claims" USING btree ("subject");--> statement-breakpoint
CREATE INDEX "generation_jobs_status_lease_idx" ON "generation_jobs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_active_story_id_stories_id_fk" FOREIGN KEY ("active_story_id") REFERENCES "public"."stories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_channel_phone_idx" ON "conversations" USING btree ("channel","phone_number");--> statement-breakpoint
CREATE UNIQUE INDEX "pages_story_page_number_idx" ON "pages" USING btree ("story_id","page_number");--> statement-breakpoint
CREATE INDEX "stories_user_id_idx" ON "stories" USING btree ("user_id");
