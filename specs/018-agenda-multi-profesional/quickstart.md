# Quickstart — probar la agenda multi-profesional de punta a punta

Feature: `018-agenda-multi-profesional`. Cómo se ejercita TODO el alcance en
localhost con los mocks, sin proveedores reales (Constitución IX: local
primero). Parte de `specs/015-motor-agenda-universal/quickstart.md`; aquí solo
lo que cambia.

## 1. Entorno

```bash
# .env — además de lo habitual (DATABASE_URL, BETTER_AUTH_SECRET, ENCRYPTION_KEY…)
AGENDA=on                                   # la bandera existente: NO hay una nueva
CHANNELS=whatsapp
WA_MOCK_ENABLED=true
META_GRAPH_BASE_URL=http://localhost:3000/api/dev/wa-mock/graph
OPENROUTER_BASE_URL=http://localhost:3000/api/dev/ai-mock
BOT_API_KEY=una-llave-de-al-menos-16-chars
```

Base de datos: PostgreSQL ≥ 13 con la extensión `btree_gist` disponible
(la imagen `postgres:16-alpine` de `docker-compose*.yml` la trae). Verifica
antes de migrar:

```bash
psql "$DATABASE_URL" -c "select * from pg_available_extensions where name='btree_gist';"
```

Si la fila no aparece o el rol no puede crear extensiones, habilítala una vez
con un superusuario (`CREATE EXTENSION btree_gist;`); la migración
`drizzle/0014_agenda_multi_profesional.sql` falla en voz alta si no puede — no
arranca sin la garantía de no-solapamiento.

```bash
pnpm db:migrate          # dev; en contenedor migra solo al arrancar (scripts/migrate.mjs)
pnpm dev
```

## 2. La migración sobre una instancia con datos (SC-006)

1. Con una BD que ya tenga citas de la 015 (o el seed demo), aplica `0014`.
2. Comprobaciones directas:
   ```sql
   select count(*) from staff;                                   -- 1 por organización
   select count(*) from service;                                 -- 1 ("Cita")
   select count(*) from booking where kind='session' and (staff_id is null or service_id is null);  -- 0
   select count(*) from booking where legacy_overlap;            -- 0 salvo datos legados que ya se pisaban
   ```
3. Re-ejecuta el SQL de la migración (o `pnpm db:migrate` otra vez): no cambia
   ningún conteo (re-ejecutable).
4. `pnpm test:e2e` (la sección de 015) sigue verde **sin tocar nada**: una
   instancia de un profesional se comporta igual que hoy.

## 3. Sembrar dos profesionales y sus cuentas

Como **dueño** (sesión del primer registro), por la API (o por Ajustes →
Equipo cuando exista la UI):

```bash
# profesionales
POST /api/staff {"displayName":"Juan","jobTitle":"barbero","color":"#0d5bff"}      → st_A
POST /api/staff {"displayName":"Ana","jobTitle":"colorista","color":"#e11d48"}     → st_B

# catálogo (precio único) y qué hace cada uno
POST /api/services {"name":"Corte clásico","durationMinutes":30,"priceCents":15000}  → sv_1
POST /api/services {"name":"Tinte","durationMinutes":90,"priceCents":60000,"jobTitle":"colorista"} → sv_2
PUT  /api/staff/st_A/services/sv_1  {"durationMinutes":45}
PUT  /api/staff/st_B/services/sv_2  {}

# cuentas con rol staff (contraseña temporal; no hay email en el núcleo)
POST /api/staff/st_A/account {"email":"juan@style.test","password":"Temporal#123"}
POST /api/staff/st_B/account {"email":"ana@style.test","password":"Temporal#123"}
```

El arnés E2E hace exactamente esto en su sección de aislamiento
(`aislamientoChecks()`), con un helper `api()` que acepta un *jar* de cookies
por usuario (hoy `scripts/e2e-selftest.mjs` usa una cookie global).

## 4. Recorrido manual (UI)

| Quién | Qué | Resultado |
|---|---|---|
| owner | Ajustes → Equipo/Servicios: crea profesionales y catálogo | aparecen columnas en `/calendar` |
| reception | `/calendar`: 3 citas a las 10:00 con 3 profesionales | las tres lado a lado, ninguna rechazada (US4) |
| reception | cita de 60 min a las 10:00 con Juan; otra de 30 min a 10:15 con Juan | la segunda: «horario ocupado» (US2) |
| staff Juan | login → `/my-agenda` | ve solo lo suyo en un paso (SC-004); `/calendar`, `/inbox`, `/settings` → sin acceso |
| staff Juan | su perfil: sube foto, marca servicios, pone 45 min a «Corte» | duración efectiva 45; precio intacto |
| Laboratorio | persona «corte con Juan» y «el que esté libre» | citas `is_test` con profesional y duración correctos (US6) |

## 5. El gate de aislamiento (FR-036) — TDD: primero rojo

`pnpm test:e2e` conduce `scripts/e2e-selftest.mjs`. La sección nueva
`aislamientoChecks()` se escribe **antes** que el código que la hace pasar y
se ve fallar (RED) en cada slice; nunca se mergea una slice con el gate rojo.

