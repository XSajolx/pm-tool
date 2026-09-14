CREATE TABLE "timesheet_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"week_start" timestamp with time zone NOT NULL,
	"status" varchar(16) DEFAULT 'submitted' NOT NULL,
	"approver_id" uuid,
	"total_seconds" integer DEFAULT 0 NOT NULL,
	"note" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_id" uuid
);
--> statement-breakpoint
ALTER TABLE "milestones" ADD COLUMN "signoff_status" varchar(16);--> statement-breakpoint
ALTER TABLE "milestones" ADD COLUMN "signoff_requested_by_id" uuid;--> statement-breakpoint
ALTER TABLE "milestones" ADD COLUMN "signoff_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "milestones" ADD COLUMN "signoff_approver_id" uuid;--> statement-breakpoint
ALTER TABLE "milestones" ADD COLUMN "signoff_note" text;--> statement-breakpoint
ALTER TABLE "timesheet_submissions" ADD CONSTRAINT "timesheet_submissions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_submissions" ADD CONSTRAINT "timesheet_submissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_submissions" ADD CONSTRAINT "timesheet_submissions_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_submissions" ADD CONSTRAINT "timesheet_submissions_decided_by_id_users_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "timesheet_submissions_user_week_uq" ON "timesheet_submissions" USING btree ("user_id","week_start");--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_signoff_requested_by_id_users_id_fk" FOREIGN KEY ("signoff_requested_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_signoff_approver_id_users_id_fk" FOREIGN KEY ("signoff_approver_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;