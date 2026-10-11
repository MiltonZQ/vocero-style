# E2E — Bot de la barbería (019)

Guion de comportamiento observable. La app ya está arriba con los mocks. El
arnés de API es `pnpm test:e2e:local` (carga `.env.e2e`), sección
`barberBotChecks()` en `scripts/e2e-selftest.mjs`, solo con `AGENDA=on`.

**`pnpm test:e2e` no es este guion**: ese script carga `.env`.

**Preparación** (nombres de variable, no valores): base migrada con `0015`
(`booking_draft` y columnas de local en `calendar_settings`), y los mocks:

- `AGENDA` encendida
- `WA_MOCK_ENABLED`
- `META_GRAPH_BASE_URL` apuntando al wa-mock
- `OPENROUTER_BASE_URL` apuntando al ai-mock
- `BOT_API_KEY`

El arnés crea y retira al final un barbero (`E2E Barbero`) y un servicio
(`E2E Fade`, 40 min, $150). Restaura horario y datos del local.

---

## US1 — Reserva en una conversación (camino feliz)

1. `PUT /api/calendar/settings` con dirección, enlace de Maps (https) y
   llegada anticipada de 5 min; un enlace que no es https responde 422.
   ✅ Los ajustes vuelven tal cual en el `GET`.
2. Inbound «quiero un E2E Fade con E2E Barbero mañana a las 5».
   ✅ El bot responde con opciones numeradas (≥2) después de las 17:00; sin
   preguntar el servicio ni el barbero (ya los dijo).
3. Inbound «la 2».
   ✅ Existe la cita con el servicio, el barbero, 40 min y la hora de la
   opción 2.
   ✅ La confirmación (texto de código, no del modelo) dice «Cita confirmada»,
   `40 min`, «5 minutos antes», dirección y enlace de Maps, barbero y precio.
   ✅ Sin enlace de reunión (ni en el texto ni en la cita), aunque la
   instancia tenga una sala fija configurada: es presencial.

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
   ✅ El outbox del wa-mock no crece (sandbox).
