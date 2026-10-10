# Fase 1 — Modelo de datos

Feature: `018-agenda-multi-profesional`. **Cuatro tablas nuevas**
(`staff`, `staff_photo`, `service`, `staff_service`), **columnas nuevas** en
`booking` y `offered_slot`, un **constraint de exclusión** y la
reutilización de `member.role` para el rol de acceso. Todas las tablas nuevas
llevan `organization_id NOT NULL` con índice org-first (Constitución III) y se
consultan por `scoped()` (`src/lib/db/tenant.ts`).

La migración es **`drizzle/0014_agenda_multi_profesional.sql`** (la última
existente es `0013_nombre_del_contacto`), aditiva salvo por una pieza
deliberada —`DROP INDEX booking_org_active_slot_uq`— justificada en
research D3. Re-ejecutable (`IF NOT EXISTS` + DO-blocks + backfills con
`NOT EXISTS`), aplicada **siempre** al arrancar el contenedor
(`scripts/migrate.mjs`), con la bandera `AGENDA` encendida o apagada
(tablas vacías/inertes si apagada; ADR-001).

Prefijos de id (se agregan a `src/lib/db/ids.ts`). Existentes: `org`, `mem`,
`ct`, `cv`, `msg`, `ld`, `stg`, `lse`, `cred`, `agp`, `kb`, `tpl`, `run`,
`case`, `ma`, `cal`, `bk`, `ofs`, `zcred`, `gcred`, `att`, `cve`, `capi`. Nuevos:
**`st_`** (`staff`), **`sv_`** (`service`). No chocan (`stg_` ya es una
etapa de pipeline; el separador `_` los distingue, y el alfabeto/longitud son
los de `newId`). `staff_service` y `staff_photo` usan clave natural, sin id
propio. Los bloqueos y citas siguen siendo `bk_`.

---

## `staff` — el profesional

| Columna | Tipo | Notas |
|---|---|---|
| `id` | text PK | `st_<nanoid>` |
| `organization_id` | text NOT NULL | FK → organization, cascade |
| `member_id` | text NULL | FK → `member.id`, `ON DELETE SET NULL`. La cuenta de acceso (FR-003). NULL = perfil sin cuenta |
| `display_name` | text NOT NULL | 1–80 |
| `job_title` | text NULL | oficio libre ("barbero", "colorista"…), 1–40, normalizado a minúsculas para comparar. **Dato de perfil, no de permisos** (FR-002) |
| `bio` | text NULL | ≤ 500 |
| `phone` | text NULL | opcional, solo informativo |
| `color` | text NOT NULL default `#0d5bff` | `#RRGGBB`; color de la columna en el calendario |
| `position` | integer NOT NULL default 0 | orden de columnas / desempate de "cualquiera" |
| `active` | boolean NOT NULL default true | desactivar ≠ borrar (FR-004) |
| `weekly_hours` | jsonb NULL | misma forma que `calendar_settings.weekly_hours`; **NULL ⇒ hereda el horario del local** (FR-016) |
| `photo_version` | integer NOT NULL default 0 | 0 = sin foto; se incrementa en cada subida (cache-busting de `?v=`) |
| `created_at` / `updated_at` | timestamp NOT NULL | |

**Índices**:
- `staff_org_active_idx (organization_id, active, position)` — columnas del
  calendario y oferta del agente.
- `staff_member_uq` — UNIQUE parcial sobre `(member_id) WHERE member_id IS NOT NULL`
  — una cuenta ↔ un perfil (FR-003). Un perfil tiene como máximo una cuenta
  porque `member_id` es una sola columna.

**Validación** (Zod en `src/server/agenda/staff.ts`): nombre y oficio recortados;
`color` con regex; `weekly_hours` pasa por la misma normalización que
`upsertSettings` (`isValidInterval`, `HH:mm`, `start < end`; días sin
intervalos válidos se omiten) **y** se persiste tal cual; el recorte al horario
del local ocurre al **calcular** (research D13), no al guardar, para que subir
la apertura del local no obligue a reeditar a todos.

**Reglas**:
- Una organización siempre conserva ≥ 1 profesional **activo**: desactivar al
  último responde `409 last_active_staff` (evita dejar la agenda sin
  oferta por accidente).
