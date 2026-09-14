CREATE TABLE "timesheet_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"actor_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "timesheet_events" ADD CONSTRAINT "timesheet_events_submission_id_timesheet_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."timesheet_submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_events" ADD CONSTRAINT "timesheet_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "timesheet_events_submission_idx" ON "timesheet_events" USING btree ("submission_id");