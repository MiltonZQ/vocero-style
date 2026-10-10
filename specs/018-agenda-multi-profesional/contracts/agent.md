# Contrato — Agente de WhatsApp y cerebro externo (feature 018)

Extiende `specs/015-motor-agenda-universal/contracts/agenda.md` (superficie
`/api/bot/*`) y la unión de acciones del agente in-process
(`src/server/ai/actions.ts`). Todo sigue detrás de `AGENDA=on` (404 apagado) y,
en `/api/bot/*`, detrás de `BOT_API_KEY` (`requireBotKey`, tiempo constante);
la bandera se evalúa **antes** que la llave, como hoy.

Principio rector que NO cambia: **solo se reserva un horario que el sistema
ofreció en esa conversación** (FR-031). Lo que cambia es qué recuerda la oferta:
ahora también profesional y servicio.

Compatibilidad: todos los cambios son **aditivos**. Un cliente de la 015 que
llama sin parámetros nuevos sigue funcionando en una instancia de un
profesional y un servicio (SC-006); en una instancia multi-profesional recibe
`422 service_required` con el catálogo, que es la señal para actualizarse.

---

## 1. Acciones del agente in-process

Cambian dos acciones de la unión `agendaActions` (siguen exactamente UNA por
turno; el esquema solo las incluye con la bandera, `agentActionSchema(agenda)`).

### `offer_slots` (gana `service` y `staff`)

```jsonc
{ "action": "offer_slots",
  "service": "Corte clásico",     // nombre tal como el catálogo; requerido si hay >1 servicio elegible
  "staff": "Juan",                // opcional: nombre de profesional, o "any"; omitido ≡ "any"
  "reply": "…" }                  // sigue siendo solo la frase de entrada
```

- El modelo **no recibe ids**; recibe en el prompt (`src/server/ai/prompts.ts`,
  sección de agenda condicional) una tabla compacta: servicios activos
  (`nombre — duración — precio`) y, por servicio, qué profesionales lo ofrecen
  (`nombre (oficio)`). Con la bandera apagada: **0 tokens**, igual que hoy.
- El servidor resuelve `service` y `staff` contra el catálogo real
  (`resolveService`/`resolveStaff` en `src/server/agenda/agent.ts`, patrón de
  `resolveStage`: exacto → minúsculas → sin acentos). Sin coincidencia →
  la acción **degrada** a una respuesta generada por el motor que lista las
  opciones válidas (nunca inventa, nunca lanza).
- **Reglas de oferta** (FR-029, FR-032):
  - Solo combinaciones válidas: profesional **activo**, que **ofrece** el
    servicio, con horario efectivo; servicio **activo**.
  - Profesional nombrado que **no** ofrece el servicio → el texto lo dice y
    propone los que sí (US6.2). La oferta no se registra.
  - `any` / omitido con varios profesionales → fusión de huecos y asignación
    por reparto (research D10); la oferta registra el profesional de cada hueco.
  - **Un solo profesional activo** → no se pregunta ni se menciona; **un solo
    servicio elegible** → tampoco se pregunta (preserva el comportamiento
    actual).
  - Profesional sin servicios o servicio sin profesionales: no aparece / el
    agente lo dice ("por ahora no ofrecemos…").
- Registro: `replaceOffers` escribe una fila por instante con
  `{ startUtc, label, staffId, serviceId, durationMinutes, anyStaff }`
  (data-model: `offered_slot`). El texto al cliente conserva la forma
  `• <día> a las <hora>`; con profesional nombrado puede añadir
  ` con <Nombre>`; con `any` **no** (el cliente no eligió persona). La
  etiqueta guardada (`label`) es exactamente la mostrada.
- `mapaDeHuecosParaModelo` (`offers.ts`) sigue entregando al modelo el mapa
  `"etiqueta" → startUtc`; se añade `· staff` solo cuando hay nombrado, para
  que el modelo pueda reconocer "el de Juan a las 10".

### `book_slot` (contrato de entrada SIN cambio)

```jsonc
{ "action": "book_slot", "startUtc": "<uno de los ofrecidos>", "reply": "…" }
```

El servidor localiza la fila ofrecida por **epoch exacto** (`findOffered`) y de
ella toma `staffId`, `serviceId` y `durationMinutes`; **ningún id llega del
modelo**, así que no puede reservar a un profesional/servicio no ofrecido.
Luego `createSessionBooking`:

1. valida otra vez el hueco **de ese profesional y servicio** (`findSlot`);
2. inserta con duración efectiva y precio **copiados** del catálogo;
3. `23P01`/`23505` → `slot_taken`: si la fila era `anyStaff`, **un reintento**
   con los demás candidatos libres en ese instante; si no hay ninguno →
   `BookingError("slot_taken")` con alternativas frescas **registradas como la
   nueva oferta** (mismo servicio, mismo alcance de profesional);
4. confirma con el nombre del profesional cuando aplica:
   `¡Listo! Te agendé para <label> con <Nombre>.` (con `any` se informa a quién
   le tocó).

Fallo de proveedor de IA / motor: el turno degrada sin reservar; nunca se crea
una cita a medias (borde del spec). El sandbox no cambia: conversación
`is_test` ⇒ cita `is_test` ⇒ fuera del constraint, fuera de la disponibilidad
real y **jamás** llega a un conector.

---

## 2. Superficie `/api/bot/*` (cerebro externo, FR-033)

Las mismas reglas aplican; no hay atajo. Auth: header `X-API-Key`
(`BOT_API_KEY`); sin llave → `401`; la superficie nunca hace nada fuera de la
organización de la instancia (`resolveInstanceOrg`).

