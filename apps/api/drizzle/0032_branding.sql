ALTER TABLE "organizations" ADD COLUMN "brand_color" varchar(16) DEFAULT '#6366f1' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "brand_logo_url" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "brand_footer" varchar(255);