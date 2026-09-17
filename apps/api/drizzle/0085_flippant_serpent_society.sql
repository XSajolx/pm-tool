ALTER TABLE "invoice_schedules" ADD COLUMN "reviewer_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_schedules" ADD COLUMN "review_nudge_days" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_schedules" ADD CONSTRAINT "invoice_schedules_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;