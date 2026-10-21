ALTER TABLE "conversations" ALTER COLUMN "state" SET DEFAULT 'collecting';--> statement-breakpoint
ALTER TABLE "twilio_inbound_messages" ALTER COLUMN "status" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "twilio_inbound_messages" ALTER COLUMN "attempt_count" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "twilio_inbound_messages" ALTER COLUMN "lease_expires_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "twilio_inbound_messages" ALTER COLUMN "lease_expires_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "lease_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "target_story_id" uuid;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "delivery_status" text;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "delivery_error_code" text;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "delivery_updated_at" timestamp;--> statement-breakpoint
ALTER TABLE "twilio_inbound_messages" ADD COLUMN "body" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "twilio_inbound_messages" ADD COLUMN "media_urls" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "twilio_inbound_messages" ADD COLUMN "media_content_types" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "twilio_inbound_messages" ADD COLUMN "reply_body" text;--> statement-breakpoint
ALTER TABLE "twilio_inbound_messages" ADD COLUMN "outbound_sid" text;--> statement-breakpoint
ALTER TABLE "twilio_inbound_messages" ADD COLUMN "submission" jsonb;--> statement-breakpoint
UPDATE "twilio_inbound_messages" SET "status" = 'completed', "updated_at" = now() WHERE "status" = 'processing' AND "body" = '';--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_target_story_id_stories_id_fk" FOREIGN KEY ("target_story_id") REFERENCES "public"."stories"("id") ON DELETE set null ON UPDATE no action;
