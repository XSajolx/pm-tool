CREATE TYPE "public"."expense_approval" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "approval_status" "expense_approval" DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "decided_by_id" uuid;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "decision_note" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "adjusts_expense_id" uuid;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_decided_by_id_users_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_adjusts_expense_id_expenses_id_fk" FOREIGN KEY ("adjusts_expense_id") REFERENCES "public"."expenses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expenses_org_approval_idx" ON "expenses" USING btree ("organization_id","approval_status");--> statement-breakpoint
CREATE INDEX "expenses_adjusts_idx" ON "expenses" USING btree ("adjusts_expense_id");