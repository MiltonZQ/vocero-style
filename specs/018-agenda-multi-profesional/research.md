# Fase 0 — Investigación y decisiones

Feature: `018-agenda-multi-profesional` · Fecha: 2026-10-09

Cada decisión con su evidencia. Fuentes: el código real de la rama (rutas y
archivos citados), la feature 015 (motor que se extiende), el `spec.md` de esta
feature y dos verificaciones ejecutadas: un prototipo del constraint de
exclusión contra PostgreSQL 16 local (D1/D2) y la documentación de Better Auth
1.6.23 vía Context7 (D5). Lo que no se pudo verificar queda marcado como
**SUPUESTO** y listado al final.

Hallazgos del código que condicionan todo el diseño:

- `booking.scheduled_at` es `timestamp` **sin zona** (instante UTC "desnudo",
  `src/lib/db/schema.ts`). Eso simplifica D1: no hay `timestamptz`.
- El único guardián de no-solapamiento hoy es `booking_org_active_slot_uq`,
  un UNIQUE parcial sobre `(organization_id, scheduled_at)`: solo detecta el
  **mismo instante exacto**. No cubre solapamiento parcial ni paralelismo entre
  profesionales (`src/lib/db/schema.ts`, índice de `booking`).
- Hoy existen solo los roles `owner` (alta de la primera cuenta,
  `src/server/auth/on-signup.ts`) y `member` (cuentas de equipo,
  `src/app/api/settings/team/route.ts`). **Cualquier** `member` ve todo el CRM
  (bandeja, contactos, Laboratorio). Casi ninguna ruta mira el rol: la única
  comprobación de rol de las rutas de equipo/marca es `role !== "owner"`.
- ~40 route handlers pasan por `withAuth` (`src/lib/api.ts`) y las pantallas
  de `src/app/(app)/**` por `getSessionOrNull`/`requireSession`; `/api/events`
  usa `requireSession` directo. No hay `middleware.ts`.
- Compose Ruta B **no monta ningún volumen para `/data/media`** (el
  `Dockerfile` crea el directorio, pero `docker-compose.yml` solo declara
  `vocero_pg` y los de Caddy): los adjuntos en disco viven en el contenedor y
  se pierden al recrearlo, salvo que el operador monte uno a mano (Coolify
  Ruta A lo documenta en `.env.example`). Condiciona D7.
- No existe ruta de exportación ni de búsqueda de citas hoy (`rg` sobre
  `src/app/api`). FR-005 las nombra: se resuelve como regla para cualquier
  superficie futura (D6), no como código.

---

## D1. Representación del fin de la cita: columna generada `ends_at` (STORED)

**Decisión**: agregar a `booking` la columna
`ends_at timestamp GENERATED ALWAYS AS (scheduled_at + duration_minutes * interval '1 minute') STORED`
y usar `tsrange(scheduled_at, ends_at, '[)')` en el constraint.

**Rationale** — inmutabilidad, que era la preocupación del brief:

- Una expresión de índice/constraint y una columna generada exigen funciones
  `IMMUTABLE`. `timestamp + interval` **sí** es inmutable (la variante
  `timestamptz + interval` es `STABLE` porque depende de `TimeZone`; por eso
  importa que `scheduled_at` sea `timestamp` sin zona). `int * interval`
  (`mul_d_interval`) también lo es. `tsrange` sobre `timestamp` es inmutable
  (`tstzrange` sobre `timestamptz` también, pero no lo necesitamos).
- **Verificado** en PostgreSQL 16 (prototipo del 2026-10-09): la columna
  generada se crea sobre una tabla con una fila previa (rellena `ends_at`),
  el `EXCLUDE` se acepta, `10:15–10:45` choca con `10:00–10:30`, **citas
  adyacentes (`10:00–10:30` y `10:30–11:00`) conviven** (rango semiabierto
  `[)`), y el choque devuelve SQLSTATE `23P01`.
- Columna almacenada frente a expresión inline: la columna es legible por
  Drizzle (`.generatedAlwaysAs`), por el tablero y por consultas de
  disponibilidad sin repetir la fórmula, y el índice GiST se construye sobre
  columnas simples. Costo: 8 bytes por fila y reescritura de tabla al añadirla
  (aceptable: tabla pequeña por instancia; documentado en data-model).
- DST: ambos extremos están en UTC, así que el rango es inmune a los cambios
  de horario. La zona del negocio solo interviene al calcular candidatos.

