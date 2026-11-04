ALTER TABLE "experience_settings" ADD COLUMN "studio_enabled" boolean DEFAULT false NOT NULL;
UPDATE "experience_settings" SET "voice_photo_mode" = 'sms' WHERE "voice_photo_mode" = 'camera';
UPDATE "experience_settings" SET "camera_enabled" = false WHERE "camera_enabled" = true;
