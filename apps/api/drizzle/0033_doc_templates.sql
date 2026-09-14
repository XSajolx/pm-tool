CREATE TABLE "doc_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"title" varchar(255) NOT NULL,
	"icon" varchar(16),
	"content" jsonb,
	"body" text DEFAULT '' NOT NULL,
	"position" double precision DEFAULT 0 NOT NULL,
	"in_kit" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "doc_templates" ADD CONSTRAINT "doc_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doc_templates_org_idx" ON "doc_templates" USING btree ("organization_id");