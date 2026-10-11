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

/** Los modelos mandan `null` por "no aplica": se trata igual que omitido. */
const optionalText = z
  .string()
  .nullish()
  .transform((v) => v ?? undefined);

/** "9:30" / "09.30" → "09:30"; anything else is dropped, never fatal. */
const clockText = z
  .string()
  .nullish()
  .transform((v) => {
    const m = /^\s*([01]?\d|2[0-3])[:.]([0-5]\d)\s*$/.exec(v ?? "");
    return m ? `${m[1]!.padStart(2, "0")}:${m[2]}` : undefined;
  });

/** A number, or a numeric string; null, NaN and garbage mean "not said". */
const optionNumber = z
  .union([z.number(), z.string()])
  .nullish()
  .transform((v) => {
    if (v === null || v === undefined || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  });

const whenSchema = z
  .object({ day: optionalText, from: optionalText, to: optionalText })
  .nullish()
  .transform((v) => v ?? undefined);

/**
 * 019 — El contrato de agenda del bot de barbería. Solo se registra si esta
 * instancia tiene la bandera encendida: donde no hay agenda, el modelo ni
 * siquiera puede nombrarlas.
 *
 * El modelo NO ofrece horarios ni calcula fechas: dice qué decidió el cliente
 * (`update_draft`, con `day` relativo) y qué horario eligió (`book_slot`, por
 * hora o por posición); el código ofrece, resuelve y reserva.
 */
const agendaActions = [
  z.object({
    action: z.literal("update_draft"),
    service: optionalText,
    /** Nombre del profesional o `any`. */
    staff: optionalText,
    when: whenSchema,
    reply: optionalText,
  }),
  z.object({
    action: z.literal("book_slot"),
    /** La hora que el cliente dijo, "HH:mm" de 24 h. */
    time: clockText,
    /** El día si lo dijo ("mañana", "martes"), igual que en `when.day`. */
    day: optionalText,
    /** 1-3: la posición ("el primero", "la segunda") cuando no dio la hora. */
    option: optionNumber,
  }),
  z.object({ action: z.literal("greeting") }),
  z.object({ action: z.literal("my_bookings") }),
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

/** Las acciones propias de la agenda, base del tipo `BotAction` de las guardas. */
export type AgendaModelAction = Extract<
  AgentActionType,
  { action: "update_draft" | "book_slot" | "my_bookings" | "greeting" | "reply" | "handoff" }
>;

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
  if (action.action === "move_stage" || action.action === "update_draft") {
    return action.reply
      ? { action: "reply", text: action.reply }
      : { action: "none" };
  }
  if (
    action.action === "book_slot" ||
    action.action === "my_bookings" ||
    action.action === "greeting"
  ) {
    return { action: "none" };
  }
  return action;
}