- Desactivar: `active=false`; las citas futuras se **señalan** en la API
  (`needsReassignment: true`), no se tocan. La cuenta vinculada deja de
  pasar `requireActor` (research D14).
- Un profesional con citas no se borra nunca (FK `RESTRICT` desde `booking`).
  Sin citas ni cuenta se puede borrar físicamente (`DELETE /api/staff/[id]`
  → 204; con citas → 409 `has_bookings`, usar desactivar).

## `staff_photo` — foto en la propia instancia (FR-028)

| Columna | Tipo | Notas |
|---|---|---|
| `staff_id` | text PK | FK → staff, cascade (1:1) |
| `organization_id` | text NOT NULL | FK → organization, cascade; el acceso valida el tenant, no solo el id |
| `mime` | text NOT NULL | `image/jpeg` \| `image/png` \| `image/webp`, derivado de los **bytes** |
| `size_bytes` | integer NOT NULL | ≤ 524 288 (CHECK) |
| `data` | bytea NOT NULL | `customType` de Drizzle (sin tipo nativo en 0.38) |
| `updated_at` | timestamp NOT NULL | |

Separada de `staff` a propósito: ningún `SELECT … FROM staff` arrastra bytes.
Índice: `staff_photo_org_idx (organization_id)`.

## `service` — el catálogo del dueño (FR-010, FR-011)

| Columna | Tipo | Notas |
|---|---|---|
| `id` | text PK | `sv_<nanoid>` |
| `organization_id` | text NOT NULL | FK → organization, cascade |
| `name` | text NOT NULL | 1–80 |
| `duration_minutes` | integer NOT NULL | duración base, CHECK 5–600 |
| `price_cents` | integer NOT NULL default 0 | **precio único** (CHECK ≥ 0). Sin precio por profesional |
| `currency` | text NOT NULL default `MXN` | ISO-4217 en mayúsculas (3 letras) |
| `job_title` | text NULL | oficio al que aplica (sugerencia de filtrado, **no** restricción de permisos) |
| `active` | boolean NOT NULL default true | |
| `position` | integer NOT NULL default 0 | |
| `created_at` / `updated_at` | timestamp NOT NULL | |

**Índice**: `service_org_active_idx (organization_id, active, position)`.
Desactivar un servicio lo retira de toda oferta y deja intactas las citas
(FR-015: copiaron duración y precio). Borrar con citas → FK `RESTRICT` →
`409 has_bookings`.

## `staff_service` — qué hace cada profesional (FR-012, FR-014)

| Columna | Tipo | Notas |
|---|---|---|
| `staff_id` | text NOT NULL | FK → staff, cascade |
| `service_id` | text NOT NULL | FK → service, cascade |
| `organization_id` | text NOT NULL | FK → organization, cascade |
| `duration_minutes` | integer NULL | duración propia del profesional (CHECK 5–600); NULL ⇒ usa la del catálogo |
| `created_at` | timestamp NOT NULL | |

PK compuesta `(staff_id, service_id)`. Índice `staff_service_org_service_idx
(organization_id, service_id)` (para "quién ofrece X"). **No existe columna de
precio**: el ataque "staff cambia el precio" no tiene dónde aterrizar a nivel
de esquema (research D6; el 403 explícito está en el contrato).

**Duración efectiva** = `staff_service.duration_minutes ?? service.duration_minutes`
(`effectiveDuration()` en `src/server/agenda/catalog.ts`, pura).

## `booking` — columnas nuevas

| Columna | Tipo | Notas |
|---|---|---|
| `staff_id` | text NULL | FK → staff `ON DELETE RESTRICT`. Obligatoria en `session`; en `block`: el profesional (bloqueo personal) o **NULL = bloqueo de todo el local** |
| `service_id` | text NULL | FK → service `ON DELETE RESTRICT`. Obligatoria en `session`; NULL en `block` |
| `price_cents` | integer NULL | **copiado** del catálogo al reservar (FR-015). NULL en bloqueos |
| `currency` | text NULL | copiada con el precio |
| `ends_at` | timestamp **GENERATED ALWAYS AS** `(scheduled_at + duration_minutes * interval '1 minute')` **STORED** | fin de la cita; inmutable (research D1) |
| `legacy_overlap` | boolean NOT NULL default false | solo la migración la pone en true (research D2) |

