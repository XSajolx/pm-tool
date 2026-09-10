CREATE TABLE "bookmarks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"title" varchar(255) NOT NULL,
	"url" text NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookmarks_space_idx" ON "bookmarks" USING btree ("space_id");