**Alternativas**: (a) expresión inline `tsrange(scheduled_at, scheduled_at +
make_interval(mins => duration_minutes))` — funciona (también es inmutable)
pero obliga a repetir la fórmula en cada consulta y en el tablero; (b)
convertir `scheduled_at` a `timestamptz` — migración destructiva sobre todas
las citas y rompe `toISOString()` simétrico del código; rechazado; (c) rango
guardado a mano (`tsrange` como columna) — dos fuentes de verdad que pueden
desincronizarse; rechazado.

**Nota**: `buffer_minutes` NO entra al constraint (es política de rejilla de
candidatos, no una propiedad de la cita): el constraint protege lo físico
(dos citas del mismo profesional no se pisan); el aire entre citas lo aplica la
disponibilidad (D13).

---

## D2. El constraint de exclusión, `btree_gist` y la mecánica de migración

**Decisión**: una migración **escrita a mano** `drizzle/0014_agenda_multi_profesional.sql`
(siguiente número libre; la última es `0013_nombre_del_contacto`) con, en orden:

1. `CREATE EXTENSION IF NOT EXISTS btree_gist;`
2. tablas nuevas y columnas nuevas de `booking` (`staff_id`, `service_id`,
   `price_cents`, `currency`, `ends_at`, `legacy_overlap`);
3. backfill (D8);
4. `ALTER TABLE booking ADD CONSTRAINT booking_staff_no_overlap EXCLUDE USING gist (staff_id WITH =, tsrange(scheduled_at, ends_at, '[)') WITH &&) WHERE (kind = 'session' AND status IN ('agendada','realizada') AND NOT is_test AND NOT legacy_overlap)` dentro de un `DO $$ … IF NOT EXISTS (pg_constraint) … $$` (re-ejecutable);
5. `DROP INDEX IF EXISTS booking_org_active_slot_uq;` (D3);
6. `CHECK` de integridad de sesiones (staff y servicio obligatorios) validado
   tras el backfill.

**Cómo corre esto en el contenedor** (verificado leyendo
`scripts/migrate.mjs` y `Dockerfile`): `CMD ["sh","-c","node migrate.mjs &&
node server.js"]` ejecuta el migrador de Drizzle (`drizzle-orm/postgres-js/migrator`)
sobre `drizzle/` al **arrancar**; el migrador aplica el SQL de cada archivo
separado por `--> statement-breakpoint` y registra el hash en
`__drizzle_migrations` según `drizzle/meta/_journal.json`. Precedente exacto de
SQL editado a mano: `0009_motor_agenda.sql` (DO-blocks para FKs,
`IF NOT EXISTS`). Por tanto: se genera la parte estructural con
`pnpm db:generate` (para que el snapshot y el `_journal.json` queden
coherentes) y se **edita a mano** el `.sql` resultante añadiendo
extensión, backfill, exclusión y drop del índice viejo. Drizzle no sabe
expresar `EXCLUDE` ni `CREATE EXTENSION`; el esquema TS (`schema.ts`) declara
las columnas pero el constraint vive solo en el SQL, con un comentario que lo
dice. Riesgo conocido: un futuro `db:generate` no lo ve ni lo borra (no lo
modela) — se documenta en el comentario del esquema.

**`btree_gist` requiere privilegios.** `postgres:16-alpine` (imagen de
`docker-compose.yml`) incluye las extensiones contrib, y el usuario de compose
es superusuario. En PG ≥ 13 `btree_gist` está marcada *trusted* (la puede
instalar un rol con `CREATE` sobre la base) — **SUPUESTO a confirmar en la
Slice 1** contra la imagen real; si una plataforma gestionada (Coolify con BD
externa) lo impide, la migración falla de forma ruidosa al arrancar, que es
preferible a una garantía silenciosamente ausente. `quickstart.md` y
`docs/` indican cómo habilitar la extensión a mano en ese caso.

**Datos legados que ya se solapen.** El índice viejo solo impedía el mismo
instante; si un negocio cambió `slot_minutes` con citas futuras, pueden existir
citas activas del mismo (único) profesional que se pisan parcialmente, y
`ADD CONSTRAINT … EXCLUDE` **fallaría** sobre esos datos (un `EXCLUDE` no
admite `NOT VALID`). Decisión: columna `booking.legacy_overlap boolean NOT NULL
DEFAULT false`; la migración marca `true` en las filas legadas activas que
solapan con otra anterior (por `(scheduled_at, id)`) y el constraint las
excluye con `AND NOT legacy_overlap`. Siguen ocupando agenda en la
disponibilidad por código y se ven señaladas para el dueño (la UI las marca);
cualquier reprogramación las normaliza (`legacy_overlap := false`, y entonces
el constraint sí aplica). Solo la migración puede ponerla en `true`.

