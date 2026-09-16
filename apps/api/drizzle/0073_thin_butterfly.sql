CREATE TYPE "public"."expense_kind" AS ENUM('expense', 'refund');--> statement-breakpoint
CREATE TYPE "public"."expense_source" AS ENUM('manual', 'import');--> statement-breakpoint
CREATE TABLE "expense_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"filename" varchar(255) NOT NULL,
	"account" varchar(120),
	"row_count" integer DEFAULT 0 NOT NULL,
	"imported_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expense_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"match" varchar(255) NOT NULL,
	"category" varchar(64),
	"project_id" uuid,
	"billable" boolean,
	"personal" boolean,
	"hits" integer DEFAULT 0 NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"vendor" varchar(255) NOT NULL,
	"description" text,
	"amount" double precision NOT NULL,
	"currency" varchar(8) DEFAULT 'USD' NOT NULL,
	"kind" "expense_kind" DEFAULT 'expense' NOT NULL,
	"category" varchar(64),
	"project_id" uuid,
	"company_id" uuid,
	"billable" boolean DEFAULT false NOT NULL,
	"invoice_id" uuid,
	"personal" boolean DEFAULT false NOT NULL,
	"receipt_url" text,
	"notes" text,
	"source" "expense_source" DEFAULT 'manual' NOT NULL,
	"import_id" uuid,
	"account" varchar(120),
	"reference" varchar(255),
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "expense_imports" ADD CONSTRAINT "expense_imports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_imports" ADD CONSTRAINT "expense_imports_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_rules" ADD CONSTRAINT "expense_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_rules" ADD CONSTRAINT "expense_rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_rules" ADD CONSTRAINT "expense_rules_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_import_id_expense_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."expense_imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expense_imports_org_idx" ON "expense_imports" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "expense_rules_org_idx" ON "expense_rules" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "expenses_org_date_idx" ON "expenses" USING btree ("organization_id","date");--> statement-breakpoint
CREATE INDEX "expenses_project_idx" ON "expenses" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "expenses_invoice_idx" ON "expenses" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "expenses_import_idx" ON "expenses" USING btree ("import_id");--> statement-breakpoint
CREATE INDEX "expenses_org_vendor_idx" ON "expenses" USING btree ("organization_id","vendor");