### `GET /api/bot/catalog`  (NUEVO)
`200` →
```jsonc
{ "services": [
    { "id": "sv_…", "name": "Corte clásico", "durationMinutes": 30,
      "priceCents": 15000, "currency": "MXN",
      "staff": [ { "id": "st_…", "displayName": "Juan", "jobTitle": "barbero",
                   "effectiveDurationMinutes": 45 } ] } ],
  "singleStaff": false, "singleService": false }
```
Solo servicios activos y profesionales activos que los ofrecen. Es lo que un
cerebro externo necesita para identificar servicio/profesional **sin** adivinar
ids. Sin datos de contacto de los profesionales (no se expone `phone`).

### `GET /api/bot/availability?conversationId=&serviceId=&staffId=<id|any>&limit=&perDay=&days=`  (CAMBIA, aditivo)
- Registra la oferta (como hoy), ahora con `staff_id/service_id/duration`.
- `serviceId` requerido si hay > 1 servicio activo elegible; si hay uno solo se
  asume. `staffId` omitido ≡ `any`.
- `200` →
```jsonc
{ "slots": [ { "startUtc", "endUtc", "label", "dayIso", "dayLabel", "time",
               "staffId", "staffName", "serviceId", "durationMinutes",
               "priceCents" } ],
  "diasConAgenda": ["2026-10-12"] }
```
(`staffName` presente aunque `any`, para que el cerebro **decida** si lo
dice; la etiqueta no lo incluye.) `422 service_required` (con `services`) si
falta y es ambiguo; `404 not_found` conversación inexistente (como hoy);
`422 service_not_offered` si `staffId` nombrado no ofrece el servicio.

### `POST /api/bot/bookings`  (cuerpo SIN cambio)
`{ conversationId, startUtc, notes? }` → **`201`** (exacto, como la 015):
```jsonc
{ "bookingId": "bk_…", "meetingLink": null, "linkPending": false,
  "label": "lun 12 oct, 11:00",
  "staffId": "st_…", "staffName": "Juan", "serviceName": "Corte clásico",
  "durationMinutes": 45, "priceCents": 15000, "currency": "MXN" }
```
Errores (sobre anidado, `slots` hermano):
- `409 slot_not_offered` + `slots` = lo ofrecido (igual que hoy).
- `409 slot_taken` + `slots` = alternativas frescas ya registradas
  (mismo servicio/alcance). **Es el error recuperable por contrato** (FR-022):
  el cerebro debe re-ofrecer, no reintentar a ciegas.
- Oferta antigua sin `staff_id` (pre-migración) y organización multi-profesional
  → `409 slot_not_offered` (el cerebro re-ofrece; research D8).

### `PATCH /api/bot/bookings`  (reprogramar la próxima cita, **200**)
Sin cambio de cuerpo. Reprograma con el **mismo profesional y servicio** de la
cita (la oferta debe haberse generado para ese profesional/servicio: se valida
que `offered_slot.staff_id = booking.staff_id`; un hueco de otro profesional
→ `409 slot_not_offered`; mover entre profesionales es decisión del
dueño/recepción, no del agente — igual que cancelar, que sigue sin existir
en esta superficie).

### Sin cambios
`/api/bot/context`, `ficha`, `handoff`, `messages`, `profile`, `reset`,
`typing`: sin modificación. `context` **no** expone datos de profesionales
(el cerebro usa `catalog`).

---

## 3. Personas del Laboratorio (US6 / SC-005)

`src/server/lab/personas.ts` es de guiones fijos sin LLM. Se añaden dos
personas con marcadores resueltos por `runner.ts` contra la instancia de
prueba (primer profesional y primer servicio activos y relacionados):

| key | Guion (resumen) | Expectativa del juez |
|---|---|---|
| `agenda_profesional_nombrado` | "Hola, quiero un `{{service1}}` con `{{staff1}}` mañana" → elige el primer horario → confirma | cita `is_test` asignada a `{{staff1}}`, duración efectiva correcta |
| `agenda_cualquiera` | "Quiero `{{service2}}`, el que esté libre" → elige → confirma | cita asignada al profesional del hueco; el agente no pregunta por persona |
| `agenda_servicio_no_ofrecido` (negativa) | pide `{{service1}}` con un profesional que no lo ofrece | el agente lo indica y propone a quien sí; no crea cita |

El `judge.ts` ya evalúa el transcript; se extiende el criterio de agenda para
mirar profesional/servicio/duración con el estado de la BD de la corrida
(SC-005 ≥ 95 %). **SUPUESTO**: `runner.ts` admite marcadores (no se leyó a
fondo); si no, se resuelven al construir el script en `personas.ts`.
La corrida usa `ai-mock` en el self-test (determinista) y el modelo real en
validación manual.

---

## 4. Cobertura del E2E del agente (en `scripts/e2e-selftest.mjs`)

Con `ai-mock` (`src/server/dev/ai-mock.ts`, ampliado para emitir las acciones
nuevas con `service`/`staff`) y `wa-mock`:

1. Servicio + profesional nombrado → todos los huecos ofrecidos son de ese
   profesional (`staffId` constante) y de duración efectiva.
2. `any` → cita queda con el `staffId` del hueco elegido.
3. Profesional que no ofrece el servicio → texto con alternativas, sin oferta,
   sin cita.
4. Hueco ocupado entre oferta y confirmación → `409 slot_taken` / texto de
   disculpa + alternativas; **cero** citas creadas.
5. Instancia de un profesional → el agente no menciona profesional.
6. Conversación `is_test` → cita `is_test`; no ocupa el hueco real.
7. `/api/bot/*`: `201` exacto en crear; `409` con `slots` hermano.
