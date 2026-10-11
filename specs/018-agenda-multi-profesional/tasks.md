# Tasks: Agenda multi-profesional (equipo, catálogo de servicios y calendario global)

**Input**: Design documents from `/specs/018-agenda-multi-profesional/`

**Prerequisites**: plan.md, spec.md, research.md (D1..D14), data-model.md,
contracts/agenda-staff.md, contracts/agent.md, quickstart.md. Constitución
**1.4.0** (sin enmienda: la feature no agrega dependencias externas; ver
Complexity Tracking del plan).

**Tests**: SÍ, y primero. FR-036 y la Definición de Hecho REFORZADA los exigen,
y el plan fija TDD: cada fase abre con tests (Vitest en `tests/unit/*.test.ts`,
como el resto del repo, y verificaciones E2E que extienden
`scripts/e2e-selftest.mjs`) que **deben verse fallar (RED) antes de
implementar**; el commit de la unidad lo anota. Los códigos HTTP se comparan
EXACTOS (201/200/204/403/404/409/422), nunca `res.ok`. La suite de la 015
(`agendaChecks()`) debe seguir verde sin tocarse (SC-006).

**Organization**: por historia de usuario (US1..US6 del spec, en su orden).
Las historias comparten una base (Fase 2) que ya contiene la garantía en BD y
la autorización por actor; el gate de aislamiento (`aislamientoChecks()`) nace
en rojo en la Fase 2 y cada historia le suma sus verificaciones.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: paralelizable (archivos distintos, sin dependencia pendiente)
- **[Story]**: historia a la que pertenece (US1..US6); ausente en Setup,
  Foundational y Polish
- Rutas exactas en cada descripción (proyecto único: `src/`, `tests/`,
  `scripts/`, `drizzle/`, `docs/`)
- Convención de tests unitarios: `tests/unit/<nombre>.test.ts` (los existentes
  no usan BD; los que sí la necesitan se omiten sin `TEST_DATABASE_URL`)

## Delivery slices (plan.md) y mapa de fases

Cadena de PRs `feature-branch-chain` sobre `018-agenda-multi-profesional`. Las
~400 líneas autorizadas por slice son una **heurística asesora**, no un tope:
si la solución correcta es mayor se explica y se sigue (5 y 6 son las de riesgo;
se parten en 5a/5b si pasan). Cada slice cierra con el gate técnico + la parte
del E2E que le toca en verde; con `AGENDA` apagada nada nuevo es visible.

| Slice | Contenido | Tareas |
|---|---|---|
| 1 | Esquema + migración + constraint + backfill | T001, T002, T004, T005, T010–T019 |
| 2 | Roles, `requireActor`, scoping, esqueleto del gate (+ SSE filtrado) | T003, T006–T009, T020–T030, T063, T070, T071 |
| 3 | Equipo, catálogo y servicios por profesional (API) | T031–T042, T088, T090, T091 |
| 4 | Foto y horario/bloqueos propios (API) | T087, T089, T092–T097 |
| 5 | Disponibilidad y reservas por profesional/servicio (+ API del tablero, aislamiento de citas) | T046–T061, T062, T064–T069, T072, T075, T076–T080 |
| 6 | Agente de WhatsApp, `offered_slot`, cerebro externo | T102–T120 |
| 7 | UI: calendario global | T081–T084, T086 |
| 8 | UI: mi agenda, mi perfil y ajustes | T043–T045, T073, T074, T085, T098–T101 |
| 9 | Cierre | T121–T137 |

> Las fases siguen las historias del spec, no las slices: cada fase repite su
> **Slice** en el encabezado y la tabla es la fuente para armar los PRs. Una tarea nunca se mergea con el gate de aislamiento en rojo.

---

## Phase 1: Setup (infraestructura compartida)

**Purpose**: prefijos de id, helper de BD efímera y el arnés E2E con una jar de
cookies por usuario (hoy `scripts/e2e-selftest.mjs` usa una cookie global).

**Slice**: 1 (T001, T002) · 2 (T003)

- [X] T001 Registrar los prefijos de id `staff: "st"` y `service: "sv"` en
      `src/lib/db/ids.ts` (no chocan con `stg_`; `staff_service` y
      `staff_photo` usan clave natural, sin prefijo)
- [X] T002 [P] Crear `tests/unit/helpers/ephemeral-db.ts`: abre una BD
      Postgres efímera desde `TEST_DATABASE_URL` (esquema aislado por corrida),
      aplica `drizzle/*.sql` en orden con `postgres`, expone `run(sql)` y
      `dropAll()`, y exporta `describeDb` = `describe.skipIf(!process.env.TEST_DATABASE_URL)`
      (sin la variable los tests de BD se omiten; el resto del repo no usa BD en
      unit). Revisar `tests/unit/booking-race.test.ts` para no duplicar patrón
- [X] T003 [P] Refactorizar `api()` y `bot()` de `scripts/e2e-selftest.mjs`
      para aceptar un *jar* de cookies explícito (`newJar()`, `login(jar, email,
      password)`, `api(path, { jar, ... })`): sin `jar` se comporta EXACTO como
      hoy (cookie global `cookie`), de modo que `main()` y `agendaChecks()` no
      cambian; agregar `apiAsync` paralelo-seguro (cada llamada con su jar) para
      las pruebas de carrera

---

## Phase 2: Foundational (bloqueante para TODAS las historias)

**Purpose**: la garantía en la base (EXCLUDE + backfill) y la autorización por
actor (deny-by-default). Sin esto ninguna historia puede ser correcta.

**Slice**: 1 (esquema, migración, conflicto) · 2 (roles, actor, scope, withAuth)

**⚠️ CRITICAL**: ninguna historia arranca sin esta fase completa.

### Tests primero (deben fallar antes de implementar)

- [X] T004 [P] Crear `tests/unit/migration-0014.test.ts` (`describeDb`, usa
      T002) con tres casos del data-model: (a) BD con 1 org, N sesiones
      legadas y un par solapado parcial → migra sin error, toda sesión con
      `staff_id`/`service_id`, el par con `legacy_overlap = true`, bloqueos
      legados con `staff_id NULL`; (b) aplicar `0014` **dos veces** → mismos
      conteos de `staff`/`service`/`staff_service` (sin duplicados); (c) tras
      migrar, `INSERT` de dos sesiones solapadas del mismo `staff_id` falla con
      SQLSTATE `23P01`, adyacentes `[10:00,10:30)`/`[10:30,11:00)` pasan, dos
      profesionales distintos pasan, una `is_test` y una `cancelada` no
      ocupan. Debe fallar (no existe `0014`)
- [X] T005 [P] Crear `tests/unit/booking-conflict.test.ts`: `isSlotConflict(err)`
      es verdadero para `{ code: "23505" }` y `{ code: "23P01" }` (también
      envuelto en `err.cause`), falso para otros códigos y para no-errores;
      verifica que `BookingError("slot_taken")` es lo que se propaga. Debe
      fallar (la función aún no existe)
- [X] T006 [P] Crear `tests/unit/roles.test.ts`: `normalizeRole("member")`
      → `"reception"`; `owner|reception|staff` pasan; `null`/`undefined`/valor
      desconocido → `null` (sin acceso, nunca owner por defecto); `can(role,
      capability)` cubre la matriz de data-model.md (calendario global, catálogo,
      equipo, horarios, bandeja, SSE). Debe fallar
- [X] T007 [P] Crear `tests/unit/scope.test.ts`: `bookingScope(actor)` devuelve
      el predicado esperado — owner/reception: sin filtro extra; staff: `staff_id
      = actor.staffId OR (kind='block' AND staff_id IS NULL)`; staff con
      `staffId = null` → predicado vacío (no ve nada, FR-006); `assertCanWriteBooking`
      permite escribir lo propio y lanza `OutOfScopeError` para lo ajeno y para
      `kind='block'` del local; `denyOutOfScope()` produce `404 not_found` sin
      cuerpo con datos. Debe fallar
- [X] T008 [P] Crear `tests/unit/with-auth-staff.test.ts`: `withAuth(handler)`
      sin opciones responde `403 forbidden` a un actor `staff` y no invoca el
      handler; con `{ allowStaff: true }` lo invoca; `{ roles: ["owner"] }`
      responde 403 a `reception`; sin sesión → 401; cuenta con perfil desactivado
      → `403 account_disabled`; `member` legado se trata como `reception`.
      Mockear `requireActor`. Debe fallar
- [X] T009 Escribir en `scripts/e2e-selftest.mjs` el esqueleto de
      `aislamientoChecks()` **en rojo** y enchufarlo tras `agendaChecks()`: helper
      `sembrarEquipo()` que, con la jar del dueño, crea dos cuentas de equipo con
      `POST /api/settings/team {role:"staff"}` y las vincula a dos filas `staff`
      sembradas por SQL (`postgres`, dependencia presente) — se reemplaza por
      `POST /api/staff/[id]/account` en T033. Verificaciones de esta fase:
      (1) lectura cruzada: staff A pide `GET /api/bookings/{cita de B}` → `404`
      y `GET /api/bookings` no contiene ids de B; (4) superficies vedadas →
      `403` en `/api/conversations`, `/api/contacts`, `/api/pipeline/board`,
      `/api/lab/runs`, `/api/calendar/board`, `/api/settings/team`, y
      mutaciones de `/api/auth/organization/*` rechazadas; (5) cuenta `staff`
      sin perfil → lecturas vacías y escrituras `403`, perfil desactivado →
      `403 account_disabled`; (9) bandera apagada → `404` en `/api/staff`,
      `/api/services`, `/api/calendar/board` y `/api/me` con `agendaEnabled:false`.
      Debe fallar y verse fallar

