CREATE TYPE "public"."deal_stage_kind" AS ENUM('open', 'won', 'lost');--> statement-breakpoint
CREATE TABLE "deal_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"kind" "deal_stage_kind" DEFAULT 'open' NOT NULL,
	"probability" integer DEFAULT 10 NOT NULL,
	"color" varchar(16) DEFAULT '#6366f1' NOT NULL,
	"position" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
DROP INDEX "deals_org_stage_idx";--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "stage_id" uuid;--> statement-breakpoint
ALTER TABLE "deal_stages" ADD CONSTRAINT "deal_stages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deal_stages_org_idx" ON "deal_stages" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_stage_id_deal_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."deal_stages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deals_org_stage_idx" ON "deals" USING btree ("organization_id","stage_id");--> statement-breakpoint
INSERT INTO "deal_stages" ("id", "organization_id", "name", "kind", "probability", "color", "position", "created_at", "updated_at")
SELECT gen_random_uuid(), o."id", s.name, s.kind::"deal_stage_kind", s.prob, s.color, s.pos, now(), now()
FROM "organizations" o
CROSS JOIN (VALUES ('lead','Lead','open',10,'#94a3b8',1),('qualified','Qualified','open',25,'#0ea5e9',2),('proposal','Proposal','open',50,'#6366f1',3),('negotiation','Negotiation','open',75,'#f59e0b',4),('won','Won','won',100,'#10b981',5),('lost','Lost','lost',0,'#f87171',6)) AS s(key, name, kind, prob, color, pos);--> statement-breakpoint
UPDATE "deals" d SET "stage_id" = ds."id" FROM "deal_stages" ds
WHERE ds."organization_id" = d."organization_id"
  AND ds."position" = CASE d."stage"::text WHEN 'lead' THEN 1 WHEN 'qualified' THEN 2 WHEN 'proposal' THEN 3 WHEN 'negotiation' THEN 4 WHEN 'won' THEN 5 ELSE 6 END;
