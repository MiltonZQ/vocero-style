import type { DraftStep } from "@/server/agenda/draft";
import type { AgendaModelAction } from "@/server/ai/actions";

/**
 * 019 — Guardas del agente: validan en CÓDIGO que la acción del modelo tenga
 * sentido para el paso actual de la reserva. Si no, devuelven la directiva
 * del paso que falta en lugar de ejecutar la acción. Puro: sin BD.
 */

export type HandoffReason =
  | "cancelacion"
  | "reprogramacion"
  | "llegada"
  | "cliente"
  | "atascado"
  | "error";

/**
 * Una sola fuente de verdad: las acciones de agenda son las del esquema Zod de
 * `actions.ts`; el resto (lead, etapa, none) pasa sin validación de paso.
 */
export type BotAction =
  | AgendaModelAction
  | { action: "none" | "update_lead" | "move_stage"; [field: string]: unknown };

export type GuardContext = {
  draft: { serviceId: string | null; staffChoice: string | null };
  /** Cuántas opciones vigentes tiene la conversación (`offered_slot`). */
  offerCount: number;
};

/** Qué debe hacer el código en lugar de la acción del modelo. */
export type Directive =
  | { type: "ask_service"; reason: string }
  | { type: "ask_staff"; reason: string }
  | { type: "offer_slots"; reason: string }
  | { type: "ask_option"; reason: string };

export type GuardResult =
  | { kind: "run"; action: BotAction }
  | { kind: "redirect"; directive: Directive };

const redirect = (directive: Directive): GuardResult => ({ kind: "redirect", directive });

/** La directiva del paso que falta cuando una acción llega demasiado pronto. */
const DIRECTIVE_FOR_STEP: Record<Exclude<DraftStep, "ready">, Directive> = {
  need_service: { type: "ask_service", reason: "no service chosen yet" },
  need_staff: { type: "ask_staff", reason: "no professional chosen yet" },
  need_slot: { type: "offer_slots", reason: "no slots have been offered yet" },
};

export function guardAction(action: BotAction, step: DraftStep, ctx: GuardContext): GuardResult {
  switch (action.action) {
    case "book_slot": {
      if (step !== "ready" || ctx.offerCount === 0) {
        return redirect(DIRECTIVE_FOR_STEP[step === "ready" ? "need_slot" : step]);
      }
      const n = action.option;
      if (!Number.isInteger(n) || n < 1 || n > ctx.offerCount) {
        return redirect({ type: "ask_option", reason: `option ${String(n)} is not one of the offers` });
      }
      return { kind: "run", action };
    }
    case "update_draft": {
      // Elegir profesional sin servicio no tiene sentido: la lista depende del servicio.
      if (action.staff && !action.service && !ctx.draft.serviceId) {
        return redirect(DIRECTIVE_FOR_STEP.need_service);
      }
      return { kind: "run", action };
    }
    default:
      return { kind: "run", action };
  }
}