### Slice 1 — esquema, migración, backfill, constraint

- [X] T010 Agregar a `src/lib/db/schema.ts` las tablas `staff`, `staffPhoto`
      (con `customType` `bytea` de Drizzle, `size_bytes` CHECK ≤ 524288),
      `service` (CHECK `duration_minutes` 5–600, `price_cents ≥ 0`,
      `currency` 3 letras) y `staffService` (PK compuesta `(staff_id,
      service_id)`, **sin columna de precio**), con `organization_id NOT NULL`,
      índices `staff_org_active_idx`, `staff_member_uq` (UNIQUE parcial donde
      `member_id IS NOT NULL`), `staff_photo_org_idx`, `service_org_active_idx`,
      `staff_service_org_service_idx`, exactamente como data-model.md
- [X] T011 Editar en `src/lib/db/schema.ts` `booking` (`staff_id`, `service_id`
      FK `RESTRICT`, `price_cents`, `currency`, `legacy_overlap` boolean default
      false, `ends_at` como `customType` de columna GENERADA que Drizzle no
      escribe) y `offered_slot` (`staff_id`, `service_id` FK `CASCADE`,
      `duration_minutes`, `any_staff`); **quitar** `booking_org_active_slot_uq`,
      agregar `booking_org_staff_when_idx (organization_id, staff_id,
      scheduled_at)`; comentario de intención: el `EXCLUDE` y el CHECK viven solo
      en el SQL (invisibles para `db:generate`)
- [X] T012 Generar `drizzle/0014_agenda_multi_profesional.sql` con `pnpm
      db:generate` (para `drizzle/meta/_journal.json` y
      `drizzle/meta/0014_snapshot.json`) y **editarla a mano** como la `0009`:
      comentario inicial con el rollback (recrear el índice único viejo);
      `CREATE EXTENSION IF NOT EXISTS btree_gist;` (falla en voz alta si no puede);
      tablas con `IF NOT EXISTS` y FKs en DO-blocks; `ALTER TABLE booking ADD
      COLUMN IF NOT EXISTS` incluyendo `ends_at timestamp GENERATED ALWAYS AS
      (scheduled_at + duration_minutes * interval '1 minute') STORED`; columnas
      de `offered_slot`
- [X] T013 Completar `drizzle/0014_agenda_multi_profesional.sql` con el
      **backfill** re-ejecutable (cada INSERT/UPDATE con `NOT EXISTS`/`IS NULL`):
      (a) un `staff` por organización sin ninguno (nombre del usuario `owner` o
      de la organización); (b) un `service` «Cita»
      (`duration_minutes = coalesce(calendar_settings.slot_minutes, 30)`,
      `price_cents = 0`, `currency = 'MXN'`) por organización sin catálogo y su
      `staff_service` con el profesional por defecto; (c) `UPDATE booking SET
      staff_id, service_id, price_cents = 0, currency = 'MXN' WHERE kind =
      'session' AND staff_id IS NULL` (los bloqueos legados quedan `staff_id NULL`
      = del local); (d) `legacy_overlap = true` para sesiones activas legadas que
      solapan con una anterior del mismo profesional
- [X] T014 Completar `drizzle/0014_agenda_multi_profesional.sql` con los
      constraints en DO-blocks idempotentes: CHECK
      `booking_session_has_staff_service (kind = 'block' OR (staff_id IS NOT NULL
      AND service_id IS NOT NULL))` y `EXCLUDE USING gist (staff_id WITH =,
      tsrange(scheduled_at, ends_at, '[)') WITH &&) WHERE (kind='session' AND
      status IN ('agendada','realizada') AND NOT is_test AND NOT legacy_overlap)`
      llamado `booking_staff_no_overlap`; luego `DROP INDEX IF EXISTS
      booking_org_active_slot_uq;` y crear `booking_org_staff_when_idx`
- [X] T015 Aplicar `0014` con `pnpm db:migrate` dos veces sobre la BD local
      (con datos de la 015) y poner en verde `tests/unit/migration-0014.test.ts`
      con `TEST_DATABASE_URL`; correr las consultas de comprobación del
      quickstart §2 (1 staff y 1 service por organización, 0 sesiones sin
      staff/service). Depende de T012–T014
- [X] T016 Editar `src/server/auth/on-signup.ts` para sembrar, en la
      organización nueva, el `staff` por defecto (nombre del dueño, `active`,
      `position 0`) y el `service` «Cita» con su `staff_service`, idempotente y
      convergente con el backfill de la migración
- [X] T017 Editar `src/server/agenda/service.ts`: exportar `isSlotConflict(err)`
      (`23505` | `23P01`, incluyendo `err.cause`) y usarla donde hoy se detecta
      `23505` — `createSessionBooking`, `rescheduleBooking`,
      `rescheduleForConversation` y la reactivación en `markBookingStatus` —
      traduciendo a `BookingError("slot_taken")`; pone en verde
      `tests/unit/booking-conflict.test.ts`
- [X] T018 Editar `src/server/agenda/service.ts` (`createSessionBooking`,
      `createBlock`) y `src/server/agenda/availability.ts`: **compatibilidad
      temporal** para que la 015 siga funcionando con el CHECK nuevo — si el
      input no trae `staffId`/`serviceId`, resolver el único `staff` activo y el
      único `service` activo de la organización (si hay más de uno → `422
      service_required`), copiar `duration_minutes`, `price_cents` y `currency`
      del catálogo, y filtrar `computeAvailability`/`findSlot` por ese
      `staff_id`. Comentario `// TEMPORAL (018 US2): se reemplaza por selección explícita`
- [X] T019 Checkpoint Slice 1: `pnpm typecheck && pnpm lint && pnpm test` y
      `pnpm test:e2e` con `AGENDA=on`: `agendaChecks()` de la 015 verde sin
      tocarla (SC-006) con la BD ya migrada. `aislamientoChecks()` sigue en rojo
      (esperado)

### Slice 2 — roles, actor, scope, deny-by-default

- [X] T020 Crear `src/lib/auth/roles.ts`: `type Role = "owner" | "reception" |
      "staff"`, `normalizeRole(raw)` (`"member"` → `"reception"`, desconocido →
      `null`) y `can(role, capability)` con la matriz de data-model.md; pone en
      verde `tests/unit/roles.test.ts`
- [X] T021 Crear `src/lib/auth/actor.ts`: `requireActor()` →
      `{ userId, organizationId, role, staffId | null }` (resuelve `member.role`
      con `normalizeRole`, y para `staff` busca `staff.member_id = member.id`);
      errores `ForbiddenError` y `AccountDisabledError` (perfil `active=false` o
      sin perfil activo → ver D14); helper `guardPage(actor, roles)` para
      páginas (redirige a `/my-agenda` si staff, a `/inbox` si no autorizado).
      Reexportar tipos desde `src/lib/auth/session.ts` sin cambiar
      `requireSession`
- [X] T022 Crear `src/server/agenda/scope.ts`: `bookingScope(actor)`
      (compone con `scoped()` de `src/lib/db/tenant.ts`, no lo sustituye),
      `assertCanWriteBooking(actor, booking)`, `OutOfScopeError`,
      `denyOutOfScope()` (→ `404 not_found` sin datos). Pone en verde
      `tests/unit/scope.test.ts`
- [X] T023 Editar `src/lib/api.ts`: `withAuth(handler, opts?)` con
      `opts = { roles?: Role[]; allowStaff?: boolean }` — resuelve
      `requireActor()`, **`staff` denegado por defecto** (`403 forbidden`) salvo
      `allowStaff`, `roles` restringe además a owner/reception, `403
      account_disabled` para cuentas sin acceso; el handler recibe la sesión
      más el `actor`. Las ~40 rutas existentes quedan cerradas sin editarlas.
      Pone en verde `tests/unit/with-auth-staff.test.ts`
- [X] T024 Editar `src/lib/auth/index.ts`: hook `before` de Better Auth que
      rechaza (`403`) las mutaciones de `/organization/*` cuando el usuario es
      `staff` (defensa en profundidad, research D5)
- [X] T025 Editar `src/app/api/settings/team/route.ts`: el POST acepta `role`
      (`"reception" | "staff"`, por defecto `"reception"`; `owner` no se puede
      crear por aquí); un `staff` creado sin perfil vinculado sigue siendo válido
      (no ve nada, FR-006)
- [X] T026 Crear `src/app/api/me/route.ts` (`GET`, `allowStaff: true`):
      `{ user: {id,name,email}, role, staffId, agendaEnabled }`. Evalúa la
      bandera sin devolver 404 (informa `agendaEnabled:false`); no es fuente de
      autorización
- [X] T027 [P] Crear `src/lib/agenda-roles-ui.ts`: mapa rol → entradas de
      navegación (compartido servidor/cliente): owner/reception ven todo +
      «Calendario»; staff solo «Mi agenda» y «Mi perfil»; todo detrás de
      `agendaEnabled`
