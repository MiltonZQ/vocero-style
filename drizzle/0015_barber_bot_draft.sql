-- 019 Bot de barbería: borrador de reserva por conversación y datos de la
-- sede física en la configuración de la agenda.
--
-- Editada a mano sobre la generada para ser RE-EJECUTABLE (Constitución IV),
-- igual que la 0009 y la 0014: IF NOT EXISTS en tabla, columnas e índice, y
-- DO-block en cada clave foránea y en el CHECK. Es puramente aditiva.
--
-- ROLLBACK (manual):
--   DROP TABLE IF EXISTS "booking_draft";
--   ALTER TABLE "calendar_settings"
--     DROP CONSTRAINT IF EXISTS "calendar_settings_arrival_lead_ck",
--     DROP COLUMN IF EXISTS "location_address",
--     DROP COLUMN IF EXISTS "location_maps_url",
--     DROP COLUMN IF EXISTS "arrival_lead_minutes";

CREATE TABLE IF NOT EXISTS "booking_draft" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"service_id" text,
	"staff_choice" text,
	"when" jsonb,
	"stuck_turns" integer DEFAULT 0 NOT NULL,
	"failed_turns" integer DEFAULT 0 NOT NULL,
	"last_step" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_settings" ADD COLUMN IF NOT EXISTS "location_address" text;--> statement-breakpoint
ALTER TABLE "calendar_settings" ADD COLUMN IF NOT EXISTS "location_maps_url" text;--> statement-breakpoint
ALTER TABLE "calendar_settings" ADD COLUMN IF NOT EXISTS "arrival_lead_minutes" integer DEFAULT 5 NOT NULL;--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "booking_draft" ADD CONSTRAINT "booking_draft_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "booking_draft" ADD CONSTRAINT "booking_draft_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "booking_draft" ADD CONSTRAINT "booking_draft_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "booking_draft_conversation_uq" ON "booking_draft" USING btree ("conversation_id");--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "calendar_settings" ADD CONSTRAINT "calendar_settings_arrival_lead_ck" CHECK ("calendar_settings"."arrival_lead_minutes" between 0 and 120);
EXCEPTION WHEN duplicate_object THEN null; END $$;
