DROP INDEX "allocations_user_project_week_uq";--> statement-breakpoint
ALTER TABLE "allocations" ADD COLUMN "stage_id" uuid;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_stage_id_project_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."project_stages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "allocations_user_project_stage_week_uq" ON "allocations" USING btree ("user_id","project_id","week_start",coalesce("stage_id", '00000000-0000-0000-0000-000000000000'::uuid));