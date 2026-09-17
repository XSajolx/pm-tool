ALTER TABLE "expenses" ADD COLUMN "markup_pct" double precision;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "markup_note" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "expense_categories" jsonb;