- [X] T028 Cerrar las páginas existentes con `guardPage(actor,
      ["owner","reception"])` (una línea por archivo): `src/app/(app)/inbox/page.tsx`,
      `src/app/(app)/contacts/page.tsx`, `src/app/(app)/pipeline/page.tsx`,
      `src/app/(app)/agent/page.tsx`, `src/app/(app)/lab/page.tsx`,
      `src/app/(app)/bookings/page.tsx` y `src/app/(app)/settings/layout.tsx`
      (cubre todas las páginas de ajustes)
- [X] T029 Crear `tests/unit/no-direct-booking-reads.test.ts`: vigilancia que
      falla si algún archivo fuera de `src/server/agenda/` importa `booking` de
      `@/lib/db/schema` para consultarla (`rg`-style sobre el árbol); la
      excepción documentada es `scripts/seed/demo.ts`. Se corrige en
      T060/T113 si hoy hay violaciones (`bot`, `ai`, `lab`)
- [X] T030 Checkpoint Slice 2: `pnpm typecheck && pnpm lint && pnpm test`;
      `aislamientoChecks()` — las verificaciones (4) superficies vedadas, (5)
      cuenta sin perfil/desactivada y (9) bandera apagada en VERDE; la (1)
      lectura cruzada sigue en rojo hasta US3. Registrar en el mensaje del
      commit el RED observado antes de implementar

**Checkpoint**: la base garantiza no-solapamiento en la BD y niega todo a
`staff` por defecto; ya se puede construir cada historia.

---

## Phase 3: User Story 1 - El dueño arma su equipo y su catálogo (Priority: P1)

**Goal**: el dueño crea/edita/desactiva profesionales, les da cuenta con rol
`staff`, y administra el catálogo de servicios con precio único.

**Independent Test**: con `AGENDA=on`, el dueño crea dos profesionales y tres
servicios desde la API/UI; aparecen en el equipo, el catálogo y el listado de
`GET /api/staff`; reception/staff reciben `403` al intentar mutar.

**Slice**: 3 (API) · 8 (UI de ajustes)

### Tests primero (US1)

- [X] T031 [P] [US1] Crear `tests/unit/catalog.test.ts`: `effectiveDuration(
      staffService, service)` = propia o catálogo; Zod de servicio
      (`durationMinutes` 5–600, `priceCents ≥ 0`, `currency` ISO en mayúsculas,
      `.strict()` rechaza campos desconocidos con `invalid_body`); `jobTitle`
      normalizado a minúsculas. Debe fallar
- [X] T032 [P] [US1] Crear `tests/unit/staff.test.ts`: validación Zod de
      `StaffInput` (nombre 1–80, `color` `#RRGGBB`, `weeklyHours` normalizado como
      `upsertSettings`), `canDeactivate(activeCount)` → `last_active_staff` si es
      el último, `needsReassignment` (inactivo con citas futuras), `StaffDTO` no
      expone `memberId` y oculta `accountEmail` a reception. Debe fallar
- [X] T033 [US1] Agregar a `aislamientoChecks()` en `scripts/e2e-selftest.mjs`
      las verificaciones de US1 (RED): owner `POST /api/staff` → **201**,
      `POST /api/services` → **201**; reception y staff `POST /api/staff` y
      `POST /api/services` → **403**; `PATCH /api/services/{id}` con
      `{priceCents:1}` como staff y como reception → **403** (antes de parsear) y
      precio intacto releído con la jar del dueño; `POST /api/staff/{id}/account`
      → **201** y la cuenta entra y `GET /api/me` devuelve `role:"staff"` con su
      `staffId`; `PATCH /api/staff/{id} {active:false}` sobre el último activo →
      **409 `last_active_staff`**; desactivar uno → su login recibe
      `403 account_disabled`; `DELETE /api/staff/{id}` con citas → **409
      `has_bookings`**, con cuenta → **409 `has_account`**. Sustituir en
      `sembrarEquipo()` (T009) la siembra SQL por la ruta de cuenta

### Implementación (US1)

- [X] T034 [US1] Crear `src/server/agenda/catalog.ts`: `effectiveDuration()`
      (pura), tipos `ServiceDTO`/`StaffServiceDTO`, y CRUD de `service` con
      `scoped()` — `createService`, `updateService` (incl. `active`),
      `deleteService` (`409 has_bookings` si hay citas), `listServices(actor,
      {includeInactive})`; precio único, sin precio por profesional. Pone en
      verde `tests/unit/catalog.test.ts`
- [X] T035 [US1] Crear `src/server/agenda/staff.ts`: `StaffDTO` y CRUD de
      perfiles — `createStaff`, `updateStaff` (owner: todo; el subconjunto del
      staff se aplica en US3), `deactivateStaff` (`last_active_staff`, marca
      `needsReassignment`), `deleteStaff` (`has_bookings` / `has_account`),
      `listStaff`, `linkAccount`/`unlinkAccount` sobre `staff.member_id`
      (UNIQUE parcial, 1 cuenta ↔ 1 perfil). Pone en verde
      `tests/unit/staff.test.ts`
- [X] T036 [US1] Editar `src/server/agenda/http.ts`: códigos estables nuevos
      `forbidden`, `account_disabled`, `last_active_staff`, `has_bookings`,
      `has_account`, `service_required`, `service_not_offered`, `duplicate`, y su
      mapeo a estado HTTP (403/409/422) para todas las rutas del feature
- [X] T037 [US1] Crear `src/app/api/staff/route.ts`: `GET` (owner/reception
      todos con `?includeInactive=1`; staff solo el propio o `[]`) y `POST`
      (owner, body `.strict()`, **201** `{ staff }`; reception/staff → 403).
      Todas las rutas del feature empiezan con `agendaDisabledResponse` (404
      apagado) y luego `withAuth`
- [X] T038 [US1] Crear `src/app/api/staff/[id]/route.ts`: `GET` (owner/reception;
      staff solo el propio, 404 si no), `PATCH` (owner todo incluido `active`;
      reception → 403; staff → ver T069), `DELETE` (owner, **204**)
- [X] T039 [P] [US1] Crear `src/app/api/staff/[id]/account/route.ts`: `POST`
      `{ email, name?, password ≥ 8 }` → crea usuario + `member{role:'staff'}`
      reutilizando `runInternalSignup` (`src/lib/auth/index.ts`) y vincula
      (**201** `{ok:true}`, `409 duplicate`, 422); `DELETE` desvincula y retira el
      `member` (**204**). Solo owner
- [X] T040 [P] [US1] Crear `src/app/api/services/route.ts`: `GET` (owner/reception
      todos con `?includeInactive=1`; staff solo activos y solo lectura, con
      `allowStaff`) y `POST` (owner, `.strict()`, **201**). El 403 de
      reception/staff se decide **antes** de parsear el cuerpo (R-403)
- [X] T041 [P] [US1] Crear `src/app/api/services/[id]/route.ts`: `PATCH` y
      `DELETE` solo owner; reception/staff → `403 forbidden` antes de parsear
      (R-403, FR-013); `DELETE` → **204** o `409 has_bookings`
- [X] T042 [US1] Ejecutar `aislamientoChecks()` y dejar en verde las
      verificaciones de US1 (T033); registrar RED→GREEN en el commit

### UI de ajustes (US1) — Slice 8

- [x] T043 [P] [US1] Crear `src/components/settings/staff-client.tsx` y
      `src/app/(app)/settings/staff/page.tsx` («Profesionales», solo owner vía
      `guardPage`): lista con color/oficio/estado, alta y edición, activar/
      desactivar con aviso de citas por reasignar, creación de cuenta con
      contraseña temporal. Todo texto en español; estados vacío/cargando/error
- [x] T044 [P] [US1] Crear `src/components/settings/services-client.tsx` y
      `src/app/(app)/settings/services/page.tsx` («Servicios», solo owner):
      tabla de catálogo (nombre, duración base, precio único, moneda, oficio,
      activo), alta/edición/desactivación; reception ve solo lectura
- [x] T045 [US1] Editar `src/components/settings/settings-nav.tsx`: pestañas
      «Profesionales» y «Servicios» visibles solo con agenda encendida y rol
      owner. Marcar lo visual como **pendiente de verificación humana** hasta
      tener capturas de Playwright (T128)

**Checkpoint**: el dueño arma equipo y catálogo; el gate de US1 en verde.

---

## Phase 4: User Story 2 - Nunca dos citas solapadas del mismo profesional (Priority: P1)

**Goal**: reservar por `{profesional, servicio}` con duración efectiva y precio
copiados; la garantía vive en la BD y las carreras panel/agente/API producen
exactamente una cita.

**Independent Test**: dos `POST /api/bookings` simultáneos solapados para el
mismo profesional → un 201 y un 409 `slot_taken`; mismo horario con
profesionales distintos → dos 201; dos `INSERT` directos a la BD → `23P01`.

**Slice**: 5 (5a: disponibilidad; 5b: reservas/reassign)

### Tests primero (US2)

- [X] T046 [P] [US2] Crear `tests/unit/hours.test.ts`: `effectiveHours(staffHours,
      shopHours)` — `null` hereda el del local; el propio se **recorta** a la
      intersección con la apertura del local (nunca la excede); día sin franja
      válida se omite; franjas partidas; subir la apertura del local no obliga a
      reeditar (recorte al calcular, D13). Debe fallar
