ALTER TABLE "tags" DROP CONSTRAINT "tags_space_id_spaces_id_fk";
--> statement-breakpoint
DROP INDEX "tags_space_name_uq";--> statement-breakpoint
ALTER TABLE "tags" ALTER COLUMN "space_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Row 30: tags become workspace-wide. Merge same-named tags across spaces first
-- so the new (organization_id, name) unique index can be created.
WITH ranked AS (
  SELECT id, organization_id, lower(name) AS lname,
         first_value(id) OVER (PARTITION BY organization_id, lower(name) ORDER BY created_at, id) AS keep_id
  FROM "tags"
), dups AS (SELECT id, keep_id FROM ranked WHERE id <> keep_id)
INSERT INTO "task_tags" (task_id, tag_id)
SELECT tt.task_id, d.keep_id FROM "task_tags" tt JOIN dups d ON d.id = tt.tag_id
ON CONFLICT DO NOTHING;--> statement-breakpoint
WITH ranked AS (
  SELECT id, organization_id, lower(name) AS lname,
         first_value(id) OVER (PARTITION BY organization_id, lower(name) ORDER BY created_at, id) AS keep_id
  FROM "tags"
)
DELETE FROM "tags" WHERE id IN (SELECT id FROM ranked WHERE id <> keep_id);--> statement-breakpoint
UPDATE "tags" SET space_id = NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tags_org_name_uq" ON "tags" USING btree ("organization_id","name");