**Mapeo de error**: el servicio traduce `23P01` (`exclusion_violation`) a
`BookingError("slot_taken")` igual que hoy traduce `23505`; el código ya
desenvuelve `err.cause.code` porque Drizzle envuelve el error del driver
(`isUniqueViolation` en `src/server/agenda/service.ts`). Se renombra el helper
a `isSlotConflict(err)` que acepta `23505` y `23P01`.

**Alternativas**: (a) `pg_advisory_xact_lock(staff)` + chequeo en código —
exactamente el "chequeo de choque solo en código" que el spec prohíbe;
(b) `SERIALIZABLE` — oculto en cada ruta, no cubre un `INSERT` por otra vía;
(c) trigger — igual de válido pero reimplementa lo que `EXCLUDE` hace nativo y
con índice; (d) abortar la migración si hay solapes legados — deja el
contenedor en bucle de reinicio en producción; rechazado.

---

## D3. Reemplazo del índice único viejo

**Decisión**: `DROP INDEX IF EXISTS booking_org_active_slot_uq` en la misma
migración, **después** de crear el constraint de exclusión (misma
transacción: el migrador de Drizzle aplica los pendientes en una transacción,
por lo que no existe ventana sin guardián), y se quita su definición de
`schema.ts`.

**Rationale**: el índice viejo es `(organization_id, scheduled_at)` — prohíbe
que dos profesionales distintos tengan cita a la misma hora, contradiciendo la
historia 4. No se puede conservar.

**Pérdida de cobertura a revisar**: el índice viejo también cubría
*sesión vs. bloqueo* en el mismo instante exacto (los bloqueos eran filas
`kind='block'` en el mismo índice). Eso lo absorbe D4.

**Alternativa**: conservarlo como `(organization_id, staff_id, scheduled_at)` —
redundante frente al `EXCLUDE` que ya cubre el mismo instante; rechazado
(dos mecanismos para lo mismo).

---

## D4. Bloqueos (`kind='block'`): personales y de todo el local

**Decisión**: los bloqueos siguen siendo filas de `booking` (`kind='block'`,
`contact_id` NULL) con `staff_id` = el profesional (bloqueo personal) o
`NULL` (bloqueo de **todo el local**). El constraint de exclusión se
restringe a `kind='session'` — es decir, **garantiza en la base la regla
central (sesión vs. sesión del mismo profesional)**. La interacción
sesión↔bloqueo se hace cumplir así:

1. La **disponibilidad** (la fuente de las ofertas del agente y del panel)
   resta bloqueos personales del profesional y bloqueos del local.
2. Todo *write path* que crea o mueve una **sesión**, y todo que crea un
   **bloqueo**, corre dentro de una transacción que toma un advisory lock a
   nivel de organización: `pg_advisory_xact_lock_shared(hash(org))` para
   sesiones (no se bloquean entre sí: el paralelismo de sesiones se conserva) y
   `pg_advisory_xact_lock(hash(org))` (exclusivo) para crear un bloqueo. Con el
   lock, "validar contra bloqueos y luego insertar" es atómico respecto de
   cualquier alta de bloqueo concurrente.

**Por qué no el constraint también para bloqueos**:

- Un bloqueo del local (`staff_id NULL`) no puede participar de un
  `EXCLUDE (staff_id WITH =)` (NULL no es igual a nada).
- *Fan-out* (replicar el bloqueo del local en una fila por profesional): lo
  cubriría el constraint, pero un profesional dado de alta después no queda
  bloqueado, hay que mantener un `group_id` y editar/borrar N filas.
  Rechazado por más superficie de error que de garantía.
- Bloqueos personales dentro del constraint: dos bloqueos propios solapados
  (vacaciones + comida) se rechazarían como "ocupado", un falso conflicto que
  el dueño no entendería. Un bloqueo no es una cita que pueda "plantar a un
  cliente"; su carrera pierde un hueco, no dignidad.

**Honestidad sobre el límite**: esta es la **única** regla cuya atomicidad
descansa en un lock de aplicación y no en un constraint. Es aceptable porque
(a) los locks viven en la base (`pg_advisory_xact_*`), no en memoria del
proceso, (b) la regla central del spec (FR-020: dos citas del mismo
profesional) sí es un constraint, y (c) el E2E de aislamiento incluye una
carrera *sesión vs. bloqueo del local* (ver quickstart). Registrado en
Complexity Tracking.