- [X] T047 [P] [US2] Crear `tests/unit/availability-multi.test.ts`: rejilla con
      **duración variable** (corte 45 min, tinte 90 min no cabe a las 19:00 si
      cierra a las 20:00), solapamiento parcial bloquea (60 min a las 10:00
      excluye 10:15), adyacencia permitida, bloqueo personal y bloqueo del local
      excluyen, cancelada y `is_test` no ocupan, DST (America/New_York y
      Europe/Madrid, hora inexistente/ambigua) y respiro. Debe fallar
- [X] T048 [P] [US2] Crear `tests/unit/agenda-equivalence.test.ts` (SC-006):
      con 1 profesional y 1 servicio de la duración global, la disponibilidad
      nueva produce EXACTAMENTE los mismos huecos que la de la 015 para los
      fixtures de `tests/unit/availability.test.ts` (franja partida, aviso
      mínimo, ventana). Debe fallar hasta T052
- [X] T049 [P] [US2] Crear `tests/unit/booking-service-rules.test.ts`:
      `validateBookingTarget()` rechaza con `service_not_offered` si el
      profesional no ofrece el servicio o está inactivo, con `slot_taken` si
      cae fuera del horario efectivo o choca con bloqueo; la cita copia
      `durationMinutes` efectiva y `priceCents`/`currency` del catálogo
      (FR-015); cambiar después el precio del catálogo no altera la cita. Debe
      fallar
- [X] T050 [US2] Agregar a `aislamientoChecks()` en `scripts/e2e-selftest.mjs`
      (RED) las verificaciones de no-solapamiento: (6) 100 pares de `POST
      /api/bookings` solapados para el mismo profesional con `Promise.all`, en
      100 horarios distintos → en cada par exactamente un **201** y un **409
      `slot_taken`** con `slots` hermano de `error`; mismos horarios con
      profesionales distintos → dos **201**; (7) dos `INSERT` simultáneos
      directos con `postgres` del mismo `staff_id` solapado → uno falla con
      SQLSTATE `23P01`; (8) bloqueo del local y sesión simultáneos dentro del
      rango → nunca queda una sesión creada después del bloqueo dentro de su
      rango (o el bloqueo la lista en `conflicts`); cita cancelada libera el
      hueco; `PATCH reschedule` a un hueco ocupado → **409**; cita de prueba
      (`is_test`) no ocupa

### Implementación (US2)

- [X] T051 [US2] Crear `src/server/agenda/hours.ts`: `effectiveHours(
      staffHours, shopHours)` pura (intersección y recorte), `normalizeWeeklyHours`
      reutilizando la validación de `src/server/agenda/settings.ts`
      (`isValidInterval`, `HH:mm`, `start < end`). Pone en verde
      `tests/unit/hours.test.ts` (la persistencia llega en T095)
- [X] T052 [US2] Editar `src/server/agenda/availability.ts`: `computeAvailability`
      y `findSlot` por `{ staffId, serviceId }` — horario efectivo
      (`effectiveHours`), duración efectiva (`effectiveDuration`), ocupados del
      profesional + respiro + bloqueos personales y del local en UNA consulta de
      ocupados y UNA de bloqueos, rejilla de candidatos que cabe antes del cierre;
      retira la resolución temporal de T018. Pone en verde
      `tests/unit/availability-multi.test.ts` y `tests/unit/agenda-equivalence.test.ts`
- [X] T053 [P] [US2] Crear `src/server/agenda/locks.ts`: advisory locks de
      organización a nivel de transacción — `withSessionLock(tx, orgId)` (shared)
      y `withBlockLock(tx, orgId)` (exclusive), claves derivadas de forma
      estable de `organization_id` (research D4); documentar por qué el
      constraint no cubre los bloqueos del local (`staff_id NULL`)
- [X] T054 [US2] Editar `src/server/agenda/service.ts` `createSessionBooking`:
      exige `staffId` y `serviceId`; valida con `validateBookingTarget` (ofrece
      el servicio, activo, dentro del horario efectivo, sin bloqueo — FR-023);
      inserta `duration_minutes` efectiva + `price_cents` + `currency` copiados;
      toma el lock *shared*; `isSlotConflict` → `slot_taken` con alternativas
      frescas del mismo profesional/servicio. Pone en verde
      `tests/unit/booking-service-rules.test.ts`
- [X] T055 [US2] Editar `src/server/agenda/service.ts`: `createBlock` acepta
      `staffId` (bloqueo personal) o `null` (todo el local) con el lock
      *exclusive* para el del local; si hay sesiones dentro del rango devuelve
      `conflicts: [{ bookingId, staffId, label }]` sin cancelarlas (D4)
- [X] T056 [US2] Editar `src/server/agenda/service.ts`: `rescheduleBooking`
      conserva el profesional; nuevo `reassignBooking({ bookingId, staffId,
      keepDuration })` que valida servicio ofrecido, activo, horario, bloqueos y
      toma el constraint (`23P01` → `slot_taken`); `markBookingStatus` al
      reactivar re-evalúa el constraint; `cancelBooking` sigue idempotente; los
      eventos `booking.updated` llevan `staffId` y `scope`
- [X] T057 [US2] Editar `src/app/api/bookings/route.ts`: `POST` con las dos
      formas del contrato (`kind:"session"` con `staffId`, `serviceId`,
      `contactId` o `contact{name,phone}`, `startUtc`; `kind:"block"` con
      `staffId|null`, `durationMinutes`), **201** con el sobre de la 015 más
      duración efectiva; `422 service_not_offered`; `409 slot_taken` con `slots`
      frescos hermanos de `error`; el rol `staff` se ajusta en US3 (T067)
- [X] T058 [US2] Editar `src/app/api/bookings/[id]/route.ts`: `PATCH` con
      `action` `reschedule | reassign | cancel | status | retry_link`;
      `reassign` solo owner/reception (staff → 403); códigos exactos 200/409
- [X] T059 [US2] Editar `src/app/api/calendar/availability/route.ts`: parámetros
      `serviceId` y `staffId` (`any` se agrega en T108); compatibilidad 015 —
      sin `serviceId` y con exactamente 1 servicio y 1 profesional activos se
      usan; si no → `422 service_required` con `{ services }`; respuesta con
      `staffId`, `staffName`, `serviceId`, `durationMinutes`, `priceCents` por
      hueco
- [X] T060 [US2] Revisar los consumidores de `createSessionBooking`/`findSlot`
      (`src/server/agenda/agent.ts`, `src/app/api/bot/bookings/route.ts`) para
      que sigan compilando y verdes con la firma nueva usando el único
      profesional/servicio (el reparto real llega en US6); corregir cualquier
      lectura directa de `booking` fuera de `src/server/agenda/` que marque
      `tests/unit/no-direct-booking-reads.test.ts`
- [X] T061 [US2] Correr `pnpm test:e2e`: verificaciones (6), (7), (8) de T050
      en verde, y `agendaChecks()` de la 015 sin cambios. Registrar RED→GREEN

**Checkpoint**: no existe forma de producir dos sesiones solapadas del mismo
profesional; SC-001 y SC-006 verificados.

---

## Phase 5: User Story 3 - Cada profesional ve y maneja solo lo suyo (Priority: P1)

**Goal**: aislamiento del lado del servidor para el rol `staff` en listado,
detalle, escritura, SSE y superficies; «Mi agenda».

**Independent Test**: con dos profesionales sembrados, A pide la cita de B → 404
sin datos; su listado jamás contiene citas de B; no abre calendario, catálogo,
equipo ni ajustes.

**Slice**: 2 (SSE) · 5 (API) · 8 (UI)

### Tests primero (US3)

- [X] T062 [P] [US3] Crear `tests/unit/booking-dto.test.ts`: `toBookingDTO(
      booking, actor)` — para `staff` el `contact` es `{ name, phone }` **sin
      `id`**, sin `conversationId`, sin citas ajenas; el bloqueo del local se ve
      como `{ kind:"block", staff:null, notes }`; owner/reception ven todo. Debe
      fallar
- [X] T063 [P] [US3] Crear `tests/unit/events-filter.test.ts`: el filtro de
      SSE por rol — owner/reception reciben todo; staff recibe solo
      `booking.updated` con `staffId` propio o `scope:"shop"`; staff sin perfil no
      recibe nada; el payload no contiene datos del cliente. Debe fallar
- [X] T064 [US3] Completar en `scripts/e2e-selftest.mjs` el gate de aislamiento
      (RED): (1) lectura cruzada — `GET /api/bookings/{B}` como A → **404** sin
      datos, `GET /api/bookings` solo citas de A + bloqueos del local; (2)
      escritura cruzada — `PATCH` cancel/reschedule/status de la cita de B como
      A → **404** y la cita de B no cambió (releída como dueño), `POST
      /api/bookings` con `staffId` de B → **403**, con un servicio que A no
      ofrece → **422 `service_not_offered`**, `PATCH /api/staff/{B}` → 403/404,
      `PATCH reassign` como A → **403**; A agenda para sí mismo → **201**; (4)
      A recibe 403 en el calendario global; (SSE) el stream de A solo emite
      `booking.updated` propios (abrir `GET /api/events` con la jar de A, crear
      citas de A y de B, leer eventos durante una ventana)

