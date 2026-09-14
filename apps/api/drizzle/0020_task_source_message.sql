ALTER TABLE "tasks" ADD COLUMN "source_message_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_source_message_idx" ON "tasks" USING btree ("source_message_id");