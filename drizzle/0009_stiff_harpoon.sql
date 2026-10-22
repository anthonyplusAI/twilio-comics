CREATE TABLE "activity_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_key" text NOT NULL,
	"occurred_at" timestamp DEFAULT now() NOT NULL,
	"user_id" text,
	"channel" text NOT NULL,
	"kind" text NOT NULL,
	"direction" text,
	"address" text,
	"call_sid" text,
	"message_sid" text,
	"job_id" uuid,
	"story_id" uuid,
	"content" text,
	"status" text,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "admin_login_attempts" (
	"key" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp DEFAULT now() NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"blocked_until" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voice_calls" (
	"call_sid" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"from_address" text NOT NULL,
	"to_address" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	"duration_seconds" integer,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_calls" ADD CONSTRAINT "voice_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activity_events_event_key_idx" ON "activity_events" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX "activity_events_occurred_at_idx" ON "activity_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "activity_events_user_time_idx" ON "activity_events" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "activity_events_address_time_idx" ON "activity_events" USING btree ("address","occurred_at");--> statement-breakpoint
CREATE INDEX "activity_events_call_time_idx" ON "activity_events" USING btree ("call_sid","occurred_at");--> statement-breakpoint
CREATE INDEX "activity_events_job_time_idx" ON "activity_events" USING btree ("job_id","occurred_at");--> statement-breakpoint
CREATE INDEX "voice_calls_started_at_idx" ON "voice_calls" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "voice_calls_from_started_idx" ON "voice_calls" USING btree ("from_address","started_at");--> statement-breakpoint
CREATE INDEX "voice_calls_user_started_idx" ON "voice_calls" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "voice_calls_status_idx" ON "voice_calls" USING btree ("status");