### Implementación (US3)

- [X] T065 [US3] Editar `src/server/agenda/queries.ts`: `listBookings(actor,
      { from, to, staffId, jobTitle, status })` construido SIEMPRE con
      `scoped(…, bookingScope(actor), …)`, rango por días en la zona del negocio
      convertido a UTC (DST-seguro), compatibilidad 015 (sin `from/to`: últimas
      200); `getBooking(actor, id)` → `null` fuera de alcance; `toBookingDTO`
      con la forma del contrato (`staff`, `service`, `priceCents`, `currency`,
      `endsAtUtc`, `legacyOverlap`). Pone en verde `tests/unit/booking-dto.test.ts`
- [X] T066 [US3] Editar `src/app/api/bookings/route.ts` y crear
      `GET /api/bookings/[id]` en `src/app/api/bookings/[id]/route.ts`
      (`allowStaff: true`): `GET` lista por alcance, `GET [id]` 200 o **404**
      fuera de alcance; el `staffId` del request, si viene, debe coincidir con el
      propio o `403 forbidden`, si falta se fuerza el propio; staff sin perfil →
      listas vacías 200 y escrituras 403
- [X] T067 [US3] Editar `POST /api/bookings` (`src/app/api/bookings/route.ts`)
      para el actor `staff`: `staffId` forzado al propio (otro → `403`), solo
      servicios que ofrece, cliente por `contactId` de un contacto ya vinculado a
      sus citas o por `contact{name,phone}` (alta rápida con
      `src/server/inbox/identity.ts`, sin acceso a la ficha); bloqueos
      personales sí, bloqueo del local → `403`
- [X] T068 [US3] Editar `PATCH /api/bookings/[id]` (`src/app/api/bookings/[id]/route.ts`):
      usar `assertCanWriteBooking`; ajena o inexistente → `404 not_found` sin
      cuerpo; staff puede `reschedule`, `cancel`, `status`, `retry_link` sobre lo
      propio; `reassign` → 403
- [X] T069 [US3] Editar `PATCH /api/staff/[id]` en
      `src/app/api/staff/[id]/route.ts`: staff sobre sí mismo solo
      `{ bio, phone, color }` (cualquier otro campo — `displayName`, `jobTitle`,
      `active`, `position` — **403 forbidden**, no 422); sobre otro perfil 404
- [X] T070 [US3] Editar `src/server/events/bus.ts`: `booking.updated` pasa a
      `{ bookingId, staffId: string|null, scope: "own"|"shop"|"staff" }` (sin
      datos de cliente) y exporta `eventVisibleTo(actor, event)`; editar
      `src/app/api/events/route.ts` para usar `requireActor`, `403
      account_disabled`, y filtrar **en el servidor** (staff solo
      `booking.updated` propios o del local; sin perfil → stream abierto sin
      eventos; mismos headers y heartbeat `: ping`). Pone en verde
      `tests/unit/events-filter.test.ts`
- [X] T071 [P] [US3] Editar `src/components/use-events.ts`: refetch por
      `booking.updated` sin asumir eventos de bandeja (que el staff nunca recibe)
- [X] T072 [US3] Verificar que `GET /api/staff/[id]/photo` y `GET
      /api/staff/[id]/services` respeten el alcance del staff (404 en otro
      perfil) cuando existan (T094, T091) — dejar la aserción en
      `aislamientoChecks()` (foto ajena → 404)

### UI «Mi agenda» (US3) — Slice 8

- [x] T073 [P] [US3] Crear `src/components/agenda/my-agenda-client.tsx` y
      `src/app/(app)/my-agenda/page.tsx`: vista del día/semana del profesional
      con sus citas y bloqueos (más los del local), acciones cancelar/mover/
      realizada/no-show, alta manual solo para sí mismo y con sus servicios,
      refresco por `useEvents`
- [x] T074 [US3] Editar `src/app/(app)/layout.tsx` y `src/components/app-nav.tsx`:
      pasar rol/`agendaEnabled` (vía `requireActor`) al nav con
      `src/lib/agenda-roles-ui.ts`; el staff queda con «Mi agenda»/«Mi perfil»;
      redirect post-login del staff a `/my-agenda` (SC-004, un solo paso)
- [X] T075 [US3] Correr `pnpm test:e2e`: todas las verificaciones de
      aislamiento (1), (2), (4), (5), SSE en verde; `GET /api/events` del staff
      sin eventos ajenos ni de bandeja. Registrar RED→GREEN

**Checkpoint**: aislamiento verificado por API/SSE/UI; SC-002 (parte lectura/
escritura) y SC-004 verificables.

---

## Phase 6: User Story 4 - Calendario global para dueño y recepción (Priority: P1)

**Goal**: calendario por día y semana con una columna por profesional, citas en
paralelo, alta manual con duración autocompletada.

**Independent Test**: recepción agenda tres citas a las 10:00 con tres
profesionales; las tres aparecen lado a lado y ninguna se rechaza; una cita del
agente aparece sin recargar.

**Slice**: 5 (API del tablero) · 7 (UI)

### Tests primero (US4)

- [X] T076 [P] [US4] Crear `tests/unit/calendar-board.test.ts`: `buildBoard()`
      arma columnas solo de profesionales activos (más los inactivos con citas
      futuras en `needsReassignment`), `hours` efectivo por día, `shopBlocks`
      aparte, filtros por `staffId`/`jobTitle`, rango `days=1|7` en la zona del
      negocio incluyendo el cambio de horario de verano. Debe fallar
- [X] T077 [US4] Agregar a `aislamientoChecks()` (RED) las verificaciones de US4:
      reception agenda 3 citas a las 10:00 con 3 profesionales → tres **201** y
      el tablero las devuelve en tres columnas; la misma hora con el mismo
      profesional → **409**; reception `GET /api/calendar/board` → **200**, staff
      → **403**; el filtro por `jobTitle` reduce las columnas; una cita creada por
      el agente (`wa-mock` + `ai-mock`) aparece en el tablero y se mide el tiempo
      hasta el evento SSE `booking.updated` (SC-007, < 5 s)

### Implementación (US4)

- [X] T078 [US4] Editar `src/server/agenda/queries.ts`: `buildBoard(actor,
      { from, days, staffId, jobTitle })` con UNA consulta por rango
      (`booking_org_staff_when_idx`) y aritmética en memoria; columnas,
      `hours` efectivo por día, `bookings`, `needsReassignment`, `shopBlocks`.
      Pone en verde `tests/unit/calendar-board.test.ts`
- [X] T079 [US4] Crear `src/app/api/calendar/board/route.ts` (`GET`, roles
      `["owner","reception"]`; staff → 403 FR-007; parámetros `from`, `days`
      `1|7`, `staffId`, `jobTitle`; forma del contrato)
- [X] T080 [US4] Editar `src/app/api/calendar/settings/route.ts`: `PUT` solo
      owner (reception → 403 con la defensa de R-403), `GET` owner/reception;
      staff → 403 en ambos
- [x] T081 [P] [US4] Crear `src/components/calendar/staff-filter.tsx`: filtros
      por profesional y por oficio, estado en la URL
- [x] T082 [P] [US4] Crear `src/components/calendar/booking-dialog.tsx`: alta
      manual — elige columna/hora, profesional, servicio (solo los que ese
      profesional ofrece), cliente (`contactId` o alta rápida); la duración y el
      precio se autocompletan desde `GET /api/calendar/availability`; errores
      `slot_taken`/`service_not_offered` recuperables mostrando alternativas;
      acciones reasignar/mover/cancelar para citas existentes
- [x] T083 [US4] Crear `src/components/calendar/calendar-board.tsx` y
      `src/app/(app)/calendar/page.tsx` (`guardPage(["owner","reception"])`):
      vista día y semana, una columna por profesional con su color, citas en
      paralelo, bloqueos del local atravesando columnas, citas por reasignar
      señaladas; actualización por `useEvents` sin recargar (FR-026)
- [x] T084 [US4] Editar `src/components/app-nav.tsx` y
      `src/lib/agenda-roles-ui.ts`: entrada «Calendario» para owner/reception
      con agenda encendida
- [x] T085 [US4] Editar `src/components/bookings/bookings-client.tsx` y
      `src/app/(app)/bookings/page.tsx`: columnas profesional, servicio y precio;
      reacciona al nuevo `BookingDTO`
- [x] T086 [US4] Correr `pnpm test:e2e`: verificaciones de US4 (T077) en verde;
      captura de Playwright del calendario con 3 columnas guardada para
      revisión visual (**pendiente de verificación humana**)

**Checkpoint**: operación diaria del local posible; SC-003 y SC-007 medibles.

---

## Phase 7: User Story 5 - Perfil con servicios, duración propia y horario (Priority: P2)

**Goal**: cada profesional marca qué servicios hace y ajusta solo la duración;
horario propio con herencia; foto en la instancia; precio intocable por staff.

**Independent Test**: A marca «Corte clásico» con 45 min (catálogo 30): sus
huecos son de 45 min y el precio mostrado es el del catálogo; el intento de A de
cambiar el precio recibe 403 y no cambia nada.

**Slice**: 3 (servicios por profesional) · 4 (foto, horario, bloqueos) · 8 (UI)