`duration_minutes` ya existía y ya es una copia al reservar; ahora es la
**duración efectiva** del profesional para ese servicio en ese instante.

**Constraints**:

```sql
-- Integridad: una sesión siempre tiene profesional y servicio (FR-019).
ALTER TABLE booking ADD CONSTRAINT booking_session_has_staff_service
  CHECK (kind = 'block' OR (staff_id IS NOT NULL AND service_id IS NOT NULL));

-- LA garantía (FR-020/021): un profesional jamás tiene dos sesiones activas
-- que se solapen. Canceladas, no_show y de prueba no ocupan.
ALTER TABLE booking ADD CONSTRAINT booking_staff_no_overlap
  EXCLUDE USING gist (
    staff_id WITH =,
    tsrange(scheduled_at, ends_at, '[)') WITH &&
  ) WHERE (
    kind = 'session'
    AND status IN ('agendada','realizada')
    AND NOT is_test
    AND NOT legacy_overlap
  );
```

Rango semiabierto `[)`: 10:00–10:30 y 10:30–11:00 **no** chocan (verificado
en PG16). `staff_id` NULL no participa (bloqueos del local: research D4).

**Índices** (se **elimina** `booking_org_active_slot_uq`; se reemplaza
`booking_org_when_idx`):
- `booking_org_staff_when_idx (organization_id, staff_id, scheduled_at)` —
  tablero, agenda del profesional, disponibilidad.
- `booking_org_when_idx (organization_id, scheduled_at)` — se **conserva**
  para consultas sin filtro de profesional (bloqueos del local).
- `booking_org_status_idx` — se conserva.
- El índice GiST del constraint lo crea Postgres.

**Estados** (los de la 015, sin cambio): `agendada`, `realizada`, `no_show`,
`cancelada`. Ocupan agenda `agendada` y `realizada` (igual que
`ACTIVE_STATUSES` en `service.ts`).

```
            ┌──────────────► realizada
 agendada ──┼──────────────► no_show
            └──────────────► cancelada   (idempotente)
 reactivar (cancelada/no_show → agendada|realizada) re-evalúa el constraint:
 si el hueco fue tomado → 23P01 → 409 slot_taken
```

Mover (`reschedule`) y reasignar (`staff_id`) son `UPDATE` que pasan por el
mismo constraint; un `UPDATE` que normaliza una fila `legacy_overlap`
la pone en `false`.

## `offered_slot` — columnas nuevas (FR-030, FR-031)

| Columna | Tipo | Notas |
|---|---|---|
| `staff_id` | text NULL | FK → staff `ON DELETE CASCADE`. El profesional dueño de ESE hueco |
| `service_id` | text NULL | FK → service `ON DELETE CASCADE` |
| `duration_minutes` | integer NULL | la duración efectiva ofrecida (la reserva usa esta, no recalcula) |
| `any_staff` | boolean NOT NULL default false | true ⇒ el cliente pidió "cualquiera": permite una reasignación entre candidatos libres si hubo carrera (research D10) |

NULL en los tres primeros = ofertas anteriores a la migración (research D8).
Una oferta sigue siendo **una fila por instante** (`findOffered` compara por
epoch exacto y asume `startUtc` único por ronda: `replaceOffers` reemplaza la
oferta completa).

## `member.role` — rol de acceso (sin cambio de esquema)

Valores: **`owner`**, **`reception`**, **`staff`**. El valor legado `member`
(todas las cuentas de equipo previas) se interpreta como `reception` sin
reescribir filas (`normalizeRole`, research D5). Regla de coherencia (en
servicio, no en BD porque `member` es de Better Auth): un `member` con
`role='staff'` ⇔ existe `staff.member_id = member.id`; un perfil sin cuenta es
válido; una cuenta `staff` sin perfil activo **no ve nada** (FR-006).

## Matriz de permisos (referencia; detalle por ruta en `contracts/`)

