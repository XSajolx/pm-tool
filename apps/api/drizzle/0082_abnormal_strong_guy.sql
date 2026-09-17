CREATE TABLE "contractors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"email" varchar(320),
	"phone" varchar(64),
	"company" varchar(255),
	"role" varchar(120),
	"default_rate" double precision,
	"currency" varchar(8) DEFAULT 'USD' NOT NULL,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_contractors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"contractor_id" uuid NOT NULL,
	"role" varchar(120),
	"agreed_amount" double precision,
	"agreed_rate" double precision,
	"markup_pct" double precision,
	"notes" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "contractor_id" uuid;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "contractor_invoice_ref" varchar(64);--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "due_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "paid_reference" varchar(255);--> statement-breakpoint
ALTER TABLE "contractors" ADD CONSTRAINT "contractors_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contractors" ADD CONSTRAINT "contractors_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_contractors" ADD CONSTRAINT "project_contractors_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_contractors" ADD CONSTRAINT "project_contractors_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_contractors" ADD CONSTRAINT "project_contractors_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_contractors" ADD CONSTRAINT "project_contractors_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contractors_org_name_idx" ON "contractors" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "project_contractors_uq" ON "project_contractors" USING btree ("project_id","contractor_id");--> statement-breakpoint
CREATE INDEX "project_contractors_org_idx" ON "project_contractors" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_contractor_id_contractors_id_fk" FOREIGN KEY ("contractor_id") REFERENCES "public"."contractors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "expenses_contractor_idx" ON "expenses" USING btree ("contractor_id");