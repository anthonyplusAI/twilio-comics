CREATE INDEX "generation_jobs_user_created_idx" ON "generation_jobs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "generation_jobs_source_created_idx" ON "generation_jobs" USING btree ("source","created_at");--> statement-breakpoint
CREATE INDEX "generation_jobs_recipient_created_idx" ON "generation_jobs" USING btree ("recipient_address","created_at");--> statement-breakpoint
CREATE INDEX "twilio_inbound_channel_created_idx" ON "twilio_inbound_messages" USING btree ("channel","created_at");--> statement-breakpoint
CREATE INDEX "twilio_inbound_from_created_idx" ON "twilio_inbound_messages" USING btree ("from_address","created_at");