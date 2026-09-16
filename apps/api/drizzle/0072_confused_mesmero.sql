CREATE TYPE "public"."contract_kind" AS ENUM('service_agreement', 'nda', 'retainer', 'contractor', 'custom');--> statement-breakpoint
CREATE TYPE "public"."contract_signature_type" AS ENUM('typed', 'drawn');--> statement-breakpoint
CREATE TYPE "public"."contract_signer_role" AS ENUM('client', 'company');--> statement-breakpoint
CREATE TYPE "public"."contract_status" AS ENUM('draft', 'sent', 'viewed', 'signed', 'declined', 'expired');--> statement-breakpoint
CREATE TABLE "contract_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"signer_id" uuid,
	"actor_user_id" uuid,
	"kind" varchar(24) NOT NULL,
	"detail" text,
	"ip" varchar(64),
	"user_agent" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_signers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"role" "contract_signer_role" DEFAULT 'client' NOT NULL,
	"name" varchar(255) NOT NULL,
	"email" varchar(320),
	"contact_id" uuid,
	"user_id" uuid,
	"token" varchar(64),
	"position" integer DEFAULT 1 NOT NULL,
	"sent_at" timestamp with time zone,
	"viewed_at" timestamp with time zone,
	"last_viewed_at" timestamp with time zone,
	"view_count" integer DEFAULT 0 NOT NULL,
	"signed_at" timestamp with time zone,
	"signature_type" "contract_signature_type",
	"signature_name" varchar(255),
	"signature_title" varchar(255),
	"signature_image" text,
	"signature_ip" varchar(64),
	"signature_user_agent" varchar(500),
	"declined_at" timestamp with time zone,
	"decline_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(160) NOT NULL,
	"kind" "contract_kind" DEFAULT 'custom' NOT NULL,
	"description" varchar(255),
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" varchar(32) NOT NULL,
	"title" varchar(255) NOT NULL,
	"kind" "contract_kind" DEFAULT 'service_agreement' NOT NULL,
	"template_id" uuid,
	"company_id" uuid,
	"contact_id" uuid,
	"deal_id" uuid,
	"project_id" uuid,
	"status" "contract_status" DEFAULT 'draft' NOT NULL,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rendered" jsonb,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"valid_until" timestamp with time zone,
	"require_countersign" boolean DEFAULT true NOT NULL,
	"sent_at" timestamp with time zone,
	"viewed_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"declined_at" timestamp with time zone,
	"decline_reason" text,
	"expired_at" timestamp with time zone,
	"pdf_key" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "contract_events" ADD CONSTRAINT "contract_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_events" ADD CONSTRAINT "contract_events_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_events" ADD CONSTRAINT "contract_events_signer_id_contract_signers_id_fk" FOREIGN KEY ("signer_id") REFERENCES "public"."contract_signers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_events" ADD CONSTRAINT "contract_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_signers" ADD CONSTRAINT "contract_signers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_signers" ADD CONSTRAINT "contract_signers_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_signers" ADD CONSTRAINT "contract_signers_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_signers" ADD CONSTRAINT "contract_signers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_templates" ADD CONSTRAINT "contract_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_template_id_contract_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."contract_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contract_events_contract_idx" ON "contract_events" USING btree ("contract_id","created_at");--> statement-breakpoint
CREATE INDEX "contract_signers_contract_idx" ON "contract_signers" USING btree ("contract_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_signers_token_uq" ON "contract_signers" USING btree ("token");--> statement-breakpoint
CREATE INDEX "contract_templates_org_idx" ON "contract_templates" USING btree ("organization_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "contracts_org_number_uq" ON "contracts" USING btree ("organization_id","number");--> statement-breakpoint
CREATE INDEX "contracts_org_status_idx" ON "contracts" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "contracts_company_idx" ON "contracts" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "contracts_deal_idx" ON "contracts" USING btree ("deal_id");--> statement-breakpoint
CREATE INDEX "contracts_project_idx" ON "contracts" USING btree ("project_id");