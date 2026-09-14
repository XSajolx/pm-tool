CREATE TYPE "public"."message_kind" AS ENUM('user', 'system');--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "activity_feed" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "kind" "message_kind" DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "meta" jsonb;