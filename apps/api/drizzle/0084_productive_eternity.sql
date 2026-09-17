ALTER TABLE "invoice_items" ADD COLUMN "stage_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD COLUMN "billed_pct" integer;--> statement-breakpoint
ALTER TABLE "project_stages" ADD COLUMN "fee_amount" double precision;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_stage_id_project_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."project_stages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_items_stage_idx" ON "invoice_items" USING btree ("stage_id");