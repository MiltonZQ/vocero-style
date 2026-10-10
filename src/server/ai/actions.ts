import { z } from "zod";

/**
 * Acción tipada del agente: exactamente UNA por turno (FR-021).
 * El servidor valida cada acción contra sus allowlists (etapas de la org);
 * lo que no valida se degrada, nunca se ejecuta a ciegas.
 */
const baseActions = [
  z.object({ action: z.literal("none") }),
  z.object({ action: z.literal("reply"), text: z.string().min(1) }),
  z.object({
    action: z.literal("update_lead"),
    note: z.string().min(1),
    reply: z.string().optional(),
  }),
  z.object({
    action: z.literal("move_stage"),
    stage: z.string().min(1),
    reply: z.string().optional(),
  }),
  z.object({
    action: z.literal("handoff"),
    reason: z.string().optional(),
    farewell: z.string().optional(),
  }),
] as const;

/**
 * 015 — Las dos acciones de agenda. Solo se registran si esta instancia tiene
 * la bandera encendida: donde no hay agenda, el modelo ni siquiera puede
 * nombrarlas.
 *
 * `reply` es una introducción opcional, NO la lista de horarios: los horarios
 * los pega el motor con las etiquetas reales. Y `startUtc` tiene que ser
 * exactamente uno de los que el sistema ofreció — si no, el motor lo rechaza y
 * se re-ofrece.
 */
const agendaActions = [
  z.object({
    action: z.literal("offer_slots"),
    service: z.string().optional(),
    staff: z.string().optional(),
    reply: z.string().optional(),
  }),
  z.object({
    action: z.literal("book_slot"),
    startUtc: z.string().min(1),
    reply: z.string().optional(),
  }),
] as const;

export const AgentAction = z.discriminatedUnion("action", [
  ...baseActions,
  ...agendaActions,
]);

/** El esquema que se le exige al modelo en ESTE turno. */
export function agentActionSchema(agenda: boolean) {
  return agenda
    ? AgentAction
    : z.discriminatedUnion("action", [...baseActions]);
}

export type AgentActionType = z.infer<typeof AgentAction>;

/**
 * Resuelve el nombre de etapa devuelto por el modelo contra las etapas reales
 * de la organización (exacto → lower-case). Sin match: degradar a reply/none.
 */
export function resolveStage(
  requested: string,
  stages: { id: string; name: string }[]
): { id: string; name: string } | null {
  const exact = stages.find((s) => s.name === requested.trim());
  if (exact) return exact;
  const lower = requested.trim().toLowerCase();
  return stages.find((s) => s.name.toLowerCase() === lower) ?? null;
}

/** Degrada una acción que no se pudo ejecutar (FR-021 / contrato ai.md). */
export function degradeAction(action: AgentActionType): AgentActionType {
  if (
    action.action === "move_stage" ||
    action.action === "offer_slots" ||
    action.action === "book_slot"
  ) {
    return action.reply
      ? { action: "reply", text: action.reply }
      : { action: "none" };
  }
  return action;
}
