# Implementation Plan: Agenda multi-profesional (equipo, catálogo de servicios y calendario global)

**Branch**: `018-agenda-multi-profesional` | **Date**: 2026-10-09 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/018-agenda-multi-profesional/spec.md`

**Estado**: planeación completa (Fase 0 + Fase 1). `tasks.md` **no** generado
(siguiente paso: `/speckit-tasks`). Carril: **ciclo completo** (toca el modelo
de datos, `/api/bot/*` y SSE — Constitución VI).

## Summary

Se extiende el motor de agenda de la 015 (un calendario por negocio) a **un
equipo de profesionales**, un **catálogo de servicios del dueño** y un
**calendario global**, manteniendo todo detrás de la bandera `AGENDA` existente
(sin bandera nueva). Tres piezas duras:

1. **No-solapamiento en la base.** `booking` gana `staff_id`, `service_id`,
   precio copiado y una columna generada `ends_at`; un constraint
   `EXCLUDE USING gist (staff_id WITH =, tsrange(scheduled_at, ends_at,'[)') WITH &&)`
   (extensión `btree_gist`) sobre sesiones activas no-prueba reemplaza al
   índice único viejo. `23P01` se traduce a `slot_taken` recuperable. El
   prototipo en PG16 confirmó solapamiento parcial rechazado, adyacencia
   permitida y el código de error (research D1/D2).
2. **Roles y aislamiento en el servidor.** `member.role ∈ owner|reception|staff`
   (texto; `member` legado ≡ `reception`); `requireActor()` resuelve rol y
   perfil; `withAuth` pasa a **deny-by-default** para `staff` (cierra las ~40
   rutas existentes con un cambio central); `bookingScope(actor)` compone con
   `scoped()`; el SSE se filtra en el servidor. Un staff solo ve su agenda, su
   perfil y nombre/contacto de sus propias citas (FR-009, opción A).
3. **Catálogo y disponibilidad por profesional/servicio.** `service` (precio
   único, solo dueño), `staff_service` (solo duración propia, **sin precio**),
   horario semanal propio con herencia y recorte al del local, duración
   efectiva `staff_service ?? service`. El agente ofrece solo combinaciones
   válidas, soporta «cualquiera» (cada hueco recuerda su profesional) y
   conserva la regla «solo se reserva lo ofrecido»; `/api/bot/*` sigue las mismas
   reglas con cambios aditivos.

La migración `0014` es aditiva y re-ejecutable: crea un profesional y un
servicio por defecto por organización, asigna las citas existentes y deja a
una instancia de un solo profesional comportándose igual que hoy (SC-006). La
foto de perfil vive en Postgres (`bytea`, tabla aparte) porque el compose
Ruta B no monta volumen de medios (research D7). El gate E2E de aislamiento
(FR-036) extiende `scripts/e2e-selftest.mjs` y se escribe **primero, en rojo**.

## Technical Context

**Language/Version**: TypeScript estricto (`strict` + `noUncheckedIndexedAccess`), Node 22

**Primary Dependencies**: **ninguna nueva**. Next.js 15 (App Router), React 19,
Drizzle ORM 0.38, `postgres` 3.x, Zod 3, Better Auth 1.6.23 (plugin
`organization`, sin `ac`/roles personalizados — research D5), `nanoid`. La
extensión de Postgres `btree_gist` es *contrib* del propio motor (no un
servicio de terceros). Fechas con `Intl` (`src/lib/time/slots.ts`).

**Storage**: PostgreSQL. Tablas nuevas: `staff`, `staff_photo` (`bytea`),
`service`, `staff_service`; columnas nuevas en `booking` (`staff_id`,
`service_id`, `price_cents`, `currency`, `ends_at` generada, `legacy_overlap`)
y `offered_slot` (`staff_id`, `service_id`, `duration_minutes`, `any_staff`);
un constraint de exclusión y un CHECK. Migración
`drizzle/0014_agenda_multi_profesional.sql` (generada para el snapshot y
**editada a mano**, como `0009`), aplicada siempre al arranque
(`scripts/migrate.mjs`).

**Testing**: Vitest para helpers puros (`effectiveHours`, `effectiveDuration`,
rejilla con duración variable, `bookingScope`, `normalizeRole`, mapeo
`23P01`, reparto de «cualquiera», equivalencia con la 015); prueba de
migración sobre BD efímera (datos legados, re-ejecución, solape legado);
`pnpm test:e2e` (`scripts/e2e-selftest.mjs`) con la sección nueva
`aislamientoChecks()` (cross-read/cross-write denegado, staff no cambia
precios, concurrencia por API y directa a BD) y las del agente con `ai-mock`;
Playwright para las pantallas; CI en matriz con `AGENDA` apagada y encendida
(patrón de la 015).

**Target Platform**: el mismo monolito self-hosted (Docker multi-stage; Coolify
Ruta A o compose + Caddy Ruta B); sin procesos, colas ni servicios nuevos.

**Project Type**: web-service + UI en el mismo Next.js.

**Performance Goals**: tablero semanal = una consulta por rango
(`booking_org_staff_when_idx`) + aritmética en memoria; disponibilidad por
profesional/servicio = una consulta de ocupados + una de bloqueos, < 50 ms
típico; «cualquiera» = una consulta de ocupados para todos los candidatos
(no N consultas). Cita del agente visible en el calendario < 5 s (SC-007) por
SSE.

**Constraints**: instantes UTC (`timestamp` sin zona); horarios en hora de
pared de la zona del negocio (una zona por instancia); DST correcto;
`organization_id` vía `scoped()` en toda query; `ends_at` y el constraint solo
con funciones inmutables (verificado); `is_test` fuera del constraint y de la
agenda real; bandera apagada ⇒ 404 en toda la superficie y prompt del agente
intacto; ninguna ruta pública con datos de citas (FR-008); deny-by-default
para `staff`.

**Scale/Scope**: un local, una zona, decenas de profesionales como máximo,
cientos de citas por semana; foto ≤ 512 KB por profesional.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Evaluado contra la constitución **1.4.0** (`.specify/memory/constitution.md`).

| Principio | Pre-research | Post-diseño (Fase 1) |
|---|---|---|
| **I. Seguridad de datos (NO NEGOCIABLE)** | ✅ Sin secretos nuevos. El riesgo es de *exposición de datos*: citas con teléfonos de clientes. | ✅ `requireActor` + `bookingScope` + deny-by-default + SSE filtrado en servidor; fuera de alcance por id → 404 sin datos; ninguna ruta pública; el staff recibe solo `{name, phone}` de sus citas, sin `contactId`. Contraseñas temporales como en `/api/settings/team` (hash por Better Auth). Foto servida con `nosniff`, sin SVG, tras sesión. Verificado por el gate E2E. |
| **II. Soberanía / Self-hosted (ENDURECIDO)** | ✅ Sin nueva dependencia externa; la foto pide almacenamiento. | ✅ Foto en Postgres (research D7): ni S3 ni volumen extra. `btree_gist` es contrib del motor ya requerido (no servicio de terceros). Sin email: la cuenta del profesional se da de alta con contraseña temporal (D14). El conector Zoom/Google sigue siendo opcional y no aplica a lo presencial (spec, Assumptions). |
| **III. Multi-tenancy real** | ✅ Toda tabla nueva con `organization_id`. | ✅ `staff`, `staff_photo`, `service`, `staff_service` con `organization_id NOT NULL` org-first; el constraint de exclusión está dentro de un tenant por construcción (`staff_id` es de una sola organización); `bookingScope` **compone** con `scoped()`, no lo sustituye; `booking_org_staff_when_idx` org-first. |
| **IV. Idempotencia** | ✅ Migración y backfill re-ejecutables. | ✅ `0014`: `IF NOT EXISTS`/DO-blocks/`NOT EXISTS`; `cancel` sigue idempotente; la confirmación concurrente del mismo hueco no duplica (constraint); `PUT staff_service` idempotente. |
| **V. Calidad verificable (NO NEGOCIABLE)** | ✅ Gate técnico + tests. | ✅ Typecheck/lint/build/vitest + migración probada + E2E; lo visual marcado «pendiente de verificación humana». |
| **VI. Specs antes de código** | ✅ Ciclo completo declarado (migración + contratos `/api/bot/*` y SSE). | ✅ Este plan + research + data-model + contracts preceden a todo código; `tasks.md` vendrá de `/speckit-tasks`. Si una slice descubre un contrato nuevo, **sube de carril** (se actualiza el plan antes de seguir). |
| **VII. Trazabilidad** | ✅ Supuestos del spec visibles. | ✅ Ocho supuestos no verificados listados al final de `research.md`; las decisiones sobre detalles que el spec deja abiertos (404 vs 403, `any` por defecto, correo = contraseña temporal) están marcadas como decisiones del plan, no del spec. |
| **VIII. Foco vertical** | ⚠️ **Tensión.** Un calendario global, perfiles con foto y catálogo se acercan a «producto de agenda». | ⚠️→✅ Se acepta con límites: (a) convierte conversaciones de WhatsApp en citas (el agente es el canal de mayor volumen, US6); (b) vive pegada a contacto/conversación/lead y detrás de `AGENDA` (la 015 ya fijó ese alcance); (c) sigue **fuera**: reservas web públicas, pagos, sucursales, notificaciones al profesional, recordatorios (spec, Assumptions). Registrada en Complexity Tracking. |
| **IX. Verificación en vivo (NO NEGOCIABLE)** | ✅ Plan de self-test definido. | ✅ `quickstart.md`: gate de aislamiento conducido contra la app viva (camino feliz e infeliz: carrera, proveedor de IA caído, hueco ocupado), Playwright en las pantallas, matriz de CI con bandera apagada/encendida. TDD: el script de aislamiento se escribe primero y se ve fallar. |
| **Restricciones de plataforma** | ✅ | ✅ Secretos: ninguno nuevo. Cifrado en reposo: no aplica (no hay credenciales nuevas). **Frontera de tenant**: la única consulta que "puede omitir" el scope por actor es la disponibilidad (necesita ver ocupados de todos), y expone solo huecos libres. Adaptadores: sin integraciones nuevas. Instancia endurecida: rutas `dev` intactas; el registro sigue cerrado. |

**Resultado del gate**: **PASA** sin violaciones; una **tensión** (VIII) y dos
**costos de complejidad** justificados abajo. Sin enmienda constitucional.
Re-evaluado tras la Fase 1: el diseño no introdujo violaciones nuevas; el
único hallazgo del diseño fue que el constraint no puede cubrir bloqueos del
local (D4), resuelto con advisory locks de Postgres y declarado.

## Project Structure

### Documentation (this feature)

```text
specs/018-agenda-multi-profesional/
├── spec.md                  # Qué y por qué (aprobado)
├── plan.md                  # Este archivo
├── research.md              # Fase 0: D1..D14 + supuestos no verificados
├── data-model.md            # Fase 1: 4 tablas, columnas nuevas, EXCLUDE, matriz de roles, backfill
├── quickstart.md            # Fase 1: correr con mocks, sembrar 2 profesionales, gate, SC-001..007
├── contracts/
│   ├── agenda-staff.md      # HTTP: equipo, servicios, horarios, citas, tablero, SSE, matriz de aislamiento
│   └── agent.md             # offer_slots/book_slot, /api/bot/*, personas del Lab
├── checklists/              # (existente) calidad del spec
└── tasks.md                 # Fase 2 (/speckit-tasks) — NO creado por este comando
```

### Source Code (repository root)

```text
drizzle/
├── 0014_agenda_multi_profesional.sql         # NUEVO · generado + editado a mano: btree_gist, tablas, backfill, EXCLUDE, DROP INDEX viejo
└── meta/{_journal.json,0014_snapshot.json}   # EDITA/NUEVO · por drizzle-kit generate

src/
├── lib/
│   ├── db/
│   │   ├── schema.ts                         # EDITA · staff, staffPhoto (customType bytea), service, staffService; columnas nuevas de booking/offeredSlot; quita booking_org_active_slot_uq; comentario sobre el EXCLUDE (vive solo en el SQL)
│   │   └── ids.ts                            # EDITA · prefijos staff: "st", service: "sv"
│   ├── auth/
│   │   ├── roles.ts                          # NUEVO · enum Role, normalizeRole("member"→"reception"), can(role, capability)
│   │   ├── actor.ts                          # NUEVO · requireActor() → {userId, organizationId, role, staffId|null}
│   │   ├── session.ts                        # EDITA · mínimo: reexporta tipos; requireSession se conserva
│   │   └── index.ts                          # EDITA · hook before: bloquea mutaciones de /organization/* para staff (defensa en profundidad, D5)
│   ├── api.ts                                # EDITA · withAuth(handler,{roles?,allowStaff?}) deny-by-default para staff
│   ├── image-sniff.ts                        # NUEVO · magic bytes JPEG/PNG/WebP (sin SVG); patrón de lib/favicon.ts
│   └── agenda-roles-ui.ts                    # NUEVO · mapa rol → entradas de nav (compartido servidor/cliente)
├── server/
│   ├── agenda/
│   │   ├── scope.ts                          # NUEVO · bookingScope(actor), assertCanWriteBooking, denyOutOfScope()
│   │   ├── staff.ts                          # NUEVO · CRUD de profesionales, cuenta vinculada, desactivar, needsReassignment
│   │   ├── catalog.ts                        # NUEVO · service CRUD, staff_service, effectiveDuration()
│   │   ├── hours.ts                          # NUEVO · effectiveHours(staffHours, shopHours) pura + persistencia
│   │   ├── photo.ts                          # NUEVO · guardar/leer foto (bytea), versionado
│   │   ├── availability.ts                   # EDITA · por {staffId,serviceId}; "any" fusiona candidatos; rejilla con duración efectiva; ocupados+buffer+bloqueos
│   │   ├── assignment.ts                     # NUEVO · escogencia determinista para "cualquiera" (reparto + desempate)
│   │   ├── locks.ts                          # NUEVO · advisory locks de org: shared (sesiones) / exclusive (bloqueos) — D4
│   │   ├── service.ts                        # EDITA · createSessionBooking con staff/servicio/precio; isSlotConflict (23505|23P01); reassign; bloqueos con locks; eventos con staffId
│   │   ├── offers.ts                         # EDITA · OfferedSlot gana staff/servicio/duración/anyStaff; mapaDeHuecosParaModelo con staff
│   │   ├── agent.ts                          # EDITA · offerSlots/bookSlot con service/staff; resolveService/resolveStaff; mensajes con nombre
│   │   ├── queries.ts                        # EDITA · listBookings por rango y alcance (bookingScope); BookingDTO; tablero
│   │   ├── http.ts                           # EDITA · códigos nuevos (service_not_offered, service_required, forbidden, last_active_staff…)
│   │   └── settings.ts                       # sin cambio de forma
│   ├── ai/
│   │   ├── actions.ts                        # EDITA · offer_slots{service?,staff?}; book_slot sin cambio
│   │   ├── prompts.ts                        # EDITA · tabla compacta de servicios/profesionales (solo con bandera)
│   │   └── pipeline.ts                       # EDITA · pasa service/staff a offerSlots; resto igual
│   ├── auth/on-signup.ts                     # EDITA · siembra staff + service por defecto en la org nueva (converge con la migración)
│   ├── events/bus.ts                         # EDITA · booking.updated gana {staffId, scope}
│   ├── lab/{personas.ts,runner.ts,judge.ts}  # EDITA · 3 personas de agenda con marcadores; criterio del juez
│   ├── dev/ai-mock.ts                        # EDITA · emite offer_slots{service,staff} y book_slot en el self-test
│   └── bot/                                  # sin cambio (auth por X-API-Key)
├── app/
│   ├── api/
│   │   ├── me/route.ts                       # NUEVO · GET (rol, staffId, agendaEnabled)
│   │   ├── staff/route.ts                    # NUEVO · GET/POST
│   │   ├── staff/[id]/route.ts               # NUEVO · GET/PATCH/DELETE
│   │   ├── staff/[id]/photo/route.ts         # NUEVO · GET/PUT/DELETE (cuerpo crudo)
│   │   ├── staff/[id]/account/route.ts       # NUEVO · POST/DELETE (reusa runInternalSignup)
│   │   ├── staff/[id]/services/route.ts      # NUEVO · GET
│   │   ├── staff/[id]/services/[serviceId]/route.ts  # NUEVO · PUT/DELETE (R-403)
│   │   ├── staff/[id]/hours/route.ts         # NUEVO · GET/PUT
│   │   ├── services/route.ts                 # NUEVO · GET/POST
│   │   ├── services/[id]/route.ts            # NUEVO · PATCH/DELETE (owner-only, 403 antes de parsear)
│   │   ├── bookings/route.ts                 # EDITA · GET por rango/alcance; POST con staff/servicio; bloqueos personales/local
│   │   ├── bookings/[id]/route.ts            # EDITA · +GET; PATCH +reassign; alcance por actor
│   │   ├── calendar/board/route.ts           # NUEVO · tablero día/semana (owner/reception)
│   │   ├── calendar/availability/route.ts    # EDITA · serviceId, staffId|any
│   │   ├── calendar/settings/route.ts        # EDITA · PUT solo owner (reception → 403)
│   │   ├── events/route.ts                   # EDITA · requireActor + filtro por rol (D9)
│   │   ├── bot/catalog/route.ts              # NUEVO · catálogo para el cerebro externo
│   │   ├── bot/availability/route.ts         # EDITA · serviceId/staffId; slots con staff
│   │   ├── settings/team/route.ts            # EDITA · POST acepta role reception|staff (default reception)
│   │   └── (resto de rutas existentes)       # sin edición: las cierra el deny-by-default de withAuth
│   └── (app)/
│       ├── calendar/page.tsx                 # NUEVO · calendario global (owner/reception)
│       ├── my-agenda/page.tsx                # NUEVO · "Mi agenda" (staff; también owner si tiene perfil)
│       ├── my-profile/page.tsx               # NUEVO · perfil propio (foto, bio, servicios+duración, horario)
│       ├── settings/staff/page.tsx           # NUEVO · Ajustes → Profesionales (owner)
│       ├── settings/services/page.tsx        # NUEVO · Ajustes → Servicios (owner)
│       ├── layout.tsx                        # EDITA · pasa rol/agenda al nav; redirect post-login de staff a /my-agenda
│       └── (inbox|contacts|pipeline|agent|lab|bookings|settings/**)/page.tsx  # EDITA · 1 línea: guardPage(session, ["owner","reception"])
├── components/
│   ├── app-nav.tsx                           # EDITA · entradas por rol; staff: solo Mi agenda / Mi perfil
│   ├── settings/settings-nav.tsx             # EDITA · pestañas Profesionales/Servicios (agenda + owner)
│   ├── calendar/{calendar-board.tsx,booking-dialog.tsx,staff-filter.tsx}   # NUEVO · columnas por profesional, día/semana, alta manual
│   ├── agenda/{my-agenda-client.tsx,profile-client.tsx,photo-upload.tsx,hours-editor.tsx,staff-services-editor.tsx}  # NUEVO
│   ├── settings/{staff-client.tsx,services-client.tsx}                    # NUEVO
│   └── bookings/bookings-client.tsx          # EDITA · columnas profesional/servicio/precio
└── hooks: components/use-events.ts           # EDITA · refetch por booking.updated sin asumir eventos de bandeja

scripts/
└── e2e-selftest.mjs                          # EDITA · aislamientoChecks(): jar de cookies por usuario, 2 profesionales, gate FR-036, concurrencia API+BD
tests/
├── unit/
│   ├── hours.test.ts · catalog.test.ts · scope.test.ts · roles.test.ts       # NUEVO
│   ├── availability-multi.test.ts · assignment.test.ts · booking-conflict.test.ts  # NUEVO (23P01→slot_taken)
│   ├── agenda-equivalence.test.ts            # NUEVO · 1 profesional/1 servicio ≡ disponibilidad de la 015 (SC-006)
│   ├── migration-0014.test.ts                # NUEVO · BD efímera (guardado por env), re-ejecución, solape legado
│   └── no-direct-booking-reads.test.ts       # NUEVO · vigilancia: schema.booking solo desde src/server/agenda/
└── e2e/us-agenda-multi.md                    # NUEVO · guion de las historias (automatizado en e2e-selftest)
.github/workflows/ci.yml                      # EDITA · la matriz de agenda ya existente corre la sección nueva
docs/adr-003-agenda-multi-profesional.md      # NUEVO · decisión registrada (EXCLUDE+btree_gist, roles en member.role, deny-by-default, foto en BD)
CLAUDE.md                                     # EDITA · filas del mapa del código (equipo/servicios, roles) — al cierre de la feature
```

**Structure Decision**: se respeta la separación del repo — helpers puros
testeables en `src/lib/` y `src/server/agenda/*.ts` (`hours`, `catalog`,
`assignment`, `scope`), dominio y garantías en `src/server/agenda/`
(`service.ts` no conoce HTTP; la carrera se prueba sin levantar la app), rutas
delgadas en `src/app/api/**` que solo traducen HTTP ↔ dominio y declaran su
matriz de roles. La autorización por actor es **una** capa (`actor.ts` +
`scope.ts` + `withAuth`), no `if (role)` disperso. Rutas en inglés con
etiquetas en español, como el resto: `/calendar` («Calendario»), `/my-agenda`
(«Mi agenda»), `/my-profile` («Mi perfil»), `/settings/staff`
(«Profesionales»), `/settings/services` («Servicios»). Los archivos de
`CLAUDE.md` y `docs/adr-003` se tocan al **cerrar** la feature, no en el plan
(esta fase solo escribe documentos de `specs/018-…`).

## Delivery slices

PRs encadenados (skill `chained-pr`; estrategia propuesta: `feature-branch-chain`
sobre `018-agenda-multi-profesional`, cada slice un PR a la anterior, el último
a `main`). **~400 líneas autorizadas cambiadas por slice es una heurística
asesora, no un tope**: si la solución correcta es más grande se explica y se
sigue. Cada slice termina con su gate técnico + la parte del E2E que le toca
en verde (nunca se mergea con el gate de aislamiento rojo); y con
la bandera apagada nada nuevo es visible. Cada tarea cierra en uno o más
commits de unidad de trabajo (Conventional Commits; tests y docs junto al
comportamiento).

| # | Slice | Contenido | Líneas est.* |
|---|---|---|---|
| 1 | **Esquema + migración + constraint + backfill** | `schema.ts` (4 tablas, columnas nuevas, quita índice viejo), `ids.ts`, `0014_*.sql` (btree_gist, backfill, `legacy_overlap`, EXCLUDE, DROP INDEX), `on-signup.ts` (siembra), `isSlotConflict` (23505\|23P01), `migration-0014.test.ts`, `booking-conflict.test.ts`. Sin cambio de comportamiento observable: la instancia sigue siendo de un profesional. | ~380 |
| 2 | **Roles, `requireActor`, scoping y esqueleto del gate** | `roles.ts`, `actor.ts`, `scope.ts`, `withAuth` deny-by-default, `guardPage` en las páginas existentes, SSE filtrado (`bus.ts`, `events/route.ts`), hook de `/organization/*`, `team/route.ts` con `role`, `GET /api/me`; en `e2e-selftest.mjs`: jar de cookies por usuario + `aislamientoChecks()` **primero en rojo** (lecturas cruzadas, superficies vedadas, cuenta sin perfil/desactivada). Tests `roles/scope`. | ~450 |
| 3 | **Equipo, catálogo y servicios por profesional (API)** | `staff.ts`, `catalog.ts`, rutas `/api/staff*`, `/api/services*`, `/api/staff/[id]/services*` (R-403), cuenta vinculada; checks E2E «staff no cambia precios». | ~420 |
| 4 | **Foto y horario/bloqueos propios (API)** | `photo.ts` + `image-sniff.ts` + ruta de foto, `hours.ts` + rutas de horario, bloqueos personales/del local con `locks.ts`; tests `hours`. | ~340 |
| 5 | **Disponibilidad y reservas por profesional/servicio** | `availability.ts` (por `{staff,service}`, «cualquiera»), `assignment.ts`, `service.ts` (staff/servicio/precio copiado, `reassign`, locks), `bookings` y `calendar/availability` routes, `queries.ts`; E2E de concurrencia (API + directa a BD) y equivalencia 015. | ~480 |
| 6 | **Agente de WhatsApp, `offered_slot` y cerebro externo** | `offers.ts`, `agent.ts`, `actions.ts`, `prompts.ts`, `pipeline.ts`, `bot/catalog`, `bot/availability`, `ai-mock`, personas del Lab + juez; E2E del agente. | ~430 |
| 7 | **UI: calendario global** | `/calendar`, `calendar/board`, componentes del tablero (día/semana, columnas, filtros, alta manual, reasignar), `use-events`, nav por rol. | ~460 |
| 8 | **UI: mi agenda, mi perfil y ajustes** | `/my-agenda`, `/my-profile`, `/settings/staff`, `/settings/services`, editor de horario y de servicios, foto, `bookings-client` con profesional/servicio. | ~460 |
| 9 | **Cierre** | `tests/e2e/us-agenda-multi.md`, CI, ADR-003, `CLAUDE.md`, Playwright de SC-003/004/007, revisión del checklist. | ~150 |

\* Estimación de líneas autorizadas (adiciones + eliminaciones, sin archivos
generados como `meta/*_snapshot.json`). Total ≈ 3 570. Las slices 5 y 6 son las
de mayor riesgo de pasar de 400: si ocurre, se parten (5a: disponibilidad;
5b: reservas/reassign) en vez de comprimir código.

**Orden y dependencias**: 1 → 2 → {3, 4} → 5 → 6 → {7, 8}. Las historias del
spec quedan así: US2 (no-solapamiento) completa en 1+5; US3 (aislamiento) en
2+5+8; US1 (equipo/catálogo) en 3+8; US4 (calendario global) en 5+7; US5
(perfil) en 3+4+8; US6 (agente) en 6. Primer valor entregable e instalable:
tras la slice 1 (garantía en BD sin cambio visible) y tras la 5 (API
completa) — ambas deployables detrás de `AGENDA`.

**TDD y reglas de trabajo**: (1) cada slice abre con el check E2E o unitario
que la justifica, visto en **rojo** antes de implementar (se anota en el
mensaje del commit); (2) los commits de unidad incluyen tests y docs; (3) el
review nativo/PR evalúa slices ya hechas, no el acumulado; (4) las
decisiones de producto abiertas (ver «Supuestos» en research) se confirman con
el dueño **antes** de la slice que las usa: contraseña temporal vs. invitación
(slice 3), moneda (slice 3), `any` por defecto (slice 6).

## Complexity Tracking

> Sin violaciones constitucionales vigentes. Se registran costos de
> complejidad aceptados y la tensión con el Principio VIII.

| Violación / costo | Por qué se necesita | Alternativa más simple rechazada porque |
|---|---|---|
| **Constraint `EXCLUDE` + extensión `btree_gist`** (SQL a mano que Drizzle no modela) | FR-020 exige la garantía en la capa de persistencia, incluido el solapamiento parcial con duraciones variables y carreras entre panel/agente/bot | *UNIQUE por instante* (el actual): no cubre parciales ni paralelismo entre profesionales. *Lock/chequeo en código*: exactamente el «chequeo de choque solo en código» que el spec prohíbe. Costo: dependencia de privilegios para `CREATE EXTENSION` (mitigado: falla ruidosa en la migración + guía en quickstart) y un constraint invisible para `db:generate` (documentado en `schema.ts`) |
| **Bloqueos fuera del constraint, con advisory locks** (D4) | Un bloqueo del local (`staff_id NULL`) no cabe en un `EXCLUDE (staff_id =)`; meter los personales rechazaría bloqueos solapados legítimos | *Fan-out por profesional*: no cubre profesionales dados de alta después y obliga a mantener grupos. *Sin lock*: la carrera sesión↔bloqueo quedaría sin cubrir. Es la única regla atómica por lock de aplicación (en Postgres, no en memoria) y tiene su check E2E |
| **`legacy_overlap`** (columna de un solo uso de migración) | Un `EXCLUDE` no admite `NOT VALID`; datos legados que ya se pisan romperían el arranque del contenedor | *Abortar la migración*: crash-loop en producción. *Borrar/mover citas*: pérdida de datos. Costo: una columna booleana explicada, que solo la migración activa |
| **`withAuth` deny-by-default para `staff`** | ~40 rutas existentes dejarían entrar a un staff a la bandeja/Lab si se confía en editar cada una (el riesgo es olvidar una) | *Allow-list por ruta nueva + editar las viejas*: un olvido = fuga de datos. Costo: las rutas que el staff sí usa deben declararlo (`allowStaff`), lo que es deliberado |
| **Foto en `bytea`** (nueva tabla) | FR-028 + Principio II; el compose Ruta B no persiste `MEDIA_DIR` | *Disco en `MEDIA_DIR`* (precedente del favicon): se pierde en Ruta B. Costo: `customType` de Drizzle y una tabla aparte |
| **Tensión con VIII (Foco vertical)** | Calendario global, perfiles y catálogo amplían el alcance de «agenda» | *No hacerlo*: el local no puede operar citas en paralelo ni el agente asignar profesional, que son la conversión del chat. Límites explícitos (sin web pública, pagos, sucursales ni notificaciones) en el spec |
