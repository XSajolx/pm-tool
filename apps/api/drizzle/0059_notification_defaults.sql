ALTER TABLE "notification_preferences" ADD COLUMN "quiet_hours" jsonb;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "notification_defaults" jsonb;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "quiet_hours" jsonb;