| Capacidad | owner | reception | staff |
|---|---|---|---|
| Calendario global (día/semana, todas las columnas) | ✓ | ✓ | ✗ |
| Crear/mover/reasignar/cancelar cita de cualquiera | ✓ | ✓ | ✗ (solo las propias, sin reasignar) |
| Ver nombre y contacto del cliente de la cita | ✓ | ✓ | solo en las propias |
| Catálogo de servicios (crear/editar/precio/activar) | ✓ | ✗ (lee) | ✗ (lee activos) |
| Marcar servicios que hace + duración propia | ✓ (a cualquiera) | ✗ | ✓ (solo a sí mismo) |
| Equipo: perfiles, cuentas, desactivar | ✓ | ✗ | ✗ (edita su propio perfil: bio/foto/teléfono/color) |
| Horario y bloqueos | ✓ (todos y del local) | ✓ bloqueos (no horarios) | ✓ propios |
| Bandeja, conversaciones, contactos, leads, Lab, ajustes | ✓ | ✓ (como hoy `member`; ver nota) | ✗ |
| Eventos SSE | todos | todos | solo `booking.updated` propios |

> **Nota (SUPUESTO)**: el spec dice que recepción "no administra catálogo,
> equipo, precios ni configuración"; hoy un `member` legado sí puede tocar
> ajustes de canales/WhatsApp. Para **no regresionar** instancias existentes,
> 018 restringe a recepción solo en las superficies **nuevas** (catálogo,
> equipo/perfiles, horarios, `calendar/settings`); los demás ajustes siguen
> como hoy. Si el dueño quiere endurecer todos los ajustes, es un cambio de
> una línea por ruta (`roles: ["owner"]`) fuera de este alcance.

---

## Pasos de migración y backfill (orden dentro de `0014`)

1. `CREATE EXTENSION IF NOT EXISTS btree_gist;`
2. `CREATE TABLE IF NOT EXISTS` `staff`, `staff_photo`, `service`,
   `staff_service` + FKs en DO-blocks (patrón de `0009`).
3. `ALTER TABLE booking ADD COLUMN IF NOT EXISTS` `staff_id`, `service_id`,
   `price_cents`, `currency`, `legacy_overlap`, y `ends_at` (generada; Postgres
   reescribe la tabla una vez — aceptable en el volumen de una instancia).
   `ALTER TABLE offered_slot ADD COLUMN IF NOT EXISTS` sus cuatro columnas.
4. **Backfill** (cada INSERT/UPDATE con `WHERE NOT EXISTS`/`IS NULL`):
   a. un `staff` por defecto por organización sin ninguno (nombre: usuario
      `owner`, o el de la organización);
   b. un `service` `Cita` por organización sin catálogo
      (`duration_minutes = coalesce(calendar_settings.slot_minutes, 30)`) y su
      `staff_service` con el profesional por defecto;
   c. `UPDATE booking SET staff_id, service_id, price_cents=0, currency='MXN'
      WHERE kind='session' AND staff_id IS NULL` (bloqueos legados quedan
      `staff_id NULL` = bloqueo del local);
   d. `UPDATE booking SET legacy_overlap = true` para citas activas legadas que
      solapan con otra anterior del mismo profesional.
5. `ADD CONSTRAINT booking_session_has_staff_service` (CHECK) y
   `booking_staff_no_overlap` (EXCLUDE), ambos en DO-blocks idempotentes.
6. `DROP INDEX IF EXISTS booking_org_active_slot_uq;` y crear
   `booking_org_staff_when_idx`.
7. Sin cambios a `member`/`user`: el rol sigue siendo texto.

**Rollback**: el índice viejo se puede recrear
(`CREATE UNIQUE INDEX … WHERE status IN (…) AND NOT is_test`); las tablas y
columnas nuevas son inertes si se ignoran. No hay paso destructivo de datos.
Documentado como comentario al inicio de la migración.

**Prueba de la migración** (Slice 1, BD efímera): (a) instancia con 1 org, N
citas legadas y un par solapado parcial → migra sin error, todas con
`staff_id`/`service_id`, el par con `legacy_overlap`; (b) se ejecuta **dos
veces** → sin duplicados; (c) tras migrar, `INSERT` de dos sesiones
solapadas del mismo profesional falla con `23P01` y de dos profesionales
distintos pasa.
