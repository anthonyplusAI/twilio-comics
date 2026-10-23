CREATE TABLE "dub_short_link_reservations" (
	"key" text PRIMARY KEY NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "dub_short_link_reservations" ("key", "created_at")
SELECT "dub_key", "created_at"
FROM "stories"
WHERE "dub_key" ~ '^comic-[0-9]{5}$'
ON CONFLICT ("key") DO NOTHING;
