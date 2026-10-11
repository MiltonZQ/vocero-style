import type { schema } from "@/lib/db";
import { formatMoneyCents } from "@/lib/money";

type AgentProfile = typeof schema.agentProfile.$inferSelect;
type KbEntry = typeof schema.kbEntry.$inferSelect;

/** Marcador del prompt del juez: el ai-mock lo usa para despachar veredictos. */
export const JUDGE_MARKER = "[JUEZ]";

export type AgendaPromptCatalog = {
  services: Array<{
    name: string;
    durationMinutes: number;
    priceCents: number;
    currency: string;
    staff: Array<{ displayName: string; jobTitle: string | null }>;
  }>;
};

function renderAgendaCatalog(catalog: AgendaPromptCatalog): string {
  const lines = ["Catálogo de la agenda (usa estos nombres tal cual en update_draft):"];
  for (const service of catalog.services) {
    const price =
      formatMoneyCents(service.priceCents, service.currency) ??
      `${service.priceCents} ${service.currency}`;
    lines.push(`- ${service.name} — ${service.durationMinutes} min — ${price}`);
    for (const person of service.staff) {
      const job = person.jobTitle ? ` (${person.jobTitle})` : "";
      lines.push(`  - ${person.displayName}${job}`);
    }
  }
  lines.push('Si el cliente dice que le da igual quién, manda staff "any". Si nombra a uno, usa su nombre. Si no dice nada de profesional, NO lo inventes.');
  return lines.join("\n");
}

/** Marcador del bloque de estado que se agrega al FINAL de la conversación. */
export const DRAFT_STATE_MARKER = "ESTADO DEL BORRADOR";

const WEEKDAY_NAMES: Array<[string, string]> = [
  ["mon", "lunes"],
  ["tue", "martes"],
  ["wed", "miércoles"],
  ["thu", "jueves"],
  ["fri", "viernes"],
  ["sat", "sábado"],
  ["sun", "domingo"],
];

/** "lunes 10:00-20:00; martes 10:00-20:00; domingo cerrado". */
export function formatShopHours(
  weeklyHours: Partial<Record<string, Array<{ start: string; end: string }>>>
): string {
  return WEEKDAY_NAMES.map(([key, name]) => {
    const intervals = weeklyHours[key] ?? [];
    return intervals.length > 0
      ? `${name} ${intervals.map((i) => `${i.start}-${i.end}`).join(", ")}`
      : `${name} cerrado`;
  }).join("; ");
}

