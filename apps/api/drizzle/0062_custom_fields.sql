CREATE TABLE "custom_field_defs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"entity_type" varchar(16) NOT NULL,
	"name" varchar(80) NOT NULL,
	"type" varchar(16) NOT NULL,
	"options" jsonb,
	"position" double precision DEFAULT 0 NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "custom_field_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"value" jsonb,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "custom_field_defs" ADD CONSTRAINT "custom_field_defs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_entries" ADD CONSTRAINT "custom_field_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_entries" ADD CONSTRAINT "custom_field_entries_field_id_custom_field_defs_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."custom_field_defs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_entries" ADD CONSTRAINT "custom_field_entries_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "custom_field_defs_org_entity_idx" ON "custom_field_defs" USING btree ("organization_id","entity_type");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_entries_field_entity_uq" ON "custom_field_entries" USING btree ("field_id","entity_id");--> statement-breakpoint
CREATE INDEX "custom_field_entries_entity_idx" ON "custom_field_entries" USING btree ("entity_id");