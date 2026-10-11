import { z } from "zod";
import { chatJson } from "@/lib/ai";
import { buildJudgePrompt } from "@/server/ai/prompts";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { getShopLocation } from "@/server/agenda/location";
import { testBookingForConversation } from "@/server/agenda/service";

/** Veredicto estructurado del juez (FR-032, contrato ai.md). */
export const Verdict = z.object({
  veredicto: z.enum(["verde", "amarillo", "rojo"]),
  hallazgos: z.array(
    z.object({
      tipo: z.enum(["alucinacion", "fuera_de_kb", "debio_escalar", "tono"]),
      evidencia: z.string(),
      sugerencia: z
        .object({ pregunta: z.string(), respuesta: z.string() })
        .optional(),
    })
  ),
});

export type VerdictType = z.infer<typeof Verdict>;

export type JudgeOutcome =
  | { status: "done"; verdict: VerdictType }
  | { status: "judge_failed"; detail: string };

/**
 * UNA llamada del juez por conversación. Los reintentos viven dentro de
 * chatJson; si aun así la salida es inválida, el caso queda judge_failed —
 * visible en el reporte y excluido del score. La corrida continúa.
 */
export const AGENDA_PERSONAS = new Set([
  "agenda_profesional_nombrado",
  "agenda_todo_en_un_mensaje",
  "agenda_cualquiera",
  "agenda_cualquiera_tarde",
  "agenda_opcion_dos",
  "agenda_servicio_no_ofrecido",
  "agenda_tinte_no_ofrecido",
  "agenda_mi_cita",
]);

/** Personas de escalado: el veredicto sale del motivo del handoff. */
export const HANDOFF_PERSONAS: Record<string, string> = {
  handoff_cancelar: "cancelacion",
  handoff_reprogramar: "reprogramacion",
  handoff_llegada_tarde: "llegada",
  handoff_pide_humano: "cliente",
};

export async function judgeCase(input: {
  personaKey: string;
  transcript: { role: "cliente" | "agente"; text: string }[];
  kbText: string;
  behaviorText: string;
  organizationId?: string;
  conversationId?: string;
}): Promise<JudgeOutcome> {
  if (AGENDA_PERSONAS.has(input.personaKey)) {
    return judgeAgendaCase(input);
  }
  if (input.personaKey in HANDOFF_PERSONAS) {
    return judgeHandoffCase(input);
  }
  const { system, user } = buildJudgePrompt({
    persona: input.personaKey,
    transcript: input.transcript,
    kbText: input.kbText,
    behaviorText: input.behaviorText,
  });
  const result = await chatJson(
    Verdict,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { judge: true }
  );
  if (!result.ok) {
    // Diagnóstico operativo: el caso queda visible como judge_failed y aquí
    // queda el porqué (incluye el raw= truncado del proveedor).
    console.error(
      `[lab] juez falló para ${input.personaKey}: ${result.error} — ${result.detail}`
    );
    return { status: "judge_failed", detail: result.detail };
  }
  return { status: "done", verdict: result.data };
}

/**
 * Las personas de agenda no llaman al modelo: el veredicto sale de la cita
 * guardada (profesional, servicio, duración) y del texto del turno.
 */