**Crear un bloqueo sobre citas existentes**: se permite (el local puede cerrar
de imprevisto) y la respuesta lista las citas afectadas (`conflicts`) para que
el dueño las reasigne o cancele; no se cancelan solas. Un profesional solo
puede crear bloqueos personales propios; el bloqueo del local es de
dueño/recepción.

---

## D5. Almacenamiento del rol de acceso: `member.role` como texto, sin plugin de AC

**Decisión**: `member.role` (`text NOT NULL DEFAULT 'member'`, ya existe) pasa
a tomar los valores `owner | reception | staff`. Se valida con un enum Zod
propio (`src/lib/auth/roles.ts`). **No** se adopta `createAccessControl` /
`roles` del plugin `organization`.

**Evidencia** (Context7, docs de `better-auth@1.6.23`; versión instalada en
`pnpm-lock.yaml`: `better-auth@1.6.23`): el plugin de organización admite roles
personalizados mediante `organization({ ac, roles })` y control de acceso
dinámico, pero eso gobierna **los endpoints del propio plugin** (crear
roles, invitar, actualizar miembros). Este repo no usa esos endpoints: crea la
cuenta con `auth.api.signUpEmail` dentro de `runInternalSignup` y hace el
`insert` del `member` directo (`src/app/api/settings/team/route.ts`). La
autorización del dominio (citas, catálogo) es del dominio.

**Rationale**: (1) cero cambios de esquema de Better Auth; (2) un único
punto de verdad (`member.role` ya es lo que lee `resolveMembership`); (3) los
permisos de este producto son propios del dominio (agenda), no de las
entidades del plugin.

**Compatibilidad**: el valor legado `member` (todas las cuentas de equipo
actuales) se interpreta como **`reception`** — el equivalente más cercano a lo
que hoy pueden hacer (operar todo salvo administración) — **sin reescribir
datos**: `normalizeRole("member") → "reception"`. El POST de equipo pasa a
aceptar `role: "reception" | "staff"` (default `reception`, comportamiento
actual).

**Riesgo a cerrar en la Slice 2 (SUPUESTO)**: el catch-all `/api/auth/*` de
Better Auth expone los endpoints del plugin de organización a cualquier sesión.
Con los roles por defecto del plugin, un rol desconocido (`staff`) no debería
tener permisos sobre ellos — **no verificado contra el código instalado**
(no hay `node_modules` en este árbol). La Slice 2 añade una prueba E2E: un
`staff` llamando mutaciones de `/api/auth/organization/*` (actualizar rol de
miembro, invitar) debe fallar; y un hook `before` en `src/lib/auth/index.ts`
que rechace esas rutas para `staff` como defensa en profundidad.

**Alternativas**: `ac`/`roles` del plugin (acoplar permisos de dominio a un
sistema diseñado para otros recursos; más superficie de migración); tabla
`user_role` propia (segunda fuente de verdad frente a `member.role`).

---

## D6. Autorización en el servidor: `requireActor()`, deny-by-default y `bookingScope`

**Decisión**:

- `src/lib/auth/actor.ts` exporta `requireActor()` →
  `{ userId, organizationId, role: "owner"|"reception"|"staff", staffId: string|null, memberId }`.
  Resuelve sesión (`requireSession`), normaliza el rol (D5) y, si es `staff`,
  busca su perfil: `staff.member_id = member.id AND staff.active`. Un `staff`
  sin perfil activo recibe `staffId = null` → **no ve nada** (FR-006); con
  perfil desactivado, `requireActor` falla con `forbidden/account_disabled`
  (FR-004: la cuenta deja de poder entrar sin borrarla).
- **Deny-by-default**: `withAuth` (`src/lib/api.ts`) se amplía a
  `withAuth(handler, { roles? })`. Por defecto **un `staff` recibe 403** en
  cualquier ruta que no declare explícitamente `{ allowStaff: true }`. Esto
  cubre las ~40 rutas existentes (bandeja, contactos, pipeline, Laboratorio,
  plantillas, medios, ajustes…) **con un cambio central** en vez de editar cada
  una — el riesgo real de este diseño es *olvidar* una ruta, y deny-by-default
  lo convierte en "una ruta nueva queda cerrada" en vez de "queda abierta".
  Las rutas nuevas declaran su matriz de roles.
- **Páginas** (sin middleware, y un `layout.tsx` no se re-ejecuta en
  navegación suave): cada `page.tsx` existente llama a `guardPage(session,
  [owner, reception])` (una línea) y las nuevas declaran las suyas; el nav se
  filtra por rol. La protección real son las APIs (deny-by-default); la guarda
  de página es UX.
