ALTER TABLE "invoice_payments" ADD COLUMN "provider" varchar(24);--> statement-breakpoint
ALTER TABLE "invoice_payments" ADD COLUMN "provider_ref" varchar(255);--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "online_payments" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_payments_provider_ref_uq" ON "invoice_payments" USING btree ("provider_ref");