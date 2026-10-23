ALTER TABLE "stories" ADD COLUMN "dub_key" text;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "dub_short_url" text;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "dub_link_id" text;--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_dub_key_unique" UNIQUE("dub_key");--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_dub_short_url_unique" UNIQUE("dub_short_url");--> statement-breakpoint
ALTER TABLE "stories" ADD CONSTRAINT "stories_dub_link_id_unique" UNIQUE("dub_link_id");