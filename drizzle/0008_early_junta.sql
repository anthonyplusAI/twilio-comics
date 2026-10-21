ALTER TABLE "generation_jobs" ADD COLUMN "delivery_had_media" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "delivery_fallback_sid" text;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "delivery_fallback_status" text;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "delivery_fallback_error_code" text;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "delivery_fallback_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "delivery_fallback_lease_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "delivery_fallback_updated_at" timestamp;