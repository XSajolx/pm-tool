ALTER TABLE "deals" ADD COLUMN "next_action_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "next_action_note" varchar(255);--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "next_action_reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "last_activity_at" timestamp with time zone DEFAULT now() NOT NULL;