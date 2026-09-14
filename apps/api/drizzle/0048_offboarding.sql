ALTER TABLE "memberships" ADD COLUMN "end_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "deactivated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "deactivated_by_id" uuid;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_deactivated_by_id_users_id_fk" FOREIGN KEY ("deactivated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;