ALTER TABLE "documents" ADD COLUMN "client_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "client_visible" boolean DEFAULT false NOT NULL;