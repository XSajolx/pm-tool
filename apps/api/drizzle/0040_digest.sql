ALTER TABLE "notification_preferences" ADD COLUMN "digest" jsonb;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "digest_last_sent_at" timestamp with time zone;