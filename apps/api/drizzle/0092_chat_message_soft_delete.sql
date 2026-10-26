ALTER TABLE "messages" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "deleted_by_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_deleted_by_id_users_id_fk" FOREIGN KEY ("deleted_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;