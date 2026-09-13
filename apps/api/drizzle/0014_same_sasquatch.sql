CREATE TYPE "public"."recurrence_freq" AS ENUM('daily', 'weekly', 'monthly');--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "recurrence" "recurrence_freq";--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "recurrence_interval" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "recurred_from_id" uuid;