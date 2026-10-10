# Contrato de API — Agenda multi-profesional (feature 018)

Extiende `specs/015-motor-agenda-universal/contracts/agenda.md`. Toda esta
superficie existe SOLO con `AGENDA=on`; apagada, **cada ruta responde `404`**
(`agendaDisabledResponse`, sin cuerpo) — se evalúa **antes** que la
autenticación, como en la 015. No hay bandera nueva.

Sobre de error estándar del repo (`apiError` en `src/lib/api.ts`), **anidado**:
`{"error":{"code":"…","message":"…"}}`. En `409 slot_taken` /
`slot_not_offered`, `slots` viaja como campo **hermano** de `error` (igual que
la 015). Instantes **siempre UTC ISO-8601 con `Z`**; las etiquetas
(`label`, `dayLabel`) en la zona del negocio e incluyen el día en palabras.

## Reglas transversales

1. **Autenticación**: toda ruta de este documento exige sesión (`withAuth`);
   **ninguna es pública** (FR-008, lección del proyecto previo). Sin sesión →
   `401 unauthorized`.
2. **Rol** = `owner | reception | staff` (`member` legado ≡ `reception`). El
   actor sale de `requireActor()` en el servidor; **nada de lo que envíe el
   cliente** (ni `staffId` en query/body) amplía el alcance de un `staff`
   (FR-005): para un `staff`, `staffId` del request, si viene, debe coincidir
   con el propio o se responde `403 forbidden`; si se omite, se fuerza el propio.
3. **Deny-by-default**: `withAuth` responde `403 forbidden` a un `staff` en
   cualquier ruta que no esté listada aquí con `staff ✓` (bandeja,
   conversaciones, contactos, pipeline, Lab, plantillas, medios, ajustes…).
4. **Fuera de alcance por id → `404 not_found`** (no 403), sin cuerpo con datos
   de la cita. `403` es para superficies/acciones vedadas por rol.
5. **Cuenta `staff` sin perfil vinculado** → todas las lecturas devuelven vacío
   (`200` con listas vacías) y toda escritura `403 forbidden`. Con perfil
   **desactivado** → `403 account_disabled` en todo (incluido `/api/events`).
6. **Escrituras de `staff`** son siempre sobre sí mismo.
7. `Zod`: cuerpos con `.strict()` donde se indica; campo desconocido →
   `422 invalid_body`. Excepción deliberada: ver **R-403** en servicios.
8. **Códigos exactos** (verificados por el arnés E2E): crear → **201**;
   mover/cancelar/estado/actualizar → **200**; borrar sin cuerpo → **204**.

Leyenda de roles: **O** owner · **R** reception · **S** staff.

---

## Equipo y roles

### `GET /api/me`  · O R S
`200` → `{ "user": {id,name,email}, "role": "owner|reception|staff", "staffId": "st_…"|null, "agendaEnabled": true }`.
Lo usa el cliente para armar el nav; **no** es una fuente de autorización (el
servidor re-valida en cada ruta).

### `GET /api/staff`  · O R S
- O/R → `{ "staff": [StaffDTO…] }` todos (con `?includeInactive=1` incluye inactivos).
- S → `{ "staff": [StaffDTO propio] }` (o `[]` sin perfil).

`StaffDTO`: `{ id, displayName, jobTitle, bio, phone, color, position, active,
hasPhoto, photoUrl|null, weeklyHours|null, effectiveWeeklyHours, hasAccount,
accountEmail|null (solo O), needsReassignment (solo si inactivo con citas futuras) }`.
`phone`/`accountEmail` se ocultan a R en `accountEmail`. Nunca `memberId` ni
hashes.

### `POST /api/staff`  · O
Body (`.strict()`): `{ displayName, jobTitle?, bio?, phone?, color?, position?, weeklyHours? }`
→ **201** `{ staff: StaffDTO }`. `R`/`S` → `403`.

### `GET /api/staff/[id]`  · O R · S (solo el propio)
`200` `{ staff: StaffDTO, services: StaffServiceDTO[] }` ·
`404` si no existe / otra organización / (S) no es el propio.

### `PATCH /api/staff/[id]`  · O (todo) · S (propio, subconjunto)
- O: cualquier campo de `StaffDTO` editable + `active`.
  `active:false` sobre el último activo → `409 last_active_staff`.
- S (propio): solo `{ bio, phone, color }`. Cualquier otro campo
  (`displayName`, `jobTitle`, `active`, `position`) → **`403 forbidden`**.
