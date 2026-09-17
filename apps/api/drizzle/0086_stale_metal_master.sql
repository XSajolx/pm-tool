ALTER TYPE "public"."invoice_status" ADD VALUE 'review' BEFORE 'sent';--> statement-breakpoint
ALTER TYPE "public"."invoice_status" ADD VALUE 'superseded';--> statement-breakpoint
DROP INDEX "invoices_org_number_uq";--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "revision_of_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "superseded_by_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "revision_reason" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "submitted_for_review_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "submitted_by_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "issued_by_id" uuid;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "invoicing" jsonb;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_revision_of_id_invoices_id_fk" FOREIGN KEY ("revision_of_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_superseded_by_id_invoices_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_submitted_by_id_users_id_fk" FOREIGN KEY ("submitted_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_issued_by_id_users_id_fk" FOREIGN KEY ("issued_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_org_number_uq" ON "invoices" USING btree ("organization_id","number","version");