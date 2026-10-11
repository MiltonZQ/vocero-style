# Guion E2E — US4: Laboratorio (SIEMPRE contra ai-mock, determinista)

> Conducido con Playwright (MCP) contra `pnpm dev` con ai-mock. El KB inicial
> NO cubre garantías/devoluciones (hueco intencional del guion).
> Los números de score de abajo son OBSERVADOS, no estimados. Si la instancia
> tiene un servicio de tinte en el catálogo, `agenda_tinte_no_ofrecido` sale
> roja (88): el tinte sí se ofrece. Es del fixture, no del bot.

## Preparación

1. `DELETE /api/dev/wa-mock/outbox` — el outbox debe seguir VACÍO al final.
2. Agente configurado (US3) y proveedor de IA (mock) activo.

## Corrida 1

3. En `/lab`: pulsar "Correr evaluación".
   ✅ La UI muestra el subtítulo permanente "Sandbox interno — no envía
   mensajes reales", progreso en vivo (n/16) sin bloquear la navegación.
4. Al terminar:
   ✅ Reporte con score global (15 verdes + 1 rojo; **94 observado** en la corrida del 2026-10-11 con `pnpm test:e2e:local`, catálogo de la barbería sin servicios extra), tarjeta de la persona
   "Pregunta fuera del conocimiento" con hallazgo `fuera_de_kb`, evidencia y
   sugerencia; transcript visible por persona.
   ✅ Las personas `handoff_*` ("Quiere cancelar su cita", "Quiere reprogramar su cita", "Avisa que llega tarde", "Pide hablar con una persona") terminaron en handoff con su motivo (cancelacion, reprogramacion, llegada, cliente); las `agenda_*` dejaron cita `is_test` con confirmación (duración + «minutos antes») salvo las dos de servicio no ofrecido.
   ✅ `GET /api/dev/wa-mock/outbox` → VACÍO (ningún mensaje salió a WhatsApp).
   ✅ Las conversaciones de prueba NO aparecen en la bandeja.

## Cerrar el loop

5. En el hallazgo: "Agregar al conocimiento" → editar/confirmar → guardado en
   el KB (visible en `/agent`).
6. Re-correr la evaluación.
   ✅ El historial muestra 2 corridas; la nueva con score **100 y delta +6 (observados**, 2026-10-11: 94 → 100 tras agregar al KB la política de garantías y devoluciones).

## Caminos infelices

7. Con una corrida en curso, `POST /api/lab/runs` → 409 `run_in_progress`.
8. Corridas huérfanas: cubierto por `src/instrumentation.ts` al boot
   (verificación en el checkpoint de compose, donde el server se reinicia).
