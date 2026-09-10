ALTER TABLE "comments" ADD COLUMN "assignee_id" uuid;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "resolved_by_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "category" varchar(16) DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "is_important" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_resolved_by_id_users_id_fk" FOREIGN KEY ("resolved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_assignee_open_idx" ON "comments" USING btree ("assignee_id","resolved_at");