async function judgeAgendaCase(input: {
  personaKey: string;
  transcript: { role: "cliente" | "agente"; text: string }[];
  organizationId?: string;
  conversationId?: string;
}): Promise<JudgeOutcome> {
  if (!input.organizationId || !input.conversationId) {
    return {
      status: "judge_failed",
      detail: "faltan organizationId y conversationId",
    };
  }

  const booking = await testBookingForConversation(
    input.organizationId,
    input.conversationId
  );
  const clientes = input.transcript
    .filter((turn) => turn.role === "cliente")
    .map((turn) => turn.text)
    .join("\n")
    .toLowerCase();
  const agentes = input.transcript
    .filter((turn) => turn.role === "agente")
    .map((turn) => turn.text)
    .join("\n");

  const rojo = (evidencia: string): JudgeOutcome => ({
    status: "done",
    verdict: {
      veredicto: "rojo",
      hallazgos: [{ tipo: "alucinacion", evidencia }],
    },
  });
  const verde = (): JudgeOutcome => ({
    status: "done",
    verdict: { veredicto: "verde", hallazgos: [] },
  });

  if (input.personaKey === "agenda_servicio_no_ofrecido") {
    if (booking) {
      return rojo("se creó una cita aunque ese profesional no ofrece el servicio");
    }
    if (!/no ofrece|no hace|ofrecen|no encontré/i.test(agentes)) {
      return rojo("el agente no dijo que ese profesional no ofrece el servicio");
    }
    return verde();
  }

  if (input.personaKey === "agenda_tinte_no_ofrecido") {
    if (booking) return rojo("se creó una cita para un servicio que no se ofrece");
    if (!/no ofrecemos/i.test(agentes)) {
      return rojo("el agente no dijo que ese servicio no se ofrece");
    }
    return verde();
  }

  if (!booking) return rojo("no hay cita de sesión para la conversación");
  if (!booking.isTest) return rojo("la cita de laboratorio no quedó marcada is_test");
  if (
    !booking.serviceName ||
    !clientes.includes(booking.serviceName.toLowerCase())
  ) {
    return rojo("el servicio agendado no es el que pidió el cliente");
  }
  if (
    booking.effectiveDurationMinutes == null ||
    booking.durationMinutes !== booking.effectiveDurationMinutes
  ) {
    return rojo("la duración de la cita no es la efectiva de ese profesional");
  }

  // La confirmación la redacta el código: duración y anticipación incluidas.
  const confirmacion = input.transcript.find(
    (turn) => turn.role === "agente" && turn.text.includes("Cita confirmada")
  )?.text;
  if (!confirmacion) return rojo("el agente no envió la confirmación de la cita");
  if (!confirmacion.includes(`(${booking.durationMinutes} min)`)) {
    return rojo("la confirmación no trae la duración de la cita");
  }
  const location = await getShopLocation(input.organizationId);
  if (location.arrivalLeadMinutes > 0 && !/minutos? antes/i.test(confirmacion)) {
    return rojo("la confirmación no pide llegar con anticipación");
  }

  const nombrado = [
    "agenda_profesional_nombrado",
    "agenda_todo_en_un_mensaje",
    "agenda_opcion_dos",
    "agenda_mi_cita",
  ];
  if (nombrado.includes(input.personaKey)) {
    if (
      !booking.staffName ||
      !clientes.includes(booking.staffName.toLowerCase())
    ) {
      return rojo("el profesional agendado no es el que nombró el cliente");
    }
    if (input.personaKey === "agenda_mi_cita") {
      const ultima = input.transcript.filter((turn) => turn.role === "agente").at(-1)?.text ?? "";
      if (!ultima.includes(booking.staffName) || !/\d+ min/.test(ultima)) {
        return rojo("al preguntar por su cita, el agente no la describió con profesional y duración");
      }
    }
    return verde();
  }

  if (
    input.personaKey === "agenda_cualquiera" ||
    input.personaKey === "agenda_cualquiera_tarde"
  ) {
    if (/qui[eé]n|con qui[eé]n|qu[eé] profesional/i.test(agentes)) {
      return rojo("el agente preguntó con quién agendar");
    }
    return verde();
  }

  return { status: "judge_failed", detail: "persona de agenda desconocida" };
}

/**
 * Las personas de escalado no llaman al modelo: el veredicto sale del motivo
 * con que quedó marcada la conversación.
 */
async function judgeHandoffCase(input: {
  personaKey: string;
  organizationId?: string;
  conversationId?: string;
}): Promise<JudgeOutcome> {
  if (!input.organizationId || !input.conversationId) {
    return { status: "judge_failed", detail: "faltan organizationId y conversationId" };
  }
  const expected = HANDOFF_PERSONAS[input.personaKey];
  const [row] = await getDb()
    .select({
      handoffAt: schema.conversation.handoffAt,
      handoffReason: schema.conversation.handoffReason,
    })
    .from(schema.conversation)
    .where(
      scoped(
        schema.conversation.organizationId,
        input.organizationId,
        eq(schema.conversation.id, input.conversationId)
      )
    )
    .limit(1);
  if (row?.handoffAt && row.handoffReason === expected) {
    return { status: "done", verdict: { veredicto: "verde", hallazgos: [] } };
  }
  const evidencia = row?.handoffAt
    ? `se escaló con motivo «${row.handoffReason}» y debía ser «${expected}»`
    : `no se escaló; debía pasar a una persona con motivo «${expected}»`;
  return {
    status: "done",
    verdict: { veredicto: "rojo", hallazgos: [{ tipo: "debio_escalar", evidencia }] },
  };
}

/**
 * Score 0-100: % ponderado de conversaciones verdes (FR-033).
 * verde = 1 · amarillo = 0.5 · rojo = 0. judge_failed fuera del denominador.
 */
export function computeScore(
  cases: { status: string; veredicto: string | null }[]
): number | null {
  const judged = cases.filter(
    (c) => c.status === "done" && c.veredicto !== null
  );
  if (judged.length === 0) return null;
  const points = judged.reduce((acc, c) => {
    if (c.veredicto === "verde") return acc + 1;
    if (c.veredicto === "amarillo") return acc + 0.5;
    return acc;
  }, 0);
  return Math.round((100 * points) / judged.length);
}
