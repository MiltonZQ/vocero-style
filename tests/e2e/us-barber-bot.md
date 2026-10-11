# E2E — Bot de la barbería (019)

Guion de comportamiento observable. La app ya está arriba con los mocks. El
arnés de API es `pnpm test:e2e:local` (carga `.env.e2e`), sección
`barberBotChecks()` en `scripts/e2e-selftest.mjs`, solo con `AGENDA=on`.

**`pnpm test:e2e` no es este guion**: ese script carga `.env`.

**Preparación** (nombres de variable, no valores): base migrada con `0016`
(`booking_draft`, columnas de local y coordenadas del pin en `calendar_settings`), y los mocks:

- `AGENDA` encendida
- `WA_MOCK_ENABLED`
- `META_GRAPH_BASE_URL` apuntando al wa-mock
- `OPENROUTER_BASE_URL` apuntando al ai-mock
- `BOT_API_KEY`

El arnés crea y retira al final un barbero (`E2E Barbero`) y un servicio
(`E2E Fade`, 40 min, $25.000 COP). Restaura horario y datos del local.

---

## US1 — Reserva en una conversación (camino feliz)

1. `PUT /api/calendar/settings` con dirección, enlace de Maps (https) y
   llegada anticipada de 5 min; un enlace que no es https responde 422.
   ✅ Los ajustes vuelven tal cual en el `GET`.
2. Inbound «quiero un E2E Fade con E2E Barbero mañana a las 5».
   ✅ El bot ofrece ≥2 horarios en una frase natural («Para mañana … tenemos
   disponible a las …») y pregunta «¿Cuál de estos horarios prefieres…»; sin
   lista numerada ni «Responde con el número»; todos después de las 17:00; sin
   preguntar el servicio ni el barbero (ya los dijo).
3. Inbound «la 2».
   ✅ Existe la cita con el servicio, el barbero, 40 min y la hora de la
   opción 2.
   ✅ La confirmación (texto de código, no del modelo) dice «tu cita quedó
   agendada», `40 min`, «5 minutos antes», dirección y enlace de Maps (aún sin
   pin), barbero y precio con separador de miles (`$25.000 COP`, nunca
   `$25000`).
   ✅ Sin enlace de reunión (ni en el texto ni en la cita), aunque la
   instancia tenga una sala fija configurada: es presencial.

## US1b — Recepcionista: saludo, catálogo y reserva por hora

1. Inbound «Hola» (conversación real).
   ✅ Responde «¿Cómo estás?» y «¿En cuál de nuestros servicios…» nombrando el
   servicio, sin precios; sin handoff; el borrador no tiene servicio elegido.
   ✅ El wa-mock recibió «leído» + `typing_indicator` (`text`) para ese
   `message_id`.
2. Inbound «quiero agendar» (sin servicio).
   ✅ Catálogo «¿En cuál de nuestros servicios…» con `E2E Fade ($25.000 COP)`.
3. Mismo pedido del camino feliz y luego «me sirve a las <hora del 2.º
   horario ofrecido>».
   ✅ La cita queda en ese horario con el barbero (se elige por hora, no por
   número).

## US1c — Pin de ubicación

1. El iframe «Insertar un mapa» del dueño se convierte en lat 4.5988…, lng
   -74.1632… (el mismo parser que usa la tarjeta de ajustes); un enlace
   `maps.app.goo.gl` se rechaza con el error en español que pide el iframe o el
   enlace largo.
2. `PUT /api/calendar/settings` con las coordenadas; latitud sin longitud y
   latitud fuera de rango responden 422. Vuelven iguales en el `GET`.
3. Nueva reserva.
   ✅ El texto de confirmación trae la dirección pero no el enlace de Maps; el
   wa-mock recibe un mensaje `type: "location"` justo después, con las
   coordenadas, la dirección y el nombre del negocio.

## US1d — Nota de voz

PENDIENTE: `transcribe.ts` llama fijo a `api.openai.com` y el wa-mock no
entrega audio, así que no hay forma de ejercitarla sin una clave real de
Whisper. Cubierta en `tests/unit/agent-turn-voice-typing.test.ts`; verificar
con un audio real tras el deploy.

## US2 — Lo que el bot no hace, lo hace una persona

1. Inbound «necesito cancelar mi cita».
   ✅ `handoffAt` y `handoffReason = cancelacion`.
2. Otro inbound en esa conversación.
   ✅ El bot no responde.

## US3 — Las preguntas frecuentes no escalan

1. Tres inbound seguidos: «¿dónde queda el local?», «¿cuál es la dirección?»,
   «¿cómo llego?».
   ✅ Las tres se contestan; sin `handoffAt` ni `handoffReason`.

## US4 — El modelo falla

1. Inbound «quiero un E2E Fade» y luego «simula json invalido uno» (el ai-mock
   devuelve 200 con texto que no es JSON; el interruptor vive tras el guard de
   mocks, en `src/app/api/dev/ai-mock/v1/chat/completions/route.ts`).
   ✅ El bot vuelve a preguntar el paso actual; no escala.
2. Inbound «simula json invalido dos».
   ✅ Handoff con motivo `error`; ninguna cita.
3. Proveedor caído (HTTP 500, «simula proveedor caido»): igual, el primer
   fallo re-pregunta y el segundo seguido escala con `error` (sección 018 del
   arnés).

## US5 — Laboratorio con las personas de la barbería

1. `POST /api/lab/runs`.
   ✅ 16 personas; todas verdes salvo `fuera_de_kb` (rojo, hueco intencional
   del KB). Score observado: 94. Detalle de score y delta en `us4-lab.md`.
   ✅ Las `handoff_*` terminan con su motivo; las `agenda_*` dejan cita
   `is_test`.
   ✅ El outbox del wa-mock no crece (sandbox) y tampoco se registra «leído» ni
   «escribiendo…» (conversaciones `is_test`).
