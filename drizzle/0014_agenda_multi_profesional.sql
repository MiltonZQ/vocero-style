-- 018 Agenda multi-profesional: equipo, catálogo de servicios, foto y la
-- garantía anti doble-booking POR PROFESIONAL.
--
-- Editada a mano sobre la generada para ser RE-EJECUTABLE (Constitución IV),
-- igual que la 0009: IF NOT EXISTS en tablas, columnas e índices, DO-block en
-- cada clave foránea y constraint, y un backfill con NOT EXISTS / IS NULL.
--
-- Es aditiva salvo por UNA pieza deliberada: `booking_org_active_slot_uq`
-- (único por organización+instante, de la 015) se elimina, porque con varios
-- profesionales dos citas pueden coincidir en el mismo instante. Lo reemplaza
-- el EXCLUDE `booking_staff_no_overlap`, que compara RANGOS por profesional.
-- Drizzle no sabe expresar el EXCLUDE ni el CHECK: viven solo aquí.
--
-- Se aplica SIEMPRE, con la bandera AGENDA encendida o apagada (ADR-001).
-- Requiere la extensión btree_gist (viene en contrib de Postgres y de la
-- imagen oficial); si el rol no puede crearla, FALLA en voz alta.
--
-- ROLLBACK (manual): recrear el índice viejo, y luego soltar lo nuevo:
--   CREATE UNIQUE INDEX "booking_org_active_slot_uq" ON "booking"
--     USING btree ("organization_id","scheduled_at")
--     WHERE "status" in ('agendada','realizada') and "is_test" = false;
--   ALTER TABLE booking DROP CONSTRAINT booking_staff_no_overlap,
--     DROP CONSTRAINT booking_session_has_staff_service;
--   (y, si hace falta, DROP de las columnas/tablas de 018).
-- El rollback FALLA si ya hay dos citas activas en el mismo instante de
-- profesionales distintos: reasignarlas antes.

CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "service" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"price_cents" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'MXN' NOT NULL,
	"job_title" text,
	"active" boolean DEFAULT true NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "service_duration_ck" CHECK ("service"."duration_minutes" between 5 and 600),
	CONSTRAINT "service_price_ck" CHECK ("service"."price_cents" >= 0),
	CONSTRAINT "service_currency_ck" CHECK (char_length("service"."currency") = 3)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "staff" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"member_id" text,
	"display_name" text NOT NULL,
	"job_title" text,
	"bio" text,
	"phone" text,
	"color" text DEFAULT '#0d5bff' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"weekly_hours" jsonb,
	"photo_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "staff_photo" (
	"staff_id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "staff_photo_size_ck" CHECK ("staff_photo"."size_bytes" <= 524288)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "staff_service" (
	"staff_id" text NOT NULL,
	"service_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"duration_minutes" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "staff_service_staff_id_service_id_pk" PRIMARY KEY("staff_id","service_id"),
	CONSTRAINT "staff_service_duration_ck" CHECK ("staff_service"."duration_minutes" is null or "staff_service"."duration_minutes" between 5 and 600)
);
--> statement-breakpoint

ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "staff_id" text;
--> statement-breakpoint

ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "service_id" text;
--> statement-breakpoint

ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "price_cents" integer;
--> statement-breakpoint

ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "currency" text;
--> statement-breakpoint

ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "legacy_overlap" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

ALTER TABLE "offered_slot" ADD COLUMN IF NOT EXISTS "staff_id" text;
--> statement-breakpoint

ALTER TABLE "offered_slot" ADD COLUMN IF NOT EXISTS "service_id" text;
--> statement-breakpoint

ALTER TABLE "offered_slot" ADD COLUMN IF NOT EXISTS "duration_minutes" integer;
--> statement-breakpoint

ALTER TABLE "offered_slot" ADD COLUMN IF NOT EXISTS "any_staff" boolean DEFAULT false NOT NULL;
--> statement-breakpoint

