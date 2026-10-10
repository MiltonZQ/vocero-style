import { z } from "zod";
import { chatJson } from "@/lib/ai";
import { buildJudgePrompt } from "@/server/ai/prompts";
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
const AGENDA_PERSONAS = new Set([
  "agenda_profesional_nombrado",
  "agenda_cualquiera",
  "agenda_servicio_no_ofrecido",
]);

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
    if (!/no ofrece|ofrecen|no encontré/i.test(agentes)) {
      return rojo("el agente no dijo que ese profesional no ofrece el servicio");
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

  if (input.personaKey === "agenda_profesional_nombrado") {
    if (
      !booking.staffName ||
      !clientes.includes(booking.staffName.toLowerCase())
    ) {
      return rojo("el profesional agendado no es el que nombró el cliente");
    }
    return verde();
  }

  if (input.personaKey === "agenda_cualquiera") {
    if (/qui[eé]n|con qui[eé]n|qu[eé] profesional/i.test(agentes)) {
      return rojo("el agente preguntó con quién agendar");
    }
    return verde();
  }

  return { status: "judge_failed", detail: "persona de agenda desconocida" };
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
