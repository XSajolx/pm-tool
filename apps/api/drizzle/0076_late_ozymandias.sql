CREATE TABLE "tax_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"quarter" integer NOT NULL,
	"jurisdiction" varchar(40),
	"amount" double precision NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"reference" varchar(255),
	"note" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "tax_settings" jsonb;--> statement-breakpoint
ALTER TABLE "tax_payments" ADD CONSTRAINT "tax_payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_payments" ADD CONSTRAINT "tax_payments_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tax_payments_org_period_idx" ON "tax_payments" USING btree ("organization_id","year","quarter");