- R → `403`.
`200` → `{ staff }`.

### `DELETE /api/staff/[id]`  · O
Solo sin citas ni cuenta → **204**. Con citas → `409 has_bookings`
("desactívalo"). Con cuenta vinculada → `409 has_account`.

### `POST /api/staff/[id]/account`  · O
Body: `{ email, name?, password }` (≥ 8; contraseña temporal, como
`/api/settings/team`). Crea usuario + `member{role:'staff'}` y vincula.
**201** `{ ok: true }` · `409 duplicate` (correo existente o el perfil ya tiene
cuenta) · `422`. Reutiliza `runInternalSignup`.

### `DELETE /api/staff/[id]/account`  · O
Desvincula y retira el `member` `staff` (el usuario conserva su historial pero
pierde acceso). **204**.

### Foto
- `PUT /api/staff/[id]/photo`  · O · S (propio) — cuerpo **crudo** con
  `content-type` (patrón de `PUT /api/settings/branding/favicon`, sin
  multipart). El tipo sale de los **bytes** (JPEG/PNG/WebP; SVG rechazado).
  `200` `{ photoUrl, version }` · `413 too_large` (> 512 KB) · `422 unsupported`
  · `422 empty`.
- `DELETE /api/staff/[id]/photo` · O · S (propio) → **204**.
- `GET /api/staff/[id]/photo` · O R · S (propio; el staff tampoco ve fotos
  ajenas) → `200` bytes con `Content-Type` real, `X-Content-Type-Options:
  nosniff`, `Cache-Control: private, max-age=86400`; `404` si no hay foto o
  fuera de alcance.

---

## Catálogo de servicios

`ServiceDTO`: `{ id, name, durationMinutes, priceCents, currency, jobTitle|null,
active, position }`.

### `GET /api/services`  · O R S
`200` `{ services: ServiceDTO[] }`. O/R: todos (`?includeInactive=1`). S:
**solo activos, solo lectura** (los necesita para marcar los suyos).

### `POST /api/services`  · O
Body (`.strict()`): `{ name, durationMinutes (5–600), priceCents (≥0), currency?, jobTitle?, position? }`
→ **201** `{ service }`. R/S → `403`.

### `PATCH /api/services/[id]`  · O
Cualquier subconjunto, incl. `active`. `200`. R/S → `403`.

### `DELETE /api/services/[id]`  · O
**204**; con citas → `409 has_bookings`.

> **R-403 (FR-013)**: en estas tres rutas, `S` y `R` reciben **`403
> forbidden`** *antes* de parsear el cuerpo: no depende de que Zod rechace el
> campo `priceCents`. El E2E envía `PATCH /api/services/{id}` con
> `{"priceCents": 1}` como staff y exige `403` **y** que el precio no cambió
> (releyendo con la sesión del dueño).

---

## Servicios que ofrece cada profesional

`StaffServiceDTO`: `{ serviceId, name, priceCents, currency (del catálogo,
solo lectura), catalogDurationMinutes, durationMinutes (propia|null),
effectiveDurationMinutes }`.

### `GET /api/staff/[id]/services`  · O R · S (propio)
`200` `{ services: StaffServiceDTO[] }` (los que ofrece, activos o no).

### `PUT /api/staff/[id]/services/[serviceId]`  · O · S (propio)
Marca que lo ofrece (idempotente). Body **`.strict()`**:
`{ durationMinutes?: number (5–600) | null }` — `null` ⇒ usar la del
catálogo. **No acepta ningún otro campo.** Para `S`, un cuerpo con cualquier
clave distinta de `durationMinutes` (p. ej. `priceCents`, `name`, `price`) →
**`403 forbidden`** (R-403), no `422`. Servicio inactivo/ajeno → `404`.
`200` `{ service: StaffServiceDTO }`. R → `403`.

### `DELETE /api/staff/[id]/services/[serviceId]`  · O · S (propio)
Deja de ofrecerlo → **204**. Las citas existentes conservan servicio, duración
y precio (FR-015).

### Cambio de duración con citas futuras
No reescribe nada: las citas agendadas conservan su `durationMinutes`.

---

## Horario semanal y bloqueos

### `GET /api/staff/[id]/hours`  · O R · S (propio)
`200` `{ weeklyHours: {…}|null, effectiveWeeklyHours: {…}, inheritsShopHours: boolean }`.

