CREATE TYPE "public"."channel_notify" AS ENUM('all', 'mentions', 'muted');--> statement-breakpoint
ALTER TABLE "channel_members" ADD COLUMN "notify" "channel_notify" DEFAULT 'mentions' NOT NULL;