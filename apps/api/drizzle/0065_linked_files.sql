CREATE TABLE "linked_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"entity_type" varchar(16) NOT NULL,
	"entity_id" uuid NOT NULL,
	"provider" varchar(24) NOT NULL,
	"url" text NOT NULL,
	"external_id" varchar(255),
	"name" varchar(255) NOT NULL,
	"mime_type" varchar(128),
	"size_bytes" integer,
	"icon_url" text,
	"last_modified_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"added_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "linked_files" ADD CONSTRAINT "linked_files_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "linked_files" ADD CONSTRAINT "linked_files_added_by_id_users_id_fk" FOREIGN KEY ("added_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "linked_files_entity_idx" ON "linked_files" USING btree ("entity_type","entity_id");