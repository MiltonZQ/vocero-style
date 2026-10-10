# Pasos del plan — 018 Agenda multi-profesional (Style)

Resumen ejecutable del plan. El detalle vive en [plan.md](plan.md),
[tasks.md](tasks.md) (137 tareas), [spec.md](spec.md) y
[data-model.md](data-model.md).

## Qué se pidió

- Una instancia de Style gestiona varios perfiles de profesionales (barbero,
  colorista, manicurista…). El oficio (`job_title`) es dato de perfil, no un
  permiso.
- Calendario global: en un mismo horario conviven citas de distintos
  profesionales.
- **Nunca** dos reservas solapadas del mismo profesional, garantizado en la base
  de datos.
- Cada profesional entra con su usuario y ve **solo** su agenda, su perfil y los
  datos de los clientes de sus citas (sin inbox, contactos, leads ni Laboratorio).
- Catálogo de servicios del dueño con **un solo precio por servicio**. Cada
  profesional elige qué servicios hace y puede ajustar solo su duración. El
  precio lo edita únicamente el dueño (403 para staff).
- Perfil por profesional: foto, bio, oficio, servicios, horario propio y agenda.

## Decisiones clave

| Tema | Decisión |
|---|---|
| Roles | `owner`, `reception`, `staff` en `member.role` (el `member` heredado se lee como `reception`) |
| No-solapamiento | `EXCLUDE USING gist (staff_id WITH =, tstzrange(scheduled_at, ends_at) WITH &&)` con `btree_gist`; el error `23P01` se traduce a `slot_taken` |
| Bloqueos del local | `staff_id` NULL, serializados con advisory locks |
| Aislamiento | `requireActor()` + `bookingScope(actor)` sobre `scoped()`; `withAuth` deniega por defecto a staff; una cita ajena responde 404 |
| Servicios | `service` (catálogo con precio) + `staff_service` (duración opcional, sin precio); la cita copia precio y duración al reservar |
| Foto | `bytea` en Postgres (soberanía: sin S3) |
| Migración | Aditiva y re-ejecutable; crea un profesional y un servicio «Cita» por defecto por organización |

## Pasos (slices)

Orden: 1 → 2 → {3, 4} → 5 → 6 → {7, 8} → 9. Cada slice cierra con
`pnpm typecheck && pnpm lint && pnpm build && pnpm test` y su parte del E2E en
verde. Con `AGENDA` apagada no se ve nada nuevo.

- [x] **1. Esquema, migración, constraint y backfill** (T001, T002, T004,
  T005, T010–T019). Tablas nuevas, `drizzle/0014_agenda_multi_profesional.sql`,
  siembra al registrarse, `isSlotConflict`. Commits `9368820`…`e2fe439`.
  Pendiente: T019 (E2E).
- [ ] **2. Roles, `requireActor`, scoping y gate de aislamiento** (T003,
  T006–T009, T020–T030, T063, T070, T071). `roles.ts`, `actor.ts`, `scope.ts`,
  `withAuth` con denegación por defecto, SSE filtrado, `GET /api/me`, checks E2E
  de aislamiento primero en rojo.
- [ ] **3. Equipo, catálogo y servicios por profesional (API)** (T031–T042,
  T088, T090, T091). Rutas `/api/staff*` y `/api/services*`; check «staff no
  cambia precios».
- [ ] **4. Foto y horario/bloqueos propios (API)** (T087, T089, T092–T097).
- [ ] **5. Disponibilidad y reservas por profesional y servicio** (T046–T062,
  T064–T069, T072, T075–T080). Opción «cualquier profesional», reasignación,
  E2E de concurrencia: dos reservas simultáneas solapadas, exactamente una
  exitosa.
- [ ] **6. Agente de WhatsApp** (T102–T120). Ofrece solo combinaciones válidas
  servicio + profesional y solo agenda horarios ofrecidos.
- [ ] **7. UI: calendario global** (T081–T084, T086). Columna por profesional,
  alta manual, reasignar.
- [ ] **8. UI: mi agenda, mi perfil y ajustes** (T043–T045, T073, T074, T085,
  T098–T101).
- [ ] **9. Cierre** (T121–T137). Guion `tests/e2e/us-agenda-multi.md`, CI,
  ADR-003, `CLAUDE.md`.

## Antes de retomar

1. `git restore .env.example` (está borrado en el working tree; no commitear
   ese borrado).
2. Crear un `.env.e2e` (gitignored) con base local, `APP_BASE_URL=http://localhost:3000`
   y mocks encendidos. **Nunca** correr tests ni E2E con el `.env` actual: apunta
   a producción.
3. Decisiones de producto a confirmar con el dueño antes de su slice:
   contraseña temporal o invitación (slice 3), moneda (slice 3) y si
   «cualquier profesional» es el valor por defecto (slice 6).
4. La rama `018-agenda-multi-profesional` es solo local: todavía no se hizo push.
