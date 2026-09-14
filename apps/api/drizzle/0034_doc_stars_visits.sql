CREATE TABLE "document_stars" (
	"document_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_visits" (
	"document_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"last_opened_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_stars" ADD CONSTRAINT "document_stars_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_stars" ADD CONSTRAINT "document_stars_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_stars" ADD CONSTRAINT "document_stars_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_visits" ADD CONSTRAINT "document_visits_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_visits" ADD CONSTRAINT "document_visits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_visits" ADD CONSTRAINT "document_visits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_stars_pk" ON "document_stars" USING btree ("document_id","user_id");--> statement-breakpoint
CREATE INDEX "document_stars_user_idx" ON "document_stars" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_visits_pk" ON "document_visits" USING btree ("document_id","user_id");--> statement-breakpoint
CREATE INDEX "document_visits_user_idx" ON "document_visits" USING btree ("user_id","last_opened_at");