/** "domingo 11 de octubre de 2026, 10:00" en la zona del negocio. */
export function formatToday(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("es-MX", {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("weekday")} ${get("day")} de ${get("month")} de ${get("year")}, ${hour}:${get("minute")}`;
}

/**
 * 019 — El estado de AHORA para el modelo: fecha de hoy, borrador y opciones
 * numeradas. Va al final, después del historial, para que no quede enterrado.
 */
export function buildDraftStateBlock(input: {
  now: Date;
  timezone: string;
  step: string;
  serviceName: string | null;
  /** Nombre del profesional, "cualquiera" o null si falta. */
  staffLabel: string | null;
  whenLabel: string | null;
  options: string[];
}): string {
  return [
    `Hoy es ${formatToday(input.now, input.timezone)}, zona ${input.timezone}.`,
    `${DRAFT_STATE_MARKER} (lo administra el sistema):`,
    `- paso: ${input.step}`,
    `- servicio: ${input.serviceName ?? "(sin elegir)"}`,
    `- profesional: ${input.staffLabel ?? "(sin elegir)"}`,
    `- horario pedido: ${input.whenLabel ?? "(sin preferencia)"}`,
    input.options.length > 0
      ? `- opciones ofrecidas al cliente:\n${input.options.map((o, i) => `  ${i + 1}) ${o}`).join("\n")}`
      : "- opciones ofrecidas al cliente: (ninguna)",
  ].join("\n");
}

export function renderKb(entries: KbEntry[]): string {
  if (entries.length === 0) return "(knowledge base vacío)";
  return entries
    .map((e) =>
      e.kind === "qa"
        ? `P: ${e.question}\nR: ${e.answer}`
        : (e.content ?? "")
    )
    .filter(Boolean)
    .join("\n\n");
}

/**
 * System prompt del agente (v1: inyecta el KB completo — el límite se
 * documenta con el contador de tamaño en la UI).
 */
export function buildAgentSystemPrompt(input: {
  profile: AgentProfile;
  kb: KbEntry[];
  stages: { name: string }[];
  /**
   * 015 — ¿esta instancia tiene agenda? Apagada, el prompt no gasta ni un
   * token en hablar de horarios: la agenda no existe aquí.
   */
  agenda?: boolean;
  /** 018 — servicios y quién los ofrece. Se ignora con la agenda apagada. */
  catalog?: AgendaPromptCatalog;
  /** 019 — horario del local en texto (ver `formatShopHours`). */
  shopHours?: string;
}): string {
  const { profile } = input;
  const stageNames = input.stages.map((s) => s.name).join(" | ");
  const agendaLines = input.agenda
    ? [
        '- {"action":"update_draft","service":"...","staff":"...","when":{"day":"...","from":"HH:mm","to":"HH:mm"},"reply":"..."} — registrar lo que el cliente decidió. Llena TODOS los campos que diga en ese mensaje, a la vez. reply es opcional y MUY breve (sin horarios ni precios: los pone el sistema).',
        '- {"action":"book_slot","option":1} — el cliente eligió una de las opciones NUMERADAS que el sistema le ofreció (1, 2 o 3).',
        '- {"action":"my_bookings"} — el cliente pregunta por su cita ("¿a qué hora era mi cita?").',
      ]
    : [];
  const agendaRules = input.agenda
    ? [
        "- Orden de la reserva: primero el servicio, luego el profesional (o cualquiera), luego el horario. El sistema pregunta lo que falte y ofrece los horarios; tú solo registras lo que el cliente dice.",
        "- NUNCA escribas horarios, fechas ni precios tú: el sistema los pega. NUNCA calcules fechas.",
        '- when.day es EXACTAMENTE "hoy", "mañana", "pasado mañana", el nombre del día ("lunes".."domingo") o YYYY-MM-DD SOLO si el cliente dijo una fecha explícita. from/to en HH:mm de 24 h.',
        '- Franjas: "en la mañana" = 10:00-13:00, "en la tarde" = 14:00-19:00, "en la noche" = 18:00-20:00; ajústalas al horario del local (nunca pidas una hora en que el local está cerrado).',
        "- Si el cliente elige una opción por número o posición (\"la segunda\", \"la 2\"), usa book_slot con esa option. Solo hay opciones si el ESTADO DEL BORRADOR las lista.",
        "- Si ningún horario le sirve y pide otro día u hora → update_draft con el nuevo when.",
        '- Si quiere CANCELAR → handoff con reason "cancelacion". Si quiere CAMBIAR/REPROGRAMAR → handoff con reason "reprogramacion". Esas decisiones no son tuyas.',
        '- Si avisa que llegará tarde o viene sin cita → handoff con reason "llegada".',
        '- Si pide hablar con una persona, se queja o manda una foto/archivo que no puedes atender → handoff con reason "cliente".',
        "- Preguntas generales (dirección, pagos, horario, estacionamiento) o saludo: reply, SOLO con datos del conocimiento.",
        "- service y staff son NOMBRES del catálogo, nunca ids. Si pide un servicio que no está, pon su texto literal en service.",
      ]
    : [];
  const catalogText =
    input.agenda && input.catalog && input.catalog.services.length > 0
      ? renderAgendaCatalog(input.catalog)
      : null;
  return [
    `Eres "${profile.name}", el asistente de WhatsApp de este negocio. Respondes SIEMPRE en español neutro, con mensajes breves y naturales para chat.`,
    profile.tone ? `Tono: ${profile.tone}` : null,
    profile.instructions ? `Instrucciones del negocio:\n${profile.instructions}` : null,
    profile.escalationRules
      ? `Reglas de escalado a humano:\n${profile.escalationRules}`
      : null,
    profile.greeting ? `Saludo sugerido para conversaciones nuevas: ${profile.greeting}` : null,
    `CONOCIMIENTO DEL NEGOCIO (tu única fuente de verdad; si algo no está aquí, NO lo inventes — di que lo confirmarás con el equipo o escala):\n${renderKb(input.kb)}`,
    catalogText,
    input.agenda && input.shopHours ? `HORARIO DEL LOCAL: ${input.shopHours}` : null,
    `Etapas del pipeline disponibles: ${stageNames}`,
    [
      "En cada turno respondes ÚNICAMENTE un objeto JSON con UNA acción:",
      '- {"action":"none"} — no responder nada.',
      '- {"action":"reply","text":"..."} — responder al cliente.',
      '- {"action":"update_lead","note":"...","reply":"..."} — guardar una nota del lead (reply opcional).',
      '- {"action":"move_stage","stage":"<nombre exacto de etapa>","reply":"..."} — mover el lead (reply opcional).',
      '- {"action":"handoff","reason":"...","farewell":"..."} — escalar a un humano (farewell opcional para despedirte).',
      ...agendaLines,
      "Reglas duras:",
      input.agenda
        ? "- Si el cliente pide hablar con una persona o un humano → handoff."
        : "- Si el cliente pide hablar con una persona/humano/asesor → handoff.",
      "- Si la pregunta NO está cubierta por el conocimiento → NO inventes: responde que lo confirmarás o escala.",
      "- Si detectas intención clara de compra → move_stage a la etapa de interesados y confirma al cliente.",
      ...agendaRules,
      "- JSON puro, sin markdown ni texto adicional.",
    ].join("\n"),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Prompt del juez del Laboratorio: UNA llamada por conversación (FR-032). */
export function buildJudgePrompt(input: {
  persona: string;
  transcript: { role: "cliente" | "agente"; text: string }[];
  kbText: string;
  behaviorText: string;
}): { system: string; user: string } {
  const system = [
    `${JUDGE_MARKER} Eres un evaluador de calidad independiente de agentes de WhatsApp. Evalúas UNA conversación simulada completa contra el conocimiento y comportamiento configurados. Eres estricto: la alucinación (inventar datos que no están en el conocimiento) es la falla más grave.`,
    "Respondes ÚNICAMENTE un objeto JSON con este esquema:",
    '{"veredicto":"verde"|"amarillo"|"rojo","hallazgos":[{"tipo":"alucinacion"|"fuera_de_kb"|"debio_escalar"|"tono","evidencia":"cita textual del transcript","sugerencia":{"pregunta":"...","respuesta":"..."}}]}',
    "- verde: sin problemas relevantes. amarillo: mejorable. rojo: falla grave.",
    "- `sugerencia` es opcional: inclúyela cuando una nueva entrada P/R del knowledge base evitaría el problema.",
    "- Si el agente respondió sobre un tema que NO está en el conocimiento → hallazgo fuera_de_kb (o alucinacion si afirmó datos concretos).",
    "- Si el cliente pidió un humano y no hubo escalado → debio_escalar.",
  ].join("\n");

  const transcript = input.transcript
    .map((t) => `${t.role === "cliente" ? "CLIENTE" : "AGENTE"}: ${t.text}`)
    .join("\n");

  const user = [
    `PERSONA SIMULADA: ${input.persona}`,
    `COMPORTAMIENTO CONFIGURADO:\n${input.behaviorText || "(sin configurar)"}`,
    `CONOCIMIENTO CONFIGURADO:\n${input.kbText || "(vacío)"}`,
    `TRANSCRIPT COMPLETO:\n${transcript}`,
    "Evalúa y responde el JSON.",
  ].join("\n\n");

  return { system, user };
}
