ALTER TABLE "documents" ADD COLUMN "superseded_by_id" uuid;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "effective_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_superseded_by_id_documents_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;