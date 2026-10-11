-- 019 Bot de barbería v1.1: coordenadas del local para el pin de ubicación de
-- WhatsApp. Ambas son opcionales (sin ellas el bot manda el enlace de Maps).
--
-- Editada a mano sobre la generada para ser RE-EJECUTABLE (Constitución IV),
-- igual que la 0015: IF NOT EXISTS en columnas y DO-block en cada CHECK. Es
-- puramente aditiva.
--
-- ROLLBACK (manual):
--   ALTER TABLE "calendar_settings"
--     DROP CONSTRAINT IF EXISTS "calendar_settings_latitude_ck",
--     DROP CONSTRAINT IF EXISTS "calendar_settings_longitude_ck",
--     DROP COLUMN IF EXISTS "latitude",
--     DROP COLUMN IF EXISTS "longitude";

ALTER TABLE "calendar_settings" ADD COLUMN IF NOT EXISTS "latitude" double precision;--> statement-breakpoint
ALTER TABLE "calendar_settings" ADD COLUMN IF NOT EXISTS "longitude" double precision;--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "calendar_settings" ADD CONSTRAINT "calendar_settings_latitude_ck" CHECK ("calendar_settings"."latitude" is null or "calendar_settings"."latitude" between -90 and 90);
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "calendar_settings" ADD CONSTRAINT "calendar_settings_longitude_ck" CHECK ("calendar_settings"."longitude" is null or "calendar_settings"."longitude" between -180 and 180);
EXCEPTION WHEN duplicate_object THEN null; END $$;
