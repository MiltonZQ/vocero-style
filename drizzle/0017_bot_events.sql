-- 020 Eventos del bot: bitácora de solo anexar de lo que hace el bot en cada
-- conversación (embudo, demanda no atendida, salud). Sin cuerpos de mensaje.
--
-- Editada a mano sobre la generada para ser RE-EJECUTABLE (Constitución IV),
-- igual que la 0015 y la 0016: IF NOT EXISTS en tabla e índices y DO-block en
-- cada clave foránea. Es puramente aditiva.
--
-- ROLLBACK (manual):
--   DROP TABLE IF EXISTS "bot_event";

CREATE TABLE IF NOT EXISTS "bot_event" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"contact_id" text,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_test" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "bot_event" ADD CONSTRAINT "bot_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "bot_event" ADD CONSTRAINT "bot_event_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "bot_event" ADD CONSTRAINT "bot_event_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "bot_event_org_created_idx" ON "bot_event" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_event_org_type_created_idx" ON "bot_event" USING btree ("organization_id","type","created_at");