- **`bookingScope(actor)`** (`src/server/agenda/scope.ts`): devuelve una
  condición Drizzle que se compone con `scoped()`:
  owner/reception → `undefined` (todo el tenant); staff con `staffId` →
  `or(eq(booking.staffId, staffId), and(eq(kind,'block'), isNull(staffId)))`
  (propias + bloqueos del local, que el staff debe ver — US3.1); staff sin
  `staffId` → `sql\`false\``.
  `assertCanWriteBooking(actor, booking)` → owner/reception siempre;
  staff solo si `booking.staffId === actor.staffId` (los bloqueos del local no
  son editables por staff).
- **Recurso ajeno por id → 404 `not_found`**, no 403: no se confirma que la
  cita existe (FR-005 "sin revelar datos"). 403 queda para *superficies y
  acciones* vedadas por rol (catálogo, equipo, calendario global, cambiar
  precio). Es una decisión de este plan, no del spec → es reversible en un
  solo helper (`denyOutOfScope()`); el gate E2E acepta "no 2xx y sin datos".
- Todas las consultas de `booking` del dominio (listado, detalle, tablero,
  disponibilidad que arma `busy`) pasan por `scoped(booking.organizationId,
  actor.organizationId, bookingScope(actor), …)`. **La disponibilidad por
  profesional NO usa `bookingScope`** (necesita ver todos los ocupados para no
  ofrecer un hueco ocupado) pero solo expone huecos libres, nunca citas.
- **Exportación/búsqueda** (FR-005): hoy no existen. Regla escrita en
  `contracts/agenda-staff.md`: cualquier superficie futura que lea `booking`
  DEBE usar `bookingScope`; un test de vigilancia (`rg` sobre
  `src/` en CI) falla si algún archivo fuera de `src/server/agenda/` hace
  `.from(schema.booking)` — mismo patrón que el test de vigilancia de
  `moveLeadToStage` mencionado en `service.ts`.
- **Datos del cliente** (FR-009): el staff recibe una proyección
  `{ name, phone | waIdentity }` embebida en su cita; no recibe `contactId`
  (no le serviría: `/api/contacts` le responde 403).

**Alternativas**: filtrar en la UI/cliente (prohibido por FR-005); RLS de
Postgres (`SET app.staff_id` por request): robusto pero este repo no usa RLS
en ninguna tabla y `scoped()` es la convención; introducir RLS solo aquí
partiría el modelo de seguridad en dos. Anotado como evolución posible.

---

## D7. Foto de perfil: `bytea` en PostgreSQL, tabla aparte

**Decisión**: tabla `staff_photo (staff_id PK, organization_id, mime, size_bytes,
data bytea, updated_at)`, **separada** de `staff` para que ningún listado
cargue los bytes. Tope 512 KB (la UI reduce a ≤ 512 px antes de subir);
formatos JPEG/PNG/WebP validados **por magic bytes** (como `sniffFaviconMime`,
`src/lib/favicon.ts`) — **sin SVG** (servido desde el mismo origen sería un
vector XSS). Se sirve por `GET /api/staff/[id]/photo` autenticado, con
`X-Content-Type-Options: nosniff` y `Cache-Control: private, max-age=86400`
versionado por `?v=<photo_version>`.

**Rationale** (decidido con evidencia del despliegue, no por gusto):

- Precedente en el repo: el favicon y los adjuntos van a `MEDIA_DIR` en
  disco (`src/server/branding.ts`, `src/server/whatsapp/media.ts`). Pero
  `docker-compose.yml` (Ruta B) **no monta volumen** para `/data/media`: ahí el
  disco es efímero, y una foto de empleado que desaparece en cada
  `docker compose up --build` sería un bug de producto. En Coolify (Ruta A) el
  storage persistente es una instrucción manual de `.env.example`.
- En Postgres la foto vive donde ya está el respaldo y el volumen (`vocero_pg`),
  respeta `scoped()` por construcción y no añade ninguna pieza de despliegue
  (Constitución II: sin S3, y tampoco sin pedir un volumen extra).
- Costo real: ≤ 512 KB × decenas de profesionales = megabytes; irrelevante para
  Postgres. `bytea` TOAST-eado y fuera de `staff`.
- Drizzle 0.38 (`drizzle-orm@0.38.x`) no trae `bytea` nativo: se declara con
  `customType<{ data: Buffer; driverData: Buffer }>` (patrón estándar).

