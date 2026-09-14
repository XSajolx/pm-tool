ALTER TABLE "documents" ADD COLUMN "share_token" varchar(64);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "shared_at" timestamp with time zone;