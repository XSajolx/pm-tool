CREATE TABLE "stage_progress_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"actor_id" uuid,
	"from_pct" integer NOT NULL,
	"to_pct" integer NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_stages" ADD COLUMN "progress_pct" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_stages" ADD COLUMN "progress_set_by_id" uuid;--> statement-breakpoint
ALTER TABLE "project_stages" ADD COLUMN "progress_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_stages" ADD COLUMN "progress_note" text;--> statement-breakpoint
ALTER TABLE "stage_progress_events" ADD CONSTRAINT "stage_progress_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_progress_events" ADD CONSTRAINT "stage_progress_events_stage_id_project_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."project_stages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_progress_events" ADD CONSTRAINT "stage_progress_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stage_progress_events_stage_idx" ON "stage_progress_events" USING btree ("stage_id","created_at");--> statement-breakpoint
ALTER TABLE "project_stages" ADD CONSTRAINT "project_stages_progress_set_by_id_users_id_fk" FOREIGN KEY ("progress_set_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;