### `PUT /api/staff/[id]/hours`  · O · S (propio)
Body: `{ weeklyHours: { mon?: [{start:"09:00",end:"18:00"}], … } | null }`
(`null` ⇒ vuelve a heredar el del local). Misma normalización que
`PUT /api/calendar/settings`: intervalos inválidos se descartan. **200**. R →
`403` (recepción no edita horarios).

### Bloqueos — por `/api/bookings` con `kind:"block"` (ver abajo)
- Personal: `staffId` = el profesional (S solo el propio; O/R cualquiera).
- Del local: `staffId: null`  · O R únicamente (S → `403`).

---

## Citas

`BookingDTO` (extiende la 015): `{ id, kind, status, source, scheduledAtUtc,
endsAtUtc, durationMinutes, date, time, weekday, staff: {id,displayName,color}|null,
service: {id,name}|null, priceCents|null, currency|null, contact:
{id?,name,phone?}|null, conversationId?, connector, meetingLink, linkPending,
isTest, notes, legacyOverlap }`.
- Para **S**: `contact` es `{ name, phone|waIdentity }` **sin `id`**;
  `conversationId` se omite; las citas ajenas no aparecen.
- Bloqueo del local visto por S: `{ kind:"block", staff:null, notes }`.

### `GET /api/bookings?from=YYYY-MM-DD&to=YYYY-MM-DD&staffId=&jobTitle=&status=`  · O R S
Rango por días **en la zona del negocio** (se convierte a UTC en el servidor,
DST-seguro). Sin `from/to` → compatibilidad 015: últimas 200 (O/R) o las 200
propias (S). O/R pueden filtrar por `staffId` y `jobTitle`; S: el filtro se
fuerza a sí mismo (+ bloqueos del local). Inactivos incluidos solo con
`status` explícito. `200` `{ bookings: BookingDTO[] }` — siempre construido con
`scoped(…, bookingScope(actor), …)`.

### `GET /api/bookings/[id]`  · O R · S (solo propia)
`200` `{ booking: BookingDTO }` · `404` si no existe o fuera de alcance.

### `POST /api/bookings`  · O R S
Dos formas por `kind`:

```jsonc
{ "kind": "session",
  "staffId": "st_…",           // S: omitido o = propio. O/R: obligatorio
  "serviceId": "sv_…",         // obligatorio
  "contactId": "ct_…",         // obligatorio O/R. S: ver abajo
  "contact": { "name": "…", "phone": "…" },  // alternativa para S/walk-in
  "conversationId": "cv_…",    // opcional
  "startUtc": "2026-10-12T16:00:00.000Z",
  "notes": "…" }
{ "kind": "block", "staffId": "st_…"|null, "startUtc": "…",
  "durationMinutes": 60, "notes": "…" }
```

- **201** `{ booking: {id}, bookingId, meetingLink, linkPending, label }`
  (mismo sobre que la 015) tomando la duración efectiva del profesional y el
  precio del catálogo **copiados** al crear (FR-015).
- Validaciones (FR-023, todas `409`/`422` con código estable):
  `422 invalid_body`; `422 service_not_offered` (el profesional no ofrece el
  servicio o está inactivo); `409 slot_taken` (fuera de horario efectivo, choca
  con bloqueo, o `23P01`) **con `slots` frescos** del mismo profesional y
  servicio.
- **`23P01` (exclusion_violation) → `409 slot_taken`** igual que `23505`
  (research D2). Dos POST concurrentes solapados para el mismo profesional:
  exactamente uno **201**, el otro **409** (SC-001).
- **S**: `staffId` forzado al propio (otro → `403`); solo servicios que él
  ofrece; el cliente se identifica con `contactId` de un contacto **ya
  vinculado a sus citas** o con `contact{name,phone}` para alta rápida
  (se crea/une el contacto por `identity.ts`; el staff no obtiene acceso a la
  ficha del contacto). **SUPUESTO**: el alta rápida reutiliza
  `src/server/inbox/identity.ts`; confirmar en la Slice 6.
- Bloqueos del local (`staffId:null`) crean una cita-bloque; si hay citas
  dentro del rango, **201** con `conflicts: [{bookingId, staffId, label}]`
  (no se cancelan; research D4).

### `PATCH /api/bookings/[id]`  · O R · S (propia)
`action` discriminada (como la 015, con una nueva):

