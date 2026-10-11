import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";

/**
 * 020 — Bitácora de eventos del bot (solo anexar).
 *
 * Registrar es BEST-EFFORT: un insert que falla escribe un `console.warn` y
 * jamás cambia ni bloquea el turno. Los payloads no llevan cuerpos de mensaje,
 * teléfonos ni secretos (el único texto del cliente, `service_not_found.text`,
 * se corta a 60 caracteres).
 */

export type StaffChoice = string | "any";
export type SlotsFallback = "none" | "nearest" | "other_staff" | "today_empty";

type Window = { day?: string; from?: string; to?: string };

export type BotEvent =
  | {
      type: "turn_completed";
      payload: {
        action: string;
        latencyMs: number;
        model: string;
        costUsd?: number;
        promptTokens?: number;
        completionTokens?: number;
      };
    }
  | { type: "greeted"; payload: Record<string, never> }
  | { type: "services_listed"; payload: Record<string, never> }
  | { type: "location_sent"; payload: { pin: boolean } }
  | { type: "my_bookings"; payload: Record<string, never> }
  | { type: "service_selected"; payload: { serviceId: string } }
  | { type: "service_not_found"; payload: { text: string } }
  | { type: "service_unavailable"; payload: { serviceId: string } }
  | { type: "staff_selected"; payload: { staffId: StaffChoice; auto: boolean } }
  | {
      type: "slots_offered";
      payload: Window & {
        serviceId: string;
        staffChoice: StaffChoice;
        count: number;
        fallback: SlotsFallback;
      };
    }
  | { type: "no_availability"; payload: Window & { serviceId: string; staffChoice: StaffChoice } }
  | {
      type: "booked";
      payload: {
        bookingId: string;
        serviceId: string;
        staffId: string;
        priceCents: number;
        currency: string;
      };
    }
  | { type: "handoff"; payload: { reason: string } }
  | { type: "llm_failed"; payload: { consecutive: number } };

export type BotEventType = BotEvent["type"];

export type BotEventContext = {
  organizationId: string;
  conversationId: string;
  contactId: string | null;
  isTest: boolean;
};

const MAX_TEXT = 60;

/** La conversación es la fuente de `is_test`, contacto y organización. */
export function botEventContext(conversation: {
  id: string;
  organizationId: string;
  contactId: string | null;
  isTest: boolean;
}): BotEventContext {
  return {
    organizationId: conversation.organizationId,
    conversationId: conversation.id,
    contactId: conversation.contactId,
    isTest: conversation.isTest,
  };
}

function sanitize(event: BotEvent): BotEvent {
  if (event.type === "service_not_found") {
    return { type: event.type, payload: { text: event.payload.text.slice(0, MAX_TEXT) } };
  }
  return event;
}

type Timed = { event: BotEvent; at: Date };

async function insertAll(ctx: BotEventContext, items: Timed[]): Promise<void> {
  if (items.length === 0) return;
  try {
    // Constitución III: la conversación tiene que ser de la organización del
    // contexto; un contexto cruzado no escribe nada.
    const owner = await getDb()
      .select({ id: schema.conversation.id })
      .from(schema.conversation)
      .where(
        scoped(
          schema.conversation.organizationId,
          ctx.organizationId,
          eq(schema.conversation.id, ctx.conversationId)
        )
      )
      .limit(1);
    if (!owner[0]) throw new Error("conversación fuera de la organización");
    await getDb()
      .insert(schema.botEvent)
      .values(
        items.map(({ event, at }) => {
          const clean = sanitize(event);
          return {
            id: newId("botEvent"),
            organizationId: ctx.organizationId,
            conversationId: ctx.conversationId,
            contactId: ctx.contactId,
            type: clean.type,
            payload: clean.payload as Record<string, unknown>,
            isTest: ctx.isTest,
            createdAt: at,
          };
        })
      );
  } catch (err) {
    // Sin payload en el log: podría traer texto del cliente.
    const reason = err instanceof Error ? err.message : String(err);
    const types = [...new Set(items.map((i) => i.event.type))].join(",");
    console.warn("[bot-event] no se pudo registrar", types, reason);
  }
}

/** Registra un evento. Nunca lanza. */
export async function recordBotEvent(ctx: BotEventContext, event: BotEvent): Promise<void> {
  await insertAll(ctx, [{ event, at: new Date() }]);
}

/** Registra varios eventos en orden (un solo insert). Nunca lanza. */
export async function recordBotEvents(ctx: BotEventContext, events: BotEvent[]): Promise<void> {
  const base = Date.now();
  await insertAll(
    ctx,
    events.map((event, i) => ({ event, at: new Date(base + i) }))
  );
}

export type TurnCompletion = Omit<
  Extract<BotEvent, { type: "turn_completed" }>["payload"],
  "latencyMs"
>;

/**
 * Acumula los eventos de UN turno y los escribe al final, DESPUÉS de enviar la
 * respuesta: el cliente nunca espera por la bitácora y el orden queda fijo
 * (cada evento lleva su marca de tiempo y `turn_completed` va al final con la
 * latencia del turno completo).
 */
export function createTurnRecorder() {
  let ctx: BotEventContext | null = null;
  const items: Timed[] = [];
  let completion: TurnCompletion | null = null;
  let last = 0;

  const stamp = (): Date => {
    last = Math.max(Date.now(), last + 1);
    return new Date(last);
  };

  return {
    bind(next: BotEventContext): void {
      ctx = next;
    },
    add(event: BotEvent): void {
      items.push({ event, at: stamp() });
    },
    /** El turno llamó al modelo y obtuvo una acción: se emite `turn_completed` en `flush`. */
    complete(next: TurnCompletion): void {
      completion = next;
    },
    async flush(latencyMs: number): Promise<void> {
      try {
        if (!ctx) return;
        if (completion) {
          items.push({
            event: { type: "turn_completed", payload: { ...completion, latencyMs } },
            at: stamp(),
          });
        }
        await insertAll(ctx, items.splice(0));
      } catch (err) {
        console.warn("[bot-event] flush falló", err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export type TurnRecorder = ReturnType<typeof createTurnRecorder>;

/** Lectura con scope de tenant (tests, e2e y las métricas futuras). */
export async function listBotEvents(
  organizationId: string,
  filter: { conversationId?: string; type?: BotEventType } = {}
) {
  return getDb()
    .select()
    .from(schema.botEvent)
    .where(
      scoped(
        schema.botEvent.organizationId,
        organizationId,
        filter.conversationId ? eq(schema.botEvent.conversationId, filter.conversationId) : undefined,
        filter.type ? eq(schema.botEvent.type, filter.type) : undefined
      )
    )
    .orderBy(asc(schema.botEvent.createdAt), asc(schema.botEvent.id));
}
