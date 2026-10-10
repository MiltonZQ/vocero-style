import { EventEmitter } from "node:events";
import type { Actor } from "@/lib/auth/actor";

/**
 * Bus de eventos in-process por organización (contrato sse.md).
 * Publicar SIEMPRE después del commit de BD. Una instancia = un proceso,
 * así que un EventEmitter es suficiente (sin colas externas — Constitución II).
 */

export type SseEvent =
  | { type: "message.new"; data: { conversationId: string; message: unknown } }
  | {
      type: "message.status";
      data: {
        conversationId: string;
        messageId: string;
        status: string;
        /** Motivo del fallo, presente solo cuando status = "failed". */
        error?: string | null;
      };
    }
  | { type: "conversation.updated"; data: { conversation: unknown } }
  /**
   * 015 — algo cambió en la agenda: la pantalla de Citas se refresca sola.
   * 018 — lleva a quién pertenece, SIN datos del cliente, para que el SSE
   * pueda filtrar en el servidor: `scope` "shop" = bloqueo del local
   * (`staffId` nulo, lo ven todos); "staff" = de un profesional; "own" se
   * reserva para el stream de un profesional (mismo filtro que "staff").
   */
  | {
      type: "booking.updated";
      data: {
        bookingId: string;
        staffId: string | null;
        scope: "own" | "shop" | "staff";
      };
    }
  | {
      type: "lab.run";
      data: {
        runId: string;
        status: string;
        progress: { done: number; total: number };
        score?: number | null;
      };
    };

const globalForBus = globalThis as unknown as { __voceroBus?: EventEmitter };

function getBus(): EventEmitter {
  if (!globalForBus.__voceroBus) {
    const bus = new EventEmitter();
    bus.setMaxListeners(200);
    globalForBus.__voceroBus = bus;
  }
  return globalForBus.__voceroBus;
}

export function publish(organizationId: string, event: SseEvent): void {
  getBus().emit(`org:${organizationId}`, event);
}

export function subscribe(
  organizationId: string,
  listener: (event: SseEvent) => void
): () => void {
  const bus = getBus();
  const channel = `org:${organizationId}`;
  bus.on(channel, listener);
  return () => bus.off(channel, listener);
}

/**
 * Filtro del SSE por actor, aplicado en el SERVIDOR (018 T070). owner y
 * reception reciben todo; staff solo `booking.updated` propio o del local; un
 * staff sin perfil no recibe nada.
 */
export function eventVisibleTo(actor: Actor, event: SseEvent): boolean {
  if (actor.role !== "staff") return true;
  if (!actor.staffId) return false;
  if (event.type !== "booking.updated") return false;
  return event.data.scope === "shop" || event.data.staffId === actor.staffId;
}