Qué prueba (todo contra la app viva, no mocks unitarios):

1. **Lectura cruzada denegada**: staff A pide `GET /api/bookings/{cita de B}`
   → `404` sin datos; su `GET /api/bookings` no contiene ids de B; su SSE no
   emite eventos de B ni de bandeja.
2. **Escritura cruzada denegada**: staff A `PATCH` (cancel/reschedule/status)
   y `POST` a nombre de B → `404`/`403`; releyendo como dueño la cita de B no
   cambió.
3. **Staff no cambia precios**: `PATCH /api/services/{id}` y
   `PUT /api/staff/{A}/services/{id}` con `priceCents` → `403`; precio igual
   releído como dueño; además `ServiceDTO` ya no tiene vía alguna de precio
   por profesional.
4. **Superficies vedadas** (deny-by-default): staff → `403` en
   `/api/conversations`, `/api/contacts`, `/api/pipeline/board`,
   `/api/lab/runs`, `/api/calendar/board`, `/api/settings/team`; y mutaciones
   de `/api/auth/organization/*` fallan (research D5, supuesto 2).
5. **Cuenta sin perfil** (`member.role='staff'` sin `staff.member_id`): todas
   las lecturas vacías; **cuenta de perfil desactivado**: `403 account_disabled`.
6. **Concurrencia por API**: 100 pares de `POST /api/bookings` solapados
   para el mismo profesional, disparados con `Promise.all`, en 100 horarios
   distintos → en cada par exactamente un `201` y un `409 slot_taken` (SC-001).
   Pares a la misma hora con profesionales distintos → dos `201`.
7. **Concurrencia directa a la BD** (sin pasar por el servicio): con
   `postgres` (dependencia ya presente) dos `INSERT` simultáneos solapados del
   mismo `staff_id` → uno falla con SQLSTATE `23P01`. Esto prueba que la
   garantía vive en la base y no "en el código" (lección del proyecto previo).
8. **Sesión vs. bloqueo del local en carrera** (research D4): un
   `POST` de bloqueo del local y un `POST` de sesión dentro del rango,
   simultáneos → el resultado final nunca deja una sesión *creada después* del
   bloqueo dentro de su rango (o el bloqueo lista la sesión en `conflicts`).
9. **Bandera apagada** (rama del arnés ya existente): `AGENDA` ausente →
   `404` en todas las rutas nuevas (`/api/staff`, `/api/services`,
   `/api/calendar/board`, `/api/me` informa `agendaEnabled:false`), sin
   pantallas `/calendar` ni `/my-agenda`.

Además, tests unitarios (Vitest, `pnpm test`): `effectiveHours` (intersección y
recorte al local), `effectiveDuration`, rejilla de candidatos con duración
variable y DST, equivalencia con la disponibilidad de la 015 (un
profesional/un servicio), `bookingScope`/`assertCanWriteBooking` por rol,
`normalizeRole`, mapeo `23P01 → slot_taken`, escogencia de «cualquiera» (reparto
y desempate), test de vigilancia (`schema.booking` solo desde
`src/server/agenda/`).

## 6. Gate técnico y de comportamiento (Definición de Hecho)

```bash
pnpm typecheck && pnpm lint && pnpm build && pnpm test
pnpm test:e2e            # app viva + mocks, AGENDA=on  Y  con AGENDA ausente (matriz de CI)
```

## 7. Lista de verificación por criterio de éxito

| SC | Cómo se verifica | Dónde |
|---|---|---|
| **SC-001** 100 pares → 0 dobles | check 6 + 7 del gate | `aislamientoChecks()` |
| **SC-002** 100 % rechazos del aislamiento | checks 1–5 | `aislamientoChecks()` |
| **SC-003** recepción agenda < 30 s | Playwright cronometrado: abrir `/calendar` → clic en columna/hora → servicio → cliente → guardar (≤ 30 s en la sesión conducida) | `tests/e2e/us-agenda-multi.md` (guion) + Playwright |
| **SC-004** staff ve su día en un paso | login staff aterriza directo en `/my-agenda` (redirect del post-login por rol) | Playwright |
| **SC-005** Lab ≥ 95 % | corridas de las personas nuevas (`ai-mock` determinista + una pasada con modelo real marcada **pendiente de verificación humana** si no hay token) | Laboratorio |
| **SC-006** instancia de 1 profesional sin cambios | sección de agenda 015 de `pnpm test:e2e` verde tras `0014` + test unitario de equivalencia | paso 2 de este documento |
| **SC-007** cita del agente visible < 5 s | conversación `wa-mock` → `book_slot`; medir hasta que `GET /api/calendar/board` la contiene tras el evento SSE `booking.updated` | E2E + Playwright |

> Todo lo que dependa de juicio visual (columnas del calendario, foto
> recortada, colores) queda marcado **pendiente de verificación humana**
> (Constitución V) y se acompaña de capturas de Playwright.
