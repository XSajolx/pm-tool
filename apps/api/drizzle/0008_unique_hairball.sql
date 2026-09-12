ALTER TABLE "documents" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "content" jsonb;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "icon" varchar(16);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "cover" varchar(64);--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_parent_id_documents_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_parent_idx" ON "documents" USING btree ("parent_id");