### Tests primero (US5)

- [X] T087 [P] [US5] Crear `tests/unit/image-sniff.test.ts`: `sniffImage(bytes)`
      reconoce JPEG, PNG y WebP por *magic bytes* (ignora el `content-type`
      declarado), rechaza SVG/HTML/vacío, límite 524 288 bytes. Debe fallar
- [X] T088 [P] [US5] Crear `tests/unit/staff-services.test.ts`: `PutStaffService`
      Zod `.strict()` solo acepta `{ durationMinutes?: 5–600 | null }`; para el
      actor staff cualquier otra clave (`priceCents`, `price`, `name`) produce
      `ForbiddenError` (403, no 422); idempotencia de marcar dos veces; duración
      `null` vuelve a la del catálogo. Debe fallar
- [ ] T089 [US5] Agregar a `aislamientoChecks()` (RED) las verificaciones de US5.
      Slice 4 ya dejó foto, SVG/vacío/413 y el 403 de recepción en horas, más
      `pendiente` de la rejilla de 45 min. Sigue abierto el resto (precio,
      duración y horario que rige la disponibilidad):
      (3) `PUT /api/staff/{A}/services/{id}` con `{priceCents:1}` como A → **403**
      y precio intacto; A marca un servicio con 45 min → `availability` devuelve
      huecos de 45 min y `priceCents` del catálogo; el dueño sube el precio →
      las citas ya agendadas conservan el precio y la duración; el cambio de
      duración no altera citas futuras; horario propio de A (mar–sáb) rige y
      nunca excede el del local; sin horario propio hereda el del local; `PUT
      /api/staff/{A}/photo` con PNG válido → **200** `{ photoUrl, version }`,
      SVG → **422 `unsupported`**, > 512 KB → **413 `too_large`**, vacío →
      **422 `empty`**; `GET` foto ajena como A → **404**; reception `PUT
      /api/staff/{id}/hours` → **403**

### Implementación (US5)

- [X] T090 [US5] Editar `src/server/agenda/catalog.ts`: `listStaffServices(actor,
      staffId)`, `putStaffService` (idempotente, valida servicio activo y de la
      organización), `deleteStaffService`; un staff solo opera sobre su propio
      `staffId`; devuelve `StaffServiceDTO` con `effectiveDurationMinutes` y el
      precio del catálogo solo lectura. Pone en verde `tests/unit/staff-services.test.ts`
- [X] T091 [US5] Crear `src/app/api/staff/[id]/services/route.ts` (`GET`,
      owner/reception/staff propio) y
      `src/app/api/staff/[id]/services/[serviceId]/route.ts` (`PUT` body
      `.strict()`, `DELETE` **204**; reception → 403; staff con clave distinta de
      `durationMinutes` → **403 forbidden** antes de validar — R-403; servicio
      inactivo o ajeno → 404)
- [X] T092 [P] [US5] Crear `src/lib/image-sniff.ts` (*magic bytes* JPEG/PNG/WebP,
      sin SVG; patrón de `src/lib/favicon.ts`). Pone en verde
      `tests/unit/image-sniff.test.ts`
- [X] T093 [US5] Crear `src/server/agenda/photo.ts`: guardar/leer/borrar en
      `staff_photo` (`bytea`), valida tamaño y tipo desde los bytes, incrementa
      `staff.photo_version`, valida el tenant en cada acceso
- [X] T094 [US5] Crear `src/app/api/staff/[id]/photo/route.ts`: `PUT` cuerpo
      crudo (patrón de `src/app/api/settings/branding/favicon/route.ts`),
      `DELETE` **204**, `GET` bytes con `Content-Type` real,
      `X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=86400`;
      owner todo, staff solo el propio, reception solo `GET`; 404 si no hay foto
      o fuera de alcance
- [X] T095 [US5] Editar `src/server/agenda/hours.ts`: `getStaffHours(actor,
      staffId)` (`weeklyHours`, `effectiveWeeklyHours`, `inheritsShopHours`) y
      `putStaffHours` (normaliza, `null` vuelve a heredar); crear
      `src/app/api/staff/[id]/hours/route.ts` (`GET` owner/reception/staff
      propio; `PUT` owner o staff propio, reception → 403, **200**)
- [ ] T096 [US5] Editar `src/server/agenda/staff.ts`: `StaffDTO` completo
      (`hasPhoto`, `photoUrl` versionada `?v=`, `effectiveWeeklyHours`,
      `hasAccount`) y la edición del subconjunto del staff (bio, teléfono,
      color); confirmar que `GET /api/staff/[id]` entrega servicios.
      Slice 4 ya rellena foto y horario efectivo en lista, ficha y alta
      (`toStaffDTO` sigue puro: sin argumentos extra, los tests viejos ven
      `hasPhoto: false` y `effectiveWeeklyHours === weeklyHours`). PATCH sigue
      solo del dueño: el subconjunto del staff no se abrió en esta tanda.
- [ ] T097 [US5] Correr `pnpm test:e2e`: verificaciones de US5 (T089) y (3)
      «staff no cambia precios» en verde. Registrar RED→GREEN

### UI de perfil (US5) — Slice 8

- [x] T098 [P] [US5] Crear `src/components/agenda/photo-upload.tsx`: subir/quitar
      foto (cuerpo crudo, errores 413/422 en español, vista previa)
- [x] T099 [P] [US5] Crear `src/components/agenda/hours-editor.tsx`: editor del
      horario semanal con «usar el horario del local», recorte visible al horario
      de apertura
- [x] T100 [P] [US5] Crear `src/components/agenda/staff-services-editor.tsx`:
      lista el catálogo activo, marca/desmarca servicios y ajusta solo la
      duración; muestra el precio del catálogo en solo lectura
- [x] T101 [US5] Crear `src/components/agenda/profile-client.tsx` y
      `src/app/(app)/my-profile/page.tsx`: foto, bio, oficio, servicios con
      duración efectiva y precio, horario efectivo y enlace a la agenda (staff y
      owner con perfil); los perfiles de otros los edita el owner desde
      `src/app/(app)/settings/staff/page.tsx` reutilizando estos componentes

**Checkpoint**: perfil completo y precio inalterable por staff; FR-012/013/014/016
verificados.

---

## Phase 8: User Story 6 - El agente de WhatsApp agenda con profesional y servicio (Priority: P2)

**Goal**: el agente ofrece solo combinaciones válidas, soporta «cualquiera»,
mantiene la regla «solo se reserva lo ofrecido» y `/api/bot/*` sigue las mismas
reglas; Laboratorio con personas de agenda.

**Independent Test**: en el Laboratorio, «corte con Juan mañana» y «barba, el
que esté libre» terminan con cita `is_test` asignada al profesional correcto y
con la duración efectiva correcta.

**Slice**: 6

### Tests primero (US6)

- [X] T102 [P] [US6] Crear `tests/unit/assignment.test.ts`: la escogencia de
      «cualquiera» — fusión de candidatos libres, reparto equitativo entre
      profesionales (el menos cargado del día) y desempate determinista por
      `position`; reintento con otro candidato libre si hubo carrera (D10); nunca
      elige a un profesional que no ofrece el servicio. Debe fallar
- [X] T103 [P] [US6] Crear `tests/unit/agent-resolve.test.ts`:
      `resolveService(name, services)` y `resolveStaff(name, staff)` — exacto →
      minúsculas → sin acentos (patrón de `resolveStage`), `"any"`/omitido →
      `any`, sin coincidencia → `null` (nunca inventa ni lanza); instancia de un
      solo profesional/servicio no pregunta (FR-032). Debe fallar
- [X] T104 [P] [US6] Editar `tests/unit/agenda-huecos-modelo.test.ts` y
      `tests/unit/agenda-contract.test.ts`: `mapaDeHuecosParaModelo` añade
      `· <staff>` solo si hay profesional nombrado; `OfferedSlot` incluye
      `staffId`, `serviceId`, `durationMinutes`, `anyStaff`; `offer_slots`
      acepta `service?`/`staff?` y `book_slot` no cambia; con bandera apagada el
      esquema/prompt del agente no cambia (0 tokens). Debe fallar
- [X] T105 [P] [US6] Editar `tests/unit/agenda-sandbox.test.ts`: una
      conversación `is_test` produce cita `is_test` (fuera del constraint y de la
      disponibilidad real) y nunca llega a un conector, también con
      profesional/servicio. Debe fallar si se rompe el guardrail
- [X] T106 [US6] Agregar a `scripts/e2e-selftest.mjs` una sección
      `agenteMultiChecks()` (RED), con `ai-mock` y `wa-mock`, que cubre los 7
      puntos de contracts/agent.md §4: (1) servicio + profesional nombrado →
      todos los huecos ofrecidos son de ese profesional y de duración efectiva;
      (2) `any` → la cita queda con el `staffId` del hueco elegido; (3)
      profesional que no ofrece el servicio → texto con alternativas, sin oferta
      y sin cita; (4) hueco ocupado entre oferta y confirmación → disculpa +
      alternativas, **cero** citas creadas; (5) instancia de un profesional → no
      menciona profesional; (6) conversación `is_test` → cita `is_test`; (7)
      `/api/bot/*`: `GET /api/bot/catalog` 200, `POST /api/bot/bookings` **201**
      exacto con `staffId`, `staffName`, `serviceName`, `durationMinutes`,
      `priceCents`, y `409 slot_not_offered`/`slot_taken` con `slots` hermano;
      oferta sin `staff_id` en instancia multi-profesional → `409
      slot_not_offered`; proveedor de IA caído → el turno degrada sin reservar