| action | Body | Quién | Notas |
|---|---|---|---|
| `reschedule` | `{ startUtc }` | O R · S propia | 200 `{ok,label}`; `409 slot_taken` |
| `reassign` | `{ staffId, keepDuration?: true }` | O R | valida servicio ofrecido, activo, horario, bloqueos; `23P01`→409; S → `403` |
| `cancel` | — | O R · S propia | idempotente, 200 |
| `status` | `{ status: "realizada"\|"no_show" }` | O R · S propia | 200 |
| `retry_link` | — | O R · S propia | 200 |

Ajena/inexistente → `404`. `reassign` por S → `403`.

---

## Calendario global (día / semana)

### `GET /api/calendar/board?from=YYYY-MM-DD&days=1|7&staffId=&jobTitle=`  · O R
(S → `403`: FR-007.) `200`:

```jsonc
{ "timezone": "America/Mexico_City",
  "range": { "from": "2026-10-12", "to": "2026-10-18" },
  "columns": [
    { "staff": StaffDTO(resumen),
      "hours": { "2026-10-12": [{"start":"09:00","end":"18:00"}], … },   // efectivo
      "bookings": [BookingDTO…],            // sesiones y bloqueos personales
      "needsReassignment": [BookingDTO…] }  // si el profesional está inactivo
  ],
  "shopBlocks": [BookingDTO…] }             // bloqueos de todo el local
```

Columnas = profesionales **activos** filtrados (los inactivos solo si tienen
citas futuras que reasignar). Se actualiza por SSE `booking.updated` + refetch.

### `GET /api/calendar/availability?serviceId=&staffId=<id|any>&from=&to=`  · O R S
Disponibilidad de **operador** (no registra oferta). `staffId=any` fusiona
candidatos (research D10) y devuelve `staffId` asignado por hueco. S: `staffId`
forzado al propio.
`200` → `{ slots: [{ startUtc, endUtc, label, dayIso, dayLabel, time, staffId,
staffName, serviceId, durationMinutes, priceCents }] }`.
**Compatibilidad 015**: sin `serviceId`, si la organización tiene exactamente
un servicio activo y un profesional activo → se usan (respuesta idéntica a la
de hoy más campos extra); si no → `422 service_required` con
`{ services: [...] }`.

### `GET|PUT /api/calendar/settings`  · O (PUT) · O R (GET)
Sin cambios de forma (015). `R` y `S`: `PUT` → `403`; `GET` S → `403`.

---

## Eventos en tiempo real

### `GET /api/events`  · O R S
Mismo stream SSE (mismos headers, heartbeat `: ping` ~25 s). Filtro **en el
servidor** por rol (research D9): O/R todo; **S solo `booking.updated`** con
`staffId` propio o `scope:"shop"`. Payload nuevo:
`booking.updated → { bookingId, staffId: string|null, scope: "own"|"shop"|"staff" }`
(sin datos de cliente). Cuenta `staff` sin perfil → stream abierto sin eventos.

---

## Superficies que NO existen y la regla para el futuro

No hay exportación ni búsqueda de citas hoy. Si se agregan, DEBEN leer
`booking` a través de `bookingScope(actor)` (el test de vigilancia falla si un
archivo fuera de `src/server/agenda/` consulta `schema.booking` directamente).

## Matriz resumen (alcance E2E de aislamiento)

| Intento (como **staff A**) | Resultado esperado |
|---|---|
| `GET /api/bookings` | solo citas de A + bloqueos del local |
| `GET /api/bookings/{cita de B}` | `404`, sin datos |
| `PATCH /api/bookings/{cita de B}` (cancel/reschedule/status) | `404`, la cita no cambia |
| `POST /api/bookings` con `staffId` de B | `403` |
| `POST /api/bookings` con servicio que A no ofrece | `422 service_not_offered` |
| `PATCH /api/services/{id}` `{priceCents}` | `403`; precio intacto |
| `PUT /api/staff/{A}/services/{id}` `{priceCents}` | `403` |
| `PATCH /api/staff/{B}` | `403`/`404`, B intacto |
| `GET /api/calendar/board` | `403` |
| `GET /api/conversations`, `/api/contacts`, `/api/pipeline/board`, `/api/lab/runs` | `403` |
| `GET /api/events` | solo `booking.updated` propios |
| Dos `POST /api/bookings` simultáneos solapados (mismo profesional) | exactamente un `201`, un `409 slot_taken` |
| Dos `POST` simultáneos mismo horario, profesionales distintos | dos `201` |