**Alternativas**: volumen local `MEDIA_DIR` (consistente con favicon, pero
efímero en Ruta B y exige configuración; **rechazada por esa razón**, y se
anota que el favicon y los adjuntos tienen el mismo problema latente —
hallazgo fuera de alcance de 018); base64 en `staff.photo` (infla cada fila y
cada listado); URL externa (viola II).

---

## D8. Backfill y servicio por defecto: uno por organización, en SQL, re-ejecutable

**Decisión** (en la misma migración 0014, cada paso con `WHERE NOT EXISTS`):

1. **Profesional por defecto** por cada `organization` que no tenga ninguno:
   `display_name` = nombre del usuario `owner` de esa organización (JOIN
   `member`→`user`) o, si no hay, el nombre de la organización; `job_title`
   NULL; `active` true; `weekly_hours` NULL (hereda el horario del local: la
   instancia se comporta idéntica); sin cuenta (`member_id` NULL; el dueño es
   `owner`, no necesita perfil para operar).
2. **Servicio por defecto** por organización sin catálogo: nombre `Cita`,
   `duration_minutes` = `calendar_settings.slot_minutes` de la organización
   (o 30 si no hay fila), `price_cents` 0. Fila `staff_service` que lo asigna
   al profesional por defecto (sin duración propia).
3. **Citas legadas**: `UPDATE booking SET staff_id = <default staff>, service_id
   = <default service>, price_cents = 0 WHERE kind='session' AND staff_id IS NULL`.
   Los bloqueos legados quedan con `staff_id NULL` ⇒ **bloqueo del local**,
   que es exactamente su semántica actual (bloqueaban todo el calendario).
4. Marcar `legacy_overlap` (D2) y **entonces** crear el constraint.

**Por qué servicio por defecto y no `service_id` nullable para legadas**: FR-019
exige servicio en toda cita y el `CHECK` de integridad (sesión ⇒ staff y
servicio) es más simple y más fuerte sin excepción de "legado". Un registro
real (`Cita`, duración = lo que ya se usaba) además deja a la instancia
usable el día uno: el agente tiene un servicio que ofrecer y la regla "si hay
un solo servicio y un solo profesional, no preguntes" (D10) reproduce el
comportamiento de hoy (SC-006). El dueño lo renombra desde el catálogo.

**Ids en SQL puro**: los ids con prefijo (`st_`, `sv_`) se generan con
`'st_' || substr(md5(random()::text || clock_timestamp()::text || o.id), 1, 20)`
(alfabeto `0-9a-f`, subconjunto del `0-9a-z` de `newId`; misma longitud 20).
Sin extensión extra.

**Idempotencia (IV)**: re-ejecutar la migración no duplica nada (`NOT EXISTS`),
y las filas nuevas posteriores del propio código la respetan. Organización
creada **después** de la migración (primer arranque de una instancia nueva):
`onUserCreated` (`src/server/auth/on-signup.ts`) siembra el profesional y el
servicio por defecto junto con etapas y perfil del agente (misma transacción),
para que "instancia nueva" y "instancia migrada" converjan.

**`offered_slot` preexistentes** (ofertas en vuelo sin staff/servicio): no se
borran; al reservar, una oferta con `staff_id NULL` se resuelve solo si la
organización tiene exactamente un profesional activo y un servicio activo
(el caso "como hoy"); si no, `slot_not_offered` y el agente re-ofrece. Las
ofertas son efímeras (se reemplazan completas en cada ronda).

**Moneda**: `price_cents` + `currency` (texto; default `MXN`, coherente con la
zona `America/Mexico_City` de los defaults de la 015). **SUPUESTO** a validar
con el dueño: Style opera en MXN. No hay cobro (spec: sin pagos).

**Lo que implementa el código (cierre 018, no es una decisión nueva)**: la
moneda por defecto del servicio y de la cita es `MXN` (D8).

---

## D9. Eventos en tiempo real (SSE) para el profesional

**Decisión**: opción A del dueño (FR-009): el staff **no** recibe eventos de
bandeja. `SseEvent` `booking.updated` gana `staffId: string | null`
(`src/server/events/bus.ts`); todos los `publish(..., booking.updated)` de
`service.ts` lo incluyen. En `/api/events` (`src/app/api/events/route.ts`)
se reemplaza `requireSession` por `requireActor` y el `subscribe` filtra por
rol: owner/reception reciben todo; staff recibe **únicamente**
`booking.updated` cuyo `staffId === actor.staffId` o es `null` con kind
bloqueo del local (el payload incluye `scope: "own"|"shop"` calculado al
publicar para no consultar la BD por evento); el resto se descarta en el
servidor (`message.new`, `conversation.updated`, `lab.run`, `message.status`).
Un staff sin perfil no recibe nada (se cierra el stream tras `: conectado`).

