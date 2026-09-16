CREATE TYPE "public"."profit_bucket" AS ENUM('profit', 'owner_pay', 'tax', 'opex');--> statement-breakpoint
CREATE TYPE "public"."profit_movement_kind" AS ENUM('allocation', 'distribution', 'adjustment');--> statement-breakpoint
CREATE TABLE "profit_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"bucket" "profit_bucket" NOT NULL,
	"kind" "profit_movement_kind" DEFAULT 'allocation' NOT NULL,
	"amount" double precision NOT NULL,
	"payment_id" uuid,
	"invoice_id" uuid,
	"income_amount" double precision,
	"pct" double precision,
	"date" timestamp with time zone NOT NULL,
	"note" text,
	"transferred_at" timestamp with time zone,
	"transferred_by_id" uuid,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "profit_first" jsonb;--> statement-breakpoint
ALTER TABLE "profit_movements" ADD CONSTRAINT "profit_movements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profit_movements" ADD CONSTRAINT "profit_movements_payment_id_invoice_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."invoice_payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profit_movements" ADD CONSTRAINT "profit_movements_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profit_movements" ADD CONSTRAINT "profit_movements_transferred_by_id_users_id_fk" FOREIGN KEY ("transferred_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profit_movements" ADD CONSTRAINT "profit_movements_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profit_movements_org_bucket_idx" ON "profit_movements" USING btree ("organization_id","bucket");--> statement-breakpoint
CREATE INDEX "profit_movements_payment_idx" ON "profit_movements" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "profit_movements_org_date_idx" ON "profit_movements" USING btree ("organization_id","date");