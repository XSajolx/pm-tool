CREATE TABLE "follows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"entity_type" varchar(16) NOT NULL,
	"entity_id" uuid NOT NULL,
	"reason" varchar(16) DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "follows_uq" ON "follows" USING btree ("user_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "follows_entity_idx" ON "follows" USING btree ("entity_type","entity_id");
--> statement-breakpoint
INSERT INTO "follows" ("organization_id","user_id","entity_type","entity_id","reason","created_at") SELECT "organization_id","user_id",'task',"task_id",'assigned',"created_at" FROM "task_subscribers" ON CONFLICT DO NOTHING;
