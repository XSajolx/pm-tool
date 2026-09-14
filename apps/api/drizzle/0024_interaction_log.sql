CREATE TYPE "public"."crm_note_kind" AS ENUM('note', 'call', 'meeting', 'email');--> statement-breakpoint
ALTER TABLE "crm_notes" ADD COLUMN "kind" "crm_note_kind" DEFAULT 'note' NOT NULL;--> statement-breakpoint
ALTER TABLE "crm_notes" ADD COLUMN "occurred_at" timestamp with time zone DEFAULT now() NOT NULL;