-- Fin de la cita: GENERADA, la define solo el SQL (Drizzle nunca la escribe).
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "ends_at" timestamp GENERATED ALWAYS AS ("scheduled_at" + "duration_minutes" * interval '1 minute') STORED;
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "service" ADD CONSTRAINT "service_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "staff" ADD CONSTRAINT "staff_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "staff" ADD CONSTRAINT "staff_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."member"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "staff_photo" ADD CONSTRAINT "staff_photo_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "staff_photo" ADD CONSTRAINT "staff_photo_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "staff_service" ADD CONSTRAINT "staff_service_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "staff_service" ADD CONSTRAINT "staff_service_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "staff_service" ADD CONSTRAINT "staff_service_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "booking" ADD CONSTRAINT "booking_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "booking" ADD CONSTRAINT "booking_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "offered_slot" ADD CONSTRAINT "offered_slot_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "offered_slot" ADD CONSTRAINT "offered_slot_service_id_service_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."service"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "service_org_active_idx" ON "service" USING btree ("organization_id","active","position");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "staff_org_active_idx" ON "staff" USING btree ("organization_id","active","position");
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "staff_member_uq" ON "staff" USING btree ("member_id") WHERE "staff"."member_id" is not null;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "staff_photo_org_idx" ON "staff_photo" USING btree ("organization_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "staff_service_org_service_idx" ON "staff_service" USING btree ("organization_id","service_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "booking_org_staff_when_idx" ON "booking" USING btree ("organization_id","staff_id","scheduled_at");
--> statement-breakpoint

-- ---------------------------------------------------------------------
-- BACKFILL (re-ejecutable: cada paso se protege con NOT EXISTS / IS NULL).
-- Los ids usan el alfabeto de newId() ([0-9a-z]) con el prefijo st_ / sv_.
-- ---------------------------------------------------------------------

-- (a) Un profesional por defecto en cada organización que no tenga ninguno.
-- Nombre: el del usuario owner, o el de la organización.
INSERT INTO "staff" ("id", "organization_id", "display_name", "active", "position")
SELECT
	'st_' || substr(md5(random()::text || clock_timestamp()::text || o."id"), 1, 20),
	o."id",
	coalesce(
		(SELECT u."name"
		   FROM "member" m JOIN "user" u ON u."id" = m."user_id"
		  WHERE m."organization_id" = o."id" AND m."role" = 'owner'
		  ORDER BY m."created_at", m."id" LIMIT 1),
		o."name"
	),
	true,
	0
FROM "organization" o
WHERE NOT EXISTS (SELECT 1 FROM "staff" s WHERE s."organization_id" = o."id");--> statement-breakpoint

-- (b) Un servicio «Cita» por organización sin catálogo, y su vínculo con el
-- profesional por defecto. Un solo statement: el vínculo solo nace con el
-- servicio (si el dueño lo quita después, no se reinventa).
WITH "created" AS (
	INSERT INTO "service" ("id", "organization_id", "name", "duration_minutes", "price_cents", "currency")
	SELECT
		'sv_' || substr(md5(random()::text || clock_timestamp()::text || o."id"), 1, 20),
		o."id",
		'Cita',
		greatest(5, least(600, coalesce(
			(SELECT cs."slot_minutes" FROM "calendar_settings" cs WHERE cs."organization_id" = o."id" LIMIT 1),
			30
		))),
		0,
		'MXN'
	FROM "organization" o
	WHERE NOT EXISTS (SELECT 1 FROM "service" sv WHERE sv."organization_id" = o."id")
	RETURNING "id", "organization_id"
)
INSERT INTO "staff_service" ("staff_id", "service_id", "organization_id")
SELECT
	(SELECT s."id" FROM "staff" s WHERE s."organization_id" = c."organization_id"
	  ORDER BY s."position", s."created_at", s."id" LIMIT 1),
	c."id",
	c."organization_id"
FROM "created" c;--> statement-breakpoint

-- (c) Toda sesión legada recibe profesional, servicio, precio y moneda. Los
-- bloqueos legados quedan con staff_id NULL = bloqueo de todo el local.
UPDATE "booking" b
SET
	"staff_id" = (SELECT s."id" FROM "staff" s WHERE s."organization_id" = b."organization_id"
	               ORDER BY s."position", s."created_at", s."id" LIMIT 1),
	"service_id" = (SELECT sv."id" FROM "service" sv WHERE sv."organization_id" = b."organization_id"
	                 ORDER BY sv."position", sv."created_at", sv."id" LIMIT 1),
	"price_cents" = 0,
	"currency" = 'MXN'
WHERE b."kind" = 'session' AND b."staff_id" IS NULL;--> statement-breakpoint

-- (d) Sesiones activas legadas que solapan con una anterior del mismo
-- profesional (la 015 solo impedía el mismo instante de INICIO): se marcan
-- para que el EXCLUDE no impida migrar. Solo se compara contra filas que SÍ
-- están bajo el constraint (legacy_overlap = false) y solo se marca, nunca
-- se desmarca: re-ejecutar no cambia nada.
UPDATE "booking" b
SET "legacy_overlap" = true
WHERE b."kind" = 'session'
	AND b."status" IN ('agendada','realizada')
	AND NOT b."is_test"
	AND NOT b."legacy_overlap"
	AND b."staff_id" IS NOT NULL
	AND EXISTS (
		SELECT 1 FROM "booking" e
		WHERE e."staff_id" = b."staff_id"
			AND e."id" <> b."id"
			AND e."kind" = 'session'
			AND e."status" IN ('agendada','realizada')
			AND NOT e."is_test"
			AND NOT e."legacy_overlap"
			AND (e."scheduled_at", e."id") < (b."scheduled_at", b."id")
			AND tsrange(e."scheduled_at", e."ends_at", '[)') && tsrange(b."scheduled_at", b."ends_at", '[)')
	);--> statement-breakpoint

-- ---------------------------------------------------------------------
-- CONSTRAINTS (DO-blocks idempotentes)
-- ---------------------------------------------------------------------

-- Una sesión siempre tiene profesional y servicio.
DO $$ BEGIN
	ALTER TABLE "booking" ADD CONSTRAINT "booking_session_has_staff_service"
		CHECK ("kind" = 'block' OR ("staff_id" IS NOT NULL AND "service_id" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

-- LA garantía: un profesional jamás tiene dos sesiones activas solapadas.
-- Rango semiabierto [): 10:00-10:30 y 10:30-11:00 no chocan. Canceladas,
-- no_show, de prueba y legacy_overlap no ocupan. staff_id NULL (bloqueo del
-- local) no participa. Violación = SQLSTATE 23P01.
-- (El índice GiST que respalda al EXCLUDE hace que un segundo ADD CONSTRAINT
-- salte como duplicate_table, no como duplicate_object: se atrapan ambos.)
DO $$ BEGIN
	ALTER TABLE "booking" ADD CONSTRAINT "booking_staff_no_overlap"
		EXCLUDE USING gist (
			"staff_id" WITH =,
			tsrange("scheduled_at", "ends_at", '[)') WITH &&
		) WHERE (
			"kind" = 'session'
			AND "status" IN ('agendada','realizada')
			AND NOT "is_test"
			AND NOT "legacy_overlap"
		);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN null; END $$;--> statement-breakpoint

-- El índice único de la 015 ya no aplica: dos profesionales pueden coincidir.
DROP INDEX IF EXISTS "booking_org_active_slot_uq";
