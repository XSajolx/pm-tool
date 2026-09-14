CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" varchar(32) NOT NULL,
	"status" varchar(24) DEFAULT 'connected' NOT NULL,
	"account_email" varchar(255),
	"account_name" varchar(255),
	"access_token" text,
	"refresh_token" text,
	"expires_at" timestamp with time zone,
	"scopes" text,
	"connected_by_id" uuid,
	"connected_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_connected_by_id_users_id_fk" FOREIGN KEY ("connected_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_org_provider_uq" ON "integrations" USING btree ("organization_id","provider");