### Implementación (US6)

- [X] T107 [US6] Crear `src/server/agenda/assignment.ts`: `pickAssignee(
      candidates, load)` pura (reparto + desempate por `position`) y
      `rankCandidates`; pone en verde `tests/unit/assignment.test.ts`
- [X] T108 [US6] Editar `src/server/agenda/availability.ts`: modo `staffId:
      "any"` — UNA consulta de ocupados para todos los candidatos que ofrecen el
      servicio (no N consultas), fusión de huecos por instante con el profesional
      asignado por `assignment.ts`; `GET /api/calendar/availability` en
      `src/app/api/calendar/availability/route.ts` acepta `staffId=any`
- [X] T109 [US6] Editar `src/server/agenda/offers.ts`: `OfferedSlot` y
      `replaceOffers`/`getOffers` con `staffId`, `serviceId`, `durationMinutes`,
      `anyStaff` (una fila por instante, `findOffered` por epoch exacto);
      `mapaDeHuecosParaModelo` añade `· staff` solo con profesional nombrado;
      ofertas legadas (columnas NULL) siguen leyéndose (D8)
- [X] T110 [US6] Editar `src/server/agenda/agent.ts`: `resolveService`,
      `resolveStaff` (pone en verde `tests/unit/agent-resolve.test.ts`);
      `offerSlots({ service, staff })` con las reglas de oferta (solo
      combinaciones válidas, profesional que no ofrece → lo dice y propone a
      quien sí sin registrar oferta, un solo profesional/servicio → no se
      pregunta); `bookSlot` toma `staffId`/`serviceId`/`durationMinutes` de la
      fila ofrecida, valida con `findSlot`, `slot_taken` con reintento único si
      `anyStaff`, alternativas frescas registradas, y confirma
      `¡Listo! Te agendé para <label> con <Nombre>.`
- [X] T111 [P] [US6] Editar `src/server/ai/actions.ts`: `offer_slots` con
      `service?` y `staff?` (esquema solo con bandera, `agentActionSchema(agenda)`);
      `book_slot` sin cambio de entrada
- [X] T112 [P] [US6] Editar `src/server/ai/prompts.ts`: sección condicional de
      agenda con tabla compacta de servicios activos (`nombre — duración —
      precio`) y por servicio los profesionales que lo ofrecen (`nombre
      (oficio)`); con la bandera apagada, 0 tokens
- [X] T113 [US6] Editar `src/server/ai/pipeline.ts`: pasar `service`/`staff` a
      `offerSlots`; degradar a respuesta generada por el motor si no resuelven;
      un fallo del proveedor nunca crea una cita a medias. Corregir cualquier
      lectura directa de `booking` que marque `tests/unit/no-direct-booking-reads.test.ts`
- [X] T114 [P] [US6] Crear `src/app/api/bot/catalog/route.ts` (`GET`, auth
      `requireBotKey`, bandera antes que la llave): servicios activos con los
      profesionales activos que los ofrecen y `effectiveDurationMinutes`,
      `singleStaff`, `singleService`; sin `phone` de profesionales
- [X] T115 [US6] Editar `src/app/api/bot/availability/route.ts`: parámetros
      `serviceId`, `staffId` (`id|any`), registra la oferta con
      `staff_id/service_id/duration`; `422 service_required` con `services` si es
      ambiguo, `422 service_not_offered`, `404 not_found` conversación
      inexistente; respuesta con `staffId`, `staffName`, `priceCents` por hueco
- [X] T116 [US6] Editar `src/app/api/bot/bookings/route.ts`: `POST` cuerpo sin
      cambio, **201** exacto con los campos nuevos; `PATCH` reprograma con el
      mismo profesional y servicio (`offered_slot.staff_id = booking.staff_id`,
      otro profesional → `409 slot_not_offered`); `409 slot_taken` con `slots`
      hermano
- [X] T117 [P] [US6] Editar `src/server/dev/ai-mock.ts`: emitir `offer_slots`
      con `service`/`staff` y `book_slot` según las frases del guion del
      self-test (profesional nombrado, «el que esté libre», servicio no
      ofrecido)
- [X] T118 [P] [US6] Editar `src/server/lab/personas.ts` y
      `src/server/lab/runner.ts`: personas `agenda_profesional_nombrado`,
      `agenda_cualquiera` y `agenda_servicio_no_ofrecido` con marcadores
      `{{service1}}`, `{{service2}}`, `{{staff1}}` resueltos contra el primer
      servicio/profesional activos y relacionados de la instancia de prueba; si
      el runner no admite marcadores, resolverlos al construir el guion
- [X] T119 [US6] Editar `src/server/lab/judge.ts`: criterio de agenda que
      verifica profesional, servicio y duración con el estado de la BD de la
      corrida (SC-005 ≥ 95 %); el juicio con modelo real queda **pendiente de
      verificación humana** si no hay `OPENROUTER_API_TOKEN`
- [X] T120 [US6] Correr `pnpm test:e2e` (`agenteMultiChecks()`): los 7 puntos en
      verde, incluido el camino infeliz; corridas del Laboratorio con `ai-mock`.
      Registrar RED→GREEN

**Checkpoint**: el agente asigna profesional y servicio correctos; FR-029..033
verificados.

---

## Phase 9: Polish & cierre (Slice 9)

**Purpose**: matriz de CI con la bandera apagada y encendida, documentación,
mapa de código y el gate final.

- [ ] T121 [P] Editar `tests/unit/agenda-flag.test.ts`: con `AGENDA` ausente
      todas las rutas nuevas (`/api/staff*`, `/api/services*`,
      `/api/calendar/board`) responden 404 (`agendaDisabledResponse`) **antes**
      de la autenticación; `/api/me` informa `agendaEnabled:false`; el prompt
      del agente no cambia
- [ ] T122 [P] Editar `.github/workflows/ci.yml`: agregar un `services:
      postgres` (imagen `postgres:16-alpine`, la misma del compose, trae
      `btree_gist`) y `TEST_DATABASE_URL` al job `gates` para que
      `tests/unit/migration-0014.test.ts` corra en las dos configuraciones de la
      matriz (`default` sin agenda y `completo` con `AGENDA: "on"`); `pnpm
      test:e2e` necesita la app viva y no corre en CI (se corre local en ambas
      configuraciones, ver T134 y T135)
- [ ] T123 [P] Crear `docs/adr-003-agenda-multi-profesional.md`: decisión
      registrada (EXCLUDE + `btree_gist`, roles en `member.role` con `member` ≡
      `reception`, `withAuth` deny-by-default, foto en `bytea`, advisory locks
      para bloqueos del local), alternativas rechazadas y costos (Complexity
      Tracking del plan); patrón de `docs/adr-002-conectores-de-agenda.md`
- [ ] T124 [P] Crear `docs/agenda-multi-profesional.md`: guía para el dueño y
      para quien adapta la instancia — roles y qué ve cada uno, alta de equipo y
      catálogo, horarios con herencia, cómo funciona «cualquiera», el
      requisito `btree_gist` y qué hacer si el rol no puede `CREATE EXTENSION`
- [ ] T125 [P] Editar `CLAUDE.md` (fila del mapa del código: equipo/servicios/
      roles → `src/server/agenda/{staff,catalog,hours,scope,locks,assignment}.ts`,
      `src/lib/auth/{roles,actor}.ts`, `src/lib/api.ts` (`withAuth`
      deny-by-default); nota: el no-solapamiento vive en `booking_staff_no_overlap`
      de la migración `0014`, no en el código) y `specs/README.md` (fila de
      `018` en la tabla de specs: ciclo completo)
- [ ] T126 [P] Editar `README.md` (sección de agenda, ~línea 102 y la de
      «motor de agendamiento», ~línea 457): equipo, catálogo, calendario global y
      roles de acceso; sigue siendo opcional y apagada por defecto
- [ ] T127 [P] Crear `tests/e2e/us-agenda-multi.md`: guion manual/automatizado
      de US1..US6 (formato de `tests/e2e/us-agenda.md`) que enlaza cada paso a su
      verificación en `aislamientoChecks()` / `agenteMultiChecks()` y al
      recorrido del quickstart §4
- [ ] T128 Crear `scripts/e2e-agenda-multi-ui.mjs` (Playwright, patrón de
      `scripts/e2e-favicon.mjs`): SC-003 — recepción agenda una cita presencial
      desde `/calendar` en ≤ 30 s cronometrados; SC-004 — el login del staff
      aterriza directo en `/my-agenda`; SC-007 — una cita del agente aparece en el
      calendario < 5 s por SSE; capturas de las pantallas nuevas (columnas del
      calendario, perfil, foto) como evidencia, marcadas **pendiente de
      verificación humana**
- [ ] T129 Registrar `scripts/e2e-agenda-multi-ui.mjs` en `package.json`
      (script `test:e2e:agenda-ui`) y llamarlo desde el cierre documentado en
      `tests/e2e/us-agenda-multi.md`; `aislamientoChecks()` y
      `agenteMultiChecks()` ya corren dentro de `pnpm test:e2e`
