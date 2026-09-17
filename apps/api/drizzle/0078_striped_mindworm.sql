CREATE TYPE "public"."accounting_link_status" AS ENUM('synced', 'drifted', 'conflict', 'error');--> statement-breakpoint
CREATE TABLE "accounting_demo_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"remote_id" varchar(64) NOT NULL,
	"data" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounting_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"entity_type" varchar(24) NOT NULL,
	"entity_id" uuid NOT NULL,
	"remote_id" varchar(128) NOT NULL,
	"remote_label" varchar(255),
	"remote_version" varchar(128),
	"local_hash" varchar(64),
	"status" "accounting_link_status" DEFAULT 'synced' NOT NULL,
	"error" text,
	"conflict" jsonb,
	"synced_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "accounting_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"trigger" varchar(16) NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"unchanged" integer DEFAULT 0 NOT NULL,
	"conflicts" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"message" text,
	"started_by_id" uuid
);
--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "external_id" varchar(128);--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "accounting" jsonb;--> statement-breakpoint
ALTER TABLE "accounting_demo_records" ADD CONSTRAINT "accounting_demo_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_links" ADD CONSTRAINT "accounting_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_links" ADD CONSTRAINT "accounting_links_resolved_by_id_users_id_fk" FOREIGN KEY ("resolved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_runs" ADD CONSTRAINT "accounting_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_runs" ADD CONSTRAINT "accounting_runs_started_by_id_users_id_fk" FOREIGN KEY ("started_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_demo_records_uq" ON "accounting_demo_records" USING btree ("organization_id","remote_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_links_entity_uq" ON "accounting_links" USING btree ("organization_id","provider","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "accounting_links_org_status_idx" ON "accounting_links" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "accounting_runs_org_idx" ON "accounting_runs" USING btree ("organization_id","started_at");