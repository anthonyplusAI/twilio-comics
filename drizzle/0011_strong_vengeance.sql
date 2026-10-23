CREATE TABLE "experience_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"voice_photo_mode" text DEFAULT 'sms' NOT NULL,
	"camera_enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "experience_settings_singleton_check" CHECK ("experience_settings"."id" = 1),
	CONSTRAINT "experience_settings_voice_photo_mode_check" CHECK ("experience_settings"."voice_photo_mode" IN ('sms', 'camera', 'none'))
);
