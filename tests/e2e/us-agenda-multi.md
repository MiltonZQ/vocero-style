# E2E — Agenda multi-profesional (018)

Guion de comportamiento observable. La app ya está arriba. El arnés de API
local es `pnpm test:e2e:local` (carga `.env.e2e`). El de pantalla es
`pnpm test:e2e:agenda-ui`.

**`pnpm test:e2e` no es este guion**: ese script carga `.env`.

**Preparación** (nombres de variable, no valores): la app en `APP_BASE_URL`
(por defecto `http://localhost:3000`), base migrada con `0014`, y los mocks
que ya usa el arnés:

- `AGENDA` — ausente en la mitad apagada; `on` en la encendida
- `WA_MOCK_ENABLED`
- `META_GRAPH_BASE_URL` apuntando al wa-mock
- `OPENROUTER_BASE_URL` apuntando al ai-mock
- `BOT_API_KEY`

`pnpm test:e2e:agenda-ui` no lee `.env`. Asume la app ya corriendo. No la
arranca.

---

## US1 — Equipo y catálogo

1. El dueño crea profesionales, servicios y la cuenta de un profesional
   (contraseña temporal, sin correo).
   → `aislamientoChecks()` → `us1EquipoCatalogo()`, con `AGENDA=on`.
   Recorrido manual: quickstart §4, fila del owner.
2. Staff y recepción no cambian el precio del catálogo (`PATCH
   /api/services/:id` → 403). El staff tampoco manda `priceCents` en
   `PUT /api/staff/:id/services/:serviceId` (403).
   → check (3) de `aislamientoChecks()`.

## US2 — Dos citas del mismo profesional no se pisan

1. Cien pares simultáneos de `POST /api/bookings` sobre el mismo profesional:
   en cada par un 201 y un 409.
   → check (6).
2. Dos `INSERT` directos solapados: uno falla con `23P01`.
   → check (7). El constraint es `booking_staff_no_overlap`.
3. Una sesión y un bloqueo de todo el local, a la vez, no dejan la sesión
   dentro del bloqueo.
   → check (8).

El caso de la UI (60 min y otra a los 15 min con la misma persona) está en
el quickstart §4, fila de recepción.

## US3 — Cada profesional solo lo suyo

1. Lectura cruzada: la cita del otro responde 404 y no sale en su lista.
   → check (1).
2. Escritura cruzada: cancelar, mover o cambiar el estado de la cita del otro
   no la modifica.
   → check (2). Solo corre con `AGENDA=on`.
3. Superficies vedadas: bandeja, contactos, tablero, Laboratorio, calendario
   global y equipo responden 403 al staff.
   → check (4).
4. Cuenta `staff` sin perfil: lecturas vacías. Perfil desactivado:
   `403 account_disabled`.
   → check (5).

Al cerrar, `aislamientoChecks()` exige que hayan corrido (1)–(9) si la
bandera está encendida, y (1), (4), (5) y (9) si está apagada. Si falta
alguna, falla `aislamiento ran-set`.

## US4 — Calendario de todos

Recepción abre `/calendar` y deja una cita presencial. El tiempo se mide
desde que el calendario se puede usar hasta que la cita se ve, y tiene que
caber en 30 s (SC-003).

→ `pnpm test:e2e:agenda-ui`. Recorrido manual: quickstart §4, filas de
recepción.

## US5 — Perfil, foto y horario

1. Foto, horario propio y duración de 45 min en el arnés de API.
   → `aislamientoChecks()` → `us5FotoYHorario()`, con `AGENDA=on`.
2. La pantalla de perfil y la zona de la foto se capturan en
   `/tmp/slice9-perfil.png` y `/tmp/slice9-foto.png`.
   → `pnpm test:e2e:agenda-ui`. Quedan **pendiente de verificación humana**:
   el guion no pulsa subir foto, la contraseña de un solo uso ni desactivar.
   Recorrido manual: quickstart §4, fila del perfil.

`weeklyHours` vacío hereda el horario del local. Ver
[docs/agenda-multi-profesional.md](../../docs/agenda-multi-profesional.md).

## US6 — El agente asigna profesional

1. Por la API, con wa-mock y ai-mock: ofrecer huecos y reservar el primero,
   con profesional nombrado y con «cualquiera».
   → `agenteMultiChecks()`, al final de `agendaChecks()` cuando `AGENDA=on`.
   Con la bandera apagada esa función no corre: el prompt no lleva
   `offer_slots` ni `book_slot`.
2. En pantalla (SC-007): la cita del agente aparece en `/calendar` en menos
   de 5 s desde que ya existe, por el SSE `booking.updated`.
   → `pnpm test:e2e:agenda-ui`. Si el mock no logra reservar, ese paso sale
   distinto de cero y dice por qué.

El login del profesional aterriza en `/my-agenda` (SC-004), en el mismo
script de pantalla. Caer en `/inbox` o en `/calendar` es fallo.

## Bandera apagada

Check (9) de `aislamientoChecks()`: `GET /api/staff`, `/api/services` y
`/api/calendar/board` responden 404; `GET /api/me` sigue en 200 con
`agendaEnabled: false`. Como dueño ya autenticado, `/calendar` y
`/my-agenda` responden 404. Una petición sin sesión que redirige al login
no cuenta como esa prueba.

Los checks (2), (3) y (6)–(8) solo existen con la bandera encendida. El
cierre no los exige cuando está apagada.
