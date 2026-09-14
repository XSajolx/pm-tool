ALTER TABLE "attachments" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "channel_id" uuid;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "message_id" uuid;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_channel_idx" ON "attachments" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "attachments_message_idx" ON "attachments" USING btree ("message_id");