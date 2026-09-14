CREATE TYPE "public"."doc_review_status" AS ENUM('draft', 'in_review', 'approved');--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "review_status" "doc_review_status" DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "approver_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "review_requested_by_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "review_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_review_requested_by_id_users_id_fk" FOREIGN KEY ("review_requested_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;