- [ ] T130 Cerrar el gate de aislamiento en `scripts/e2e-selftest.mjs`: añadir
      un resumen final de `aislamientoChecks()` que falle el proceso si
      cualquiera de las verificaciones (1)–(9) no corrió; confirmar que cubre
      FR-036 literalmente — lectura cruzada, escritura cruzada, staff no cambia
      precios, y dos reservas simultáneas solapadas → exactamente una
- [ ] T131 Revisar la lista de verificación por criterio de éxito del
      quickstart §7 (SC-001..SC-007) y actualizar `specs/018-agenda-multi-profesional/checklists/`
      si algún requisito del spec quedó sin tarea ni prueba; resolver las
      decisiones de producto pendientes del plan (contraseña temporal vs.
      invitación, moneda, `any` por defecto) con el dueño y anotarlas en
      `specs/018-agenda-multi-profesional/research.md`

---

## Gate de Hecho (Definición de Hecho REFORZADA)

Ninguna tarea ni slice se declara Hecha sin esto, en este orden, y ninguno se
delega al usuario:

- [ ] T132 Gate técnico: `pnpm typecheck && pnpm lint && pnpm build && pnpm test`
      en verde (incluye `migration-0014.test.ts` con `TEST_DATABASE_URL`)
- [ ] T133 Migración: aplicar `0014` dos veces sobre una BD con datos de la 015
      y repetir las consultas del quickstart §2; sin cambios en la segunda corrida
- [ ] T134 `pnpm test:e2e` con la app viva y mocks, **`AGENDA=on`**
      (`WA_MOCK_ENABLED=true`, `META_GRAPH_BASE_URL` → wa-mock,
      `OPENROUTER_BASE_URL` → ai-mock): `main()`, `agendaChecks()` (015),
      `aislamientoChecks()` y `agenteMultiChecks()` verdes; códigos exactos
- [ ] T135 `pnpm test:e2e` con **`AGENDA` ausente**: toda la superficie nueva
      responde 404, `/api/me` informa `agendaEnabled:false`, no existen
      `/calendar` ni `/my-agenda`, y el resto de la instancia funciona igual
- [ ] T136 Recorrido de `specs/018-agenda-multi-profesional/quickstart.md` §4
      con Playwright (T128) y camino infeliz (carrera, proveedor de IA caído,
      hueco ocupado, cuenta sin perfil, perfil desactivado) sin colgarse
- [ ] T137 Diagnosticar y corregir cualquier fallo observado y re-verificar
      hasta verde (loop de auto-corrección); lo visual se anota **pendiente de
      verificación humana** con capturas (Constitución V/IX)

---

## Dependencies & Story Completion Order

### Phase Dependencies

- **Setup (1)** → **Foundational (2)** → historias → **Polish (9)** → **Gate de Hecho**.
- **US1 (3)**: tras Foundational (usa `roles`/`actor`/`withAuth`).
- **US2 (4)**: tras Foundational (constraint, `isSlotConflict`); usa `catalog.ts`
  y `staff.ts` de US1 para validar «ofrece el servicio» (T054) → tras US1.
- **US3 (5)**: tras US2 (necesita citas creables por `staffId`) y Foundational
  (`scope.ts`, `withAuth`); la UI «Mi agenda» tras US3 backend.
- **US4 (6)**: tras US2 (reservas) y US3 (`queries.ts` por alcance, SSE).
- **US5 (7)**: tras US1 (`catalog.ts`, `staff.ts`) y Foundational; la
  disponibilidad con duración propia se verifica sobre US2. La UI reutiliza
  `staff-client.tsx` (US1).
- **US6 (8)**: tras US2 (reservas) y US5 (duración efectiva/servicios por
  profesional); `assignment.ts` y `ai-mock` se pueden adelantar.
- **Polish (9)** y **Gate de Hecho**: tras las historias que se entreguen.

Orden de slices del plan: 1 → 2 → {3, 4} → 5 → 6 → {7, 8}. Orden de historias
resultante: US1 → US2 → US3 → US4 → US5 → US6, con US1 backend y US5 backend
(Slices 3 y 4) interleaved antes de US2 si se quiere seguir las slices al pie
de la letra; la dependencia dura es solo la de arriba.

### Parallel Opportunities

- **Setup**: T002 ∥ T003 (T001 independiente).
- **Foundational tests**: T004 ∥ T005 ∥ T006 ∥ T007 ∥ T008 (T009 aparte, toca
  `scripts/e2e-selftest.mjs`).
- **Foundational impl**: T010→T011 secuencial (mismo archivo); T012→T014
  secuencial (mismo SQL); T016 y T017 ∥ tras T011; T020 ∥ T027 (archivos
  distintos); T022 tras T021.
- **US1**: T031 ∥ T032; T039 ∥ T040 ∥ T041; T043 ∥ T044.
- **US2**: T046 ∥ T047 ∥ T048 ∥ T049; T053 ∥ T051.
- **US3**: T062 ∥ T063; T071 ∥ T073.
- **US4**: T081 ∥ T082 tras el contrato del tablero.
- **US5**: T087 ∥ T088; T092 ∥ T098 ∥ T099 ∥ T100.
- **US6**: T102 ∥ T103 ∥ T104 ∥ T105; T111 ∥ T112 ∥ T114 ∥ T117 ∥ T118.
- **Polish**: T121 ∥ T122 ∥ T123 ∥ T124 ∥ T125 ∥ T126 ∥ T127.

### Ejemplos de ejecución en paralelo

```text
# Fase 2 — todos los tests RED a la vez (archivos distintos)
T004 tests/unit/migration-0014.test.ts
T005 tests/unit/booking-conflict.test.ts
T006 tests/unit/roles.test.ts
T007 tests/unit/scope.test.ts
T008 tests/unit/with-auth-staff.test.ts

# US1 — rutas independientes tras catalog.ts/staff.ts
T039 src/app/api/staff/[id]/account/route.ts
T040 src/app/api/services/route.ts
T041 src/app/api/services/[id]/route.ts

# US5 — componentes de perfil
T098 src/components/agenda/photo-upload.tsx
T099 src/components/agenda/hours-editor.tsx
T100 src/components/agenda/staff-services-editor.tsx
```

---

## Implementation Strategy

**MVP = Fases 1–2 + US2 + US3 como mínimo, con US1 como prerrequisito técnico
de US2.** Decisión a partir de las prioridades del spec: las cuatro historias P1
(US1–US4) son el producto, pero lo que NO se puede entregar a medias es la
garantía de datos (US2: nunca dos citas solapadas) y la privacidad (US3: un
profesional no ve citas ajenas — fue el hueco explícito del proyecto previo).
Con Foundational + US1 (equipo y catálogo para tener *a quién* y *qué* agendar)
+ US2 + US3 ya se puede operar el local por API con las dos garantías
verificadas por el gate (FR-036 completo salvo el cierre de US5 sobre precios).
**Recomendado antes de llamarlo producción**: sumar US4 (sin el calendario
global el local no opera citas en paralelo con comodidad; SC-003). US5 y US6
(P2) son recortables sin tocar la promesa central: US5 deja la duración propia y
la foto para después (el dueño puede fijar duraciones por API), US6 deja al
agente en modo de la 015 (un profesional, un servicio) sin regresión.

**Entrega incremental** (cada checkpoint se despliega detrás de `AGENDA`):
1. Tras Fase 2 / Slice 1: garantía en BD sin cambio visible (instalable).
2. Tras US2: API de reservas completa por profesional/servicio (Slice 5).
3. Tras US3: aislamiento verificado; staff puede entrar a «Mi agenda».
4. Tras US4: calendario global para la operación diaria.
5. Tras US5/US6: autonomía del profesional y agente multi-profesional.

**Regla transversal** (Constitución V/IX + CLAUDE.md): ninguna task se declara
Hecha sin el gate técnico en verde, ninguna historia sin su sección del
self-test E2E corrida contra la app viva (camino feliz Y camino infeliz), y
**nunca se mergea una slice con el gate de aislamiento en rojo**. Cada slice abre
con la verificación que la justifica, vista en rojo antes de implementar (se
anota en el mensaje del commit). Commits de unidad (Conventional Commits) con
tests y docs junto al comportamiento.

## Notes

- `aislamientoChecks()` y `agenteMultiChecks()` viven en
  `scripts/e2e-selftest.mjs`; las tareas que lo editan (T003, T009, T033, T050,
  T064, T077, T089, T106, T130) **no** son `[P]` entre sí.
- `src/server/agenda/service.ts`, `availability.ts`, `queries.ts`,
  `catalog.ts`, `staff.ts` y `hours.ts` se editan en varias fases: las tareas
  que tocan el mismo archivo son secuenciales y ninguna lleva `[P]`.
- `.env.example` no cambia: la feature no agrega variables de entorno (usa la
  bandera `AGENDA` existente y `TEST_DATABASE_URL` solo para tests).
- Evitar: tasks vagas, dos tasks `[P]` sobre el mismo archivo, lecturas de
  `booking` fuera de `src/server/agenda/` (lo vigila `no-direct-booking-reads.test.ts`),
  y cualquier `if (role)` disperso fuera de `actor.ts`/`scope.ts`/`withAuth`.