**Rationale**: el filtro vive en la suscripción del servidor, no en el cliente
(FR-005). El bus es in-process por organización (un EventEmitter): filtrar al
entregar es O(1) por evento. El payload nunca contiene datos del cliente, solo
`bookingId`, por lo que el staff vuelve a pedir por HTTP (que ya está
escopado). SC-007 (< 5 s): el agente publica tras confirmar la cita; el tablero
refetch por evento (ya lo hace `bookings-client.tsx` con `useEvents`).

**Alternativas**: canal SSE separado por rol (duplica heartbeat/headers);
filtrar en el cliente (prohibido).

---

## D10. "Cualquier profesional": fusión de huecos y asignación

**Decisión**: para `staff = any` + un `service`, se calcula la disponibilidad
de **cada profesional elegible** (activo, ofrece el servicio, tiene horario
efectivo) y se fusiona por instante de inicio. Para cada instante con ≥ 1
candidato se **elige un profesional en el momento de ofrecer** y se registra
*ese* en `offered_slot` (una fila por instante, con `staff_id` y
`any_staff = true`). Criterio de elección determinista y repartidor: el
candidato con **menos citas activas ese día** (empate → menor `staff.position`,
luego `id`). Así `book_slot` mantiene su contrato exacto (solo recibe
`startUtc`; staff y servicio salen de la fila ofrecida) y el cliente ve una
sola hora, no N.

**Carrera**: si entre la oferta y la reserva ese profesional se ocupó
(`23P01`/`findSlot` vacío) y la fila era `any_staff`, el servicio **reintenta
una vez con los demás candidatos libres a ese mismo instante** antes de
devolver `slot_taken` con alternativas. Con profesional nombrado, no hay
reasignación silenciosa (el cliente pidió a esa persona).

**Servicio único + profesional único**: si la organización tiene exactamente un
profesional activo o un solo servicio activo elegible, el agente no pregunta
por ese eje (FR-032, extendido al servicio para preservar el comportamiento
actual). **SUPUESTO de producto** (Constitución VII): si el cliente no nombra
profesional y hay varios, el agente usa `any` en vez de preguntar; solo
pregunta si el cliente da señales de preferencia. Revisable en el prompt.

**Lo que implementa el código (cierre 018, no es una decisión nueva)**:
`resolveStaff` (`src/server/agenda/agent.ts`) trata el profesional omitido,
vacío o `"any"` como cualquiera (D10).

**Alternativas**: guardar N filas por instante (una por candidato) y resolver
al reservar — más flexible pero rompe la unicidad de `startUtc` por oferta que
`findOffered` asume (comparación por epoch exacto) y duplica etiquetas;
rechazada. Asignación aleatoria — no determinista, imposible de testear.

---

## D11. Zona horaria y DST

**Decisión**: una sola zona por instancia (`calendar_settings.timezone`; spec:
un local, sin sucursales). Los horarios por profesional usan **el mismo JSON
de hora de pared** (`weeklyHours`, `{"mon":[{"start":"09:00","end":"18:00"}]}`)
interpretado en esa zona; todo instante persistido es UTC. Las vistas por día
del tablero convierten `[00:00, 24:00)` de la zona del negocio a UTC con los
helpers existentes de `src/lib/time/slots.ts` (`zonedWallClockToUtc`,
`addDaysISO`, `partsInTz`) — que ya manejan DST (research D1 de la 015). Sin
dependencias nuevas. El día de cambio de hora (23 h o 25 h) funciona porque el
rango del día se obtiene de dos conversiones, no de sumar 24 h.

---

## D12. ¿Recepción puede reasignar? Sí; el staff no

**Decisión**: dueño y recepción pueden crear, mover, **reasignar** y cancelar
citas de cualquiera (FR-024); la reasignación valida servicio ofrecido por el
destino, profesional activo, horario efectivo, bloqueos y no-solapamiento
(el `UPDATE staff_id` pasa por el mismo constraint, `23P01` → `slot_taken`).
Recalcula `duration_minutes`/`ends_at` con la duración efectiva del destino
solo si el dueño/recepción lo pide (`keepDuration: false`); por defecto
**conserva** duración y precio de la cita (FR-015: lo pactado no cambia). Un
profesional **no** reasigna: solo cancela/marca/mueve lo suyo (y solo dentro
de sí mismo).

---

## D13. Disponibilidad por profesional y servicio (generalización de la 015)

