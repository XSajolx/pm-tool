CREATE TYPE "public"."invoice_schedule_kind" AS ENUM('recurring', 'subscription');--> statement-breakpoint
CREATE TYPE "public"."invoice_schedule_status" AS ENUM('active', 'paused', 'ended');--> statement-breakpoint
CREATE TYPE "public"."invoice_schedule_unit" AS ENUM('week', 'month', 'year');--> statement-breakpoint
CREATE TABLE "invoice_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"kind" "invoice_schedule_kind" DEFAULT 'recurring' NOT NULL,
	"status" "invoice_schedule_status" DEFAULT 'active' NOT NULL,
	"title" varchar(255) NOT NULL,
	"company_id" uuid,
	"contact_id" uuid,
	"project_id" uuid,
	"currency" varchar(8) DEFAULT 'USD' NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tax_rate" double precision DEFAULT 0 NOT NULL,
	"discount_percent" double precision DEFAULT 0 NOT NULL,
	"notes" text,
	"due_days" integer DEFAULT 14 NOT NULL,
	"auto_send" boolean DEFAULT false NOT NULL,
	"every" integer DEFAULT 1 NOT NULL,
	"unit" "invoice_schedule_unit" DEFAULT 'month' NOT NULL,
	"anchor_day" integer,
	"starts_at" timestamp with time zone NOT NULL,
	"next_run_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"max_occurrences" integer,
	"occurrences" integer DEFAULT 0 NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_invoice_id" uuid,
	"last_error" text,
	"paused_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "schedule_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_schedules" ADD CONSTRAINT "invoice_schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_schedules" ADD CONSTRAINT "invoice_schedules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_schedules" ADD CONSTRAINT "invoice_schedules_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_schedules" ADD CONSTRAINT "invoice_schedules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_schedules" ADD CONSTRAINT "invoice_schedules_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_schedules_org_status_idx" ON "invoice_schedules" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "invoice_schedules_next_idx" ON "invoice_schedules" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "invoice_schedules_company_idx" ON "invoice_schedules" USING btree ("company_id");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_schedule_id_invoice_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."invoice_schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoices_schedule_idx" ON "invoices" USING btree ("schedule_id");