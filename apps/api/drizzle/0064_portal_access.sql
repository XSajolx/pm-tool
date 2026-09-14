CREATE TABLE "portal_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" varchar(255) NOT NULL,
	"name" varchar(160),
	"contact_id" uuid,
	"project_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"invited_by_id" uuid,
	"last_sent_at" timestamp with time zone,
	"last_opened_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"access_id" uuid,
	"project_id" uuid,
	"email" varchar(255),
	"kind" varchar(24) NOT NULL,
	"entity_type" varchar(24),
	"entity_id" uuid,
	"label" varchar(255),
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "client_decision" varchar(24);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "client_decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "client_decided_by" varchar(255);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "client_decision_note" text;--> statement-breakpoint
ALTER TABLE "milestones" ADD COLUMN "client_decision" varchar(24);--> statement-breakpoint
ALTER TABLE "milestones" ADD COLUMN "client_decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "milestones" ADD COLUMN "client_decided_by" varchar(255);--> statement-breakpoint
ALTER TABLE "milestones" ADD COLUMN "client_decision_note" text;--> statement-breakpoint
ALTER TABLE "portal_access" ADD CONSTRAINT "portal_access_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_access" ADD CONSTRAINT "portal_access_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_access" ADD CONSTRAINT "portal_access_invited_by_id_users_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_events" ADD CONSTRAINT "portal_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_events" ADD CONSTRAINT "portal_events_access_id_portal_access_id_fk" FOREIGN KEY ("access_id") REFERENCES "public"."portal_access"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_events" ADD CONSTRAINT "portal_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portal_access_token_uq" ON "portal_access" USING btree ("token");--> statement-breakpoint
CREATE INDEX "portal_access_org_idx" ON "portal_access" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "portal_events_project_idx" ON "portal_events" USING btree ("project_id","created_at");