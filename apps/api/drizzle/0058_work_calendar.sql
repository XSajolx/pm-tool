CREATE TABLE "holidays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"name" varchar(120) NOT NULL,
	"kind" varchar(16) DEFAULT 'holiday' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "member_working_days" jsonb;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "employment_type" varchar(16) DEFAULT 'full_time' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "standard_weekly_hours" integer DEFAULT 40 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "working_days" jsonb DEFAULT '[1,2,3,4,5]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "holidays_org_date_uq" ON "holidays" USING btree ("organization_id","date");