**Decisión**: `computeAvailability` pasa a recibir `{ staffId, serviceId }` y:

- **Horario efectivo** del profesional = intersección por día de
  `staff.weekly_hours ?? settings.weeklyHours` con `settings.weeklyHours`
  (nunca excede la apertura del local, FR-016). Función pura
  `effectiveHours(staffHours, shopHours)` testeable sola.
- **Duración efectiva** = `staff_service.duration_minutes ?? service.duration_minutes`.
- **Rejilla**: se conserva la de la 015 — paso = `slotMinutes + bufferMinutes`
  (`expandWorkingDayToUtc`); lo que cambia es el **largo** del candidato
  (duración efectiva en vez de `slotMinutes`) y que solo se emite si cabe
  completo en el intervalo (un servicio de 90 min no se ofrece a las 19:00 si
  el profesional cierra a las 20:00). Con servicio por defecto (duración =
  `slot_minutes`) y un profesional, el resultado es **idéntico** al de hoy
  (SC-006); se cubre con un test de equivalencia sobre fixtures de la 015.
- **Ocupados**: citas activas del profesional (no de otros), con cada
  intervalo extendido por `bufferMinutes` al final, + bloqueos personales +
  bloqueos del local, + `min_notice`.
- `findSlot` valida el hueco **de ese profesional y servicio**, no "algún
  hueco": recibe `{staffId, serviceId, startUtc}`.

**`booking_org_when_idx`** se reemplaza por `(organization_id, staff_id,
scheduled_at)` para el tablero y la disponibilidad (el índice GiST del
constraint ya cubre `(staff_id, rango)` pero no el filtro org-first
requerido por la Constitución III).

---

## D14. Alta de la cuenta del profesional

**Decisión**: reutilizar el mecanismo de `src/app/api/settings/team/route.ts`
(`runInternalSignup` + `auth.api.signUpEmail` + `insert member`), pero desde
`POST /api/staff/[id]/account` (dueño): crea usuario + `member{role:'staff'}`
y fija `staff.member_id`. Contraseña temporal entregada al dueño como hoy
(sin servicio de email: Constitución II; el spec dice "invita con un correo"
→ interpretado como **alta con correo + contraseña temporal**, igual que el
equipo actual; **SUPUESTO** a confirmar con el dueño, no hay correo
transaccional en el núcleo). Restricciones: un perfil ↔ una cuenta
(`UNIQUE(member_id)` parcial); un `member` `staff` sin perfil queda en
"sin acceso a nada". Desactivar al profesional no borra la cuenta: la bloquea
vía `requireActor`.

**Lo que implementa el código (cierre 018, no es una decisión nueva)**:
`POST /api/staff/[id]/account` exige contraseña (mínimo 8 caracteres), no
envía correo, y responde `{ ok: true }` sin devolver la contraseña (D14).

---

## Resumen de supuestos no verificados (SUPUESTO)

1. `btree_gist` instalable con el usuario de la BD de cada despliegue (D2):
   verificado solo en un PG16 local (Homebrew), no en `postgres:16-alpine`.
2. Un rol desconocido (`staff`) no tiene permisos sobre los endpoints del
   plugin `organization` de Better Auth (D5): no verificado contra el código
   instalado; la Slice 2 lo prueba y añade el hook defensivo.
3. Moneda por defecto `MXN` (D8).
4. "Invitar con un correo" = alta con contraseña temporal; no hay email (D14).
5. Si el cliente no nombra profesional y hay varios, el agente usa `any` (D10).

**Cierre 018**: los puntos 3, 4 y 5 quedan cerrados como lo que el código
implementa (D8 moneda `MXN`, D14 contraseña temporal, D10 profesional omitido
= cualquiera). No son decisiones nuevas.

6. Recurso ajeno por id responde 404 en vez de 403 (D6) — decisión de este
   plan sobre un detalle que el spec deja abierto.
7. `scripts/e2e-selftest.mjs` usa una sola cookie global (`let cookie`); el
   guion de aislamiento necesita varias sesiones a la vez: se refactoriza el
   helper `api()` para aceptar un *jar* (D-plan, Slice 2). No se leyó el
   archivo completo (≈2000 líneas); solo la cabecera, `agendaChecks()` y el
   índice de secciones.
8. Los *personas* del Laboratorio son secuencias fijas (`personas.ts`); para
   "corte con X" hay que parametrizar nombres reales del profesional/servicio
   en el guion — se asume soporte de marcadores `{{staff1}}` / `{{service1}}`
   en `runner.ts` (no leído a fondo).
