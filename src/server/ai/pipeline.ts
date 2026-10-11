import { asc, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { moveLeadToStage as moveLeadThroughHistory } from "@/server/leads/stage-history";
import { getEnv, isAiConfigured } from "@/lib/env";
import { chatJson, type ChatMessage } from "@/lib/ai";
import { publish } from "@/server/events/bus";
import { isWindowOpen } from "@/server/inbox/window";
import { SendError, sendStructured, sendText } from "@/server/inbox/send";
import {
  agentActionSchema,
  degradeAction,
  resolveStage,
  type AgentActionType,
} from "@/server/ai/actions";
import { matchesHandoffIntent } from "@/server/ai/handoff";
import { buildAgentSystemPrompt, formatShopHours } from "@/server/ai/prompts";
import { agendaEnabled } from "@/server/agenda/flag";
import { loadActiveCatalog } from "@/server/agenda/agent";
import {
  loadAgendaContext,
  loadAgendaState,
  renderDraftState,
  runAgendaAction,
  runAgendaFailure,
  type AgendaContext,
  type AgendaDeps,
  type AgendaState,
  type LocationPin,
} from "@/server/ai/agenda-turn";
import { readMediaFile } from "@/server/whatsapp/media";
import { transcribeAudio } from "@/server/ai/transcribe";
import { showTyping } from "@/server/whatsapp/typing";

/**
 * Turno del agente (FR-021..FR-025).
 *
 * Coalesce + lock in-process por conversación: ráfagas de mensajes → UNA
 * respuesta; nunca dos turnos simultáneos; lo que llega durante un turno
 * re-encola exactamente un turno más. Suficiente para el monolito de una
 * instancia (sin colas externas — Constitución II).
 */

type CoalesceEntry = {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  pending: boolean;
};

const globalForAgent = globalThis as unknown as {
  __agentCoalesce?: Map<string, CoalesceEntry>;
};

function coalesceMap(): Map<string, CoalesceEntry> {
  if (!globalForAgent.__agentCoalesce) {
    globalForAgent.__agentCoalesce = new Map();
  }
  return globalForAgent.__agentCoalesce;
}

/** Punto de entrada con debounce (mensajes entrantes reales). */
export function scheduleAgentTurn(conversationId: string): void {
  const map = coalesceMap();
  const entry = map.get(conversationId) ?? {
    timer: null,
    running: false,
    pending: false,
  };
  map.set(conversationId, entry);

  if (entry.running) {
    entry.pending = true; // se re-encola al terminar el turno actual
    return;
  }
  if (entry.timer) clearTimeout(entry.timer);
  const delay = getEnv().AGENT_COALESCE_MS;
  entry.timer = setTimeout(() => {
    entry.timer = null;
    void executeTurn(conversationId);
  }, delay);
}

async function executeTurn(conversationId: string): Promise<void> {
  const map = coalesceMap();
  const entry = map.get(conversationId);
  if (!entry || entry.running) return;
  entry.running = true;
  try {
    await runAgentTurn(conversationId);
  } catch (err) {
    console.error("[agente] turno falló:", err);
  } finally {
    entry.running = false;
    if (entry.pending) {
      entry.pending = false;
      void executeTurn(conversationId);
    } else {
      map.delete(conversationId);
    }
  }
}

/**
 * Ejecuta UN turno del agente ahora (el Laboratorio lo llama directo, con
 * debounce 0 y sin pasar por el coalesce).
 */
export async function runAgentTurn(conversationId: string): Promise<void> {
  if (!isAiConfigured()) return;

  const db = getDb();
  const convRows = await db
    .select()
    .from(schema.conversation)
    .where(eq(schema.conversation.id, conversationId))
    .limit(1);
  const conversation = convRows[0];
  if (!conversation) return;
  const organizationId = conversation.organizationId;

  // Condiciones de silencio: handoff activo o IA apagada en la conversación.
  if (conversation.handoffAt || !conversation.aiEnabled) return;

  const profileRows = await db
    .select()
    .from(schema.agentProfile)
    .where(eq(schema.agentProfile.organizationId, organizationId))
    .limit(1);
  const profile = profileRows[0];
  if (!profile) return;
  // El toggle global aplica a conversaciones reales; el Laboratorio evalúa el
  // comportamiento configurado aunque el agente aún no esté encendido.
  if (!conversation.isTest && !profile.enabled) return;

  const history = await db
    .select()
    .from(schema.message)
    .where(eq(schema.message.conversationId, conversationId))
    .orderBy(desc(schema.message.createdAt))
    .limit(20);
  history.reverse();
  const lastInbound = [...history].reverse().find((m) => m.direction === "in");
  if (!lastInbound) return;

  // Ventana cerrada: el agente JAMÁS envía texto libre → handoff 'ventana'.
  if (!conversation.isTest && !isWindowOpen(conversation.lastInboundAt)) {
    await applyHandoff(conversationId, organizationId, "ventana");
    return;
  }

  // 019 — "leído" + "escribiendo…" mientras el agente trabaja (también cubre la
  // transcripción). Solo conversaciones reales; el Laboratorio jamás toca Meta.
  if (!conversation.isTest && lastInbound.waMessageId) {
    await typingBestEffort(organizationId, lastInbound.waMessageId);
  }

  if (
    lastInbound.type === "audio" &&
    !lastInbound.text &&
    lastInbound.mediaAssetId
  ) {
    try {
      const assetRows = await db
        .select()
        .from(schema.mediaAsset)
        .where(eq(schema.mediaAsset.id, lastInbound.mediaAssetId))
        .limit(1);
      const asset = assetRows[0];
      if (asset && asset.storagePath) {
        const data = await readMediaFile(organizationId, asset.id);
        const transcript = await transcribeAudio(data, asset.mimeType);
        if (transcript) {
          const formatted = `[Nota de voz]: ${transcript}`;
          lastInbound.text = formatted;
          await db
            .update(schema.message)
            .set({ text: formatted })
            .where(eq(schema.message.id, lastInbound.id));
        }
      }
    } catch (err) {
      console.warn("[agente] no se pudo transcribir audio entrante on-demand:", err);
    }
  }

  // 019 — Una nota de voz que no se pudo transcribir no llega al modelo (no
  // habría nada que leer): se le pide al cliente que escriba. Sin escalar.
  if (lastInbound.type === "audio" && !lastInbound.text) {
    await deliverReply(conversation, VOICE_FALLBACK_TEXT);
    return;
  }

  // Patrón de respaldo ANTES del LLM (FR-022).
  if (lastInbound.text && matchesHandoffIntent(lastInbound.text)) {
    await applyHandoff(conversationId, organizationId, "cliente");
    return;
  }

  const kb = await db
    .select()
    .from(schema.kbEntry)
    .where(eq(schema.kbEntry.organizationId, organizationId))
    .orderBy(asc(schema.kbEntry.createdAt));
  const stages = await db
    .select({ id: schema.pipelineStage.id, name: schema.pipelineStage.name })
    .from(schema.pipelineStage)
    .where(eq(schema.pipelineStage.organizationId, organizationId))
    .orderBy(asc(schema.pipelineStage.position));

  const agenda = agendaEnabled();
  const catalog = agenda ? await loadActiveCatalog(organizationId) : undefined;

  /**
   * 019 — Con la agenda encendida, el borrador de la conversación manda: el
   * modelo ve el estado de AHORA (fecha de hoy, borrador, opciones numeradas)
   * al FINAL, después del historial, y el código ofrece y reserva. Apagada, el
   * turno es el de siempre.
   */
  let agendaCtx: AgendaContext | undefined;
  let agendaState: AgendaState | undefined;
  if (agenda && catalog) {
    agendaCtx = await loadAgendaContext(conversation, catalog);
    agendaState = await loadAgendaState(agendaCtx);
  }
  const agendaDeps: AgendaDeps = {
    deliver: (text) => deliverReply(conversation, text),
    deliverLocation: (pin) => deliverLocationPin(conversation, pin),
    handoff: (reason) => applyHandoff(conversationId, organizationId, reason),
    notifyBooked: () =>
      publish(organizationId, {
        type: "conversation.updated",
        data: { conversation: { id: conversationId } },
      }),
  };

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: buildAgentSystemPrompt({
        profile,
        kb,
        stages,
        agenda,
        shopHours: agendaCtx ? formatShopHours(agendaCtx.settings.weeklyHours) : undefined,
        catalog: catalog
          ? {
              services: catalog.services.map((service) => ({
                name: service.name,
                durationMinutes: service.durationMinutes,
                priceCents: service.priceCents,
                currency: service.currency,
                staff: service.staff.map((person) => ({
                  displayName: person.displayName,
                  jobTitle: person.jobTitle,
                })),
              })),
            }
          : undefined,
      }),
    },
    ...history
      .filter((m) => m.text)
      .map((m) => ({
        role: m.direction === "in" ? ("user" as const) : ("assistant" as const),
        content: m.text!,
      })),
    ...(agendaCtx && agendaState
      ? [{ role: "system" as const, content: renderDraftState(agendaState, agendaCtx) }]
      : []),
  ];

  let result;
  try {
    result = await chatJson(agentActionSchema(agenda), messages);
  } catch (err) {
    console.error(`[agente] fallo del proveedor: ${err}`);
    if (agendaCtx && agendaState) {
      await runAgendaFailure(agendaState, agendaCtx, agendaDeps);
      return;
    }
    await applyHandoff(conversationId, organizationId, "error");
    return;
  }
  if (!result.ok) {
    if (result.error === "not_configured") return;
    // Fallo persistente del proveedor o salida imposible → escalar (FR-022).
    console.error(`[agente] fallo del proveedor (raw): ${result.detail}`);
    if (agendaCtx && agendaState) {
      // 019: se re-pregunta el paso; solo el segundo fallo seguido escala.
      await runAgendaFailure(agendaState, agendaCtx, agendaDeps);
      return;
    }
    await applyHandoff(conversationId, organizationId, "error");
    return;
  }

  let action: AgentActionType = result.data;

  // 019 — Agenda. Un fallo del motor degrada el turno (responde sin agendar),
  // nunca lo tumba: quedarse callado es peor que no agendar.
  if (agendaCtx && agendaState) {
    const outcome = await runAgendaAction(action, agendaState, agendaCtx, agendaDeps);
    if (outcome.kind === "sent") return;
  } else if (
    action.action === "update_draft" ||
    action.action === "book_slot" ||
    action.action === "my_bookings"
  ) {
    action = degradeAction(action);
  }

  if (action.action === "move_stage") {
    const stage = resolveStage(action.stage, stages);
    if (!stage) {
      action = degradeAction(action);
    } else {
      await moveLeadToStage(organizationId, conversation.contactId, stage.id);
      publish(organizationId, {
        type: "conversation.updated",
        data: { conversation: { id: conversationId } },
      });
      if (action.reply) {
        await deliverReply(conversation, action.reply);
      }
      return;
    }
  }

  switch (action.action) {
    case "none":
      return;
    case "reply":
      await deliverReply(conversation, action.text);
      return;
    case "update_lead": {
      await appendLeadNote(organizationId, conversation.contactId, action.note);
      if (action.reply) await deliverReply(conversation, action.reply);
      return;
    }
    case "handoff": {
      if (action.farewell) {
        await deliverReply(conversation, action.farewell);
      }
      await applyHandoff(
        conversationId,
        organizationId,
        agenda ? toAgendaHandoffReason(action.reason) : "modelo"
      );
      return;
    }
    default:
      return;
  }
}

type Conversation = typeof schema.conversation.$inferSelect;

const VOICE_FALLBACK_TEXT =
  "No pude escuchar bien tu nota de voz. ¿Podrías escribirme lo que necesitas?";

/** Tope para el indicador: un Meta lento no puede retener el turno del agente. */
const TYPING_TIMEOUT_MS = 3000;

/** "Escribiendo…" best-effort: se registra el fallo y el turno sigue. */
async function typingBestEffort(
  organizationId: string,
  waMessageId: string
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      showTyping(organizationId, waMessageId),
      new Promise<{ ok: false; reason: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), TYPING_TIMEOUT_MS);
      }),
    ]);
    if (!result.ok) {
      console.warn(`[agente] no se pudo mostrar "escribiendo…": ${result.reason}`);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Entrega la respuesta: envío real o persistencia sandbox (is_test). */
async function deliverReply(
  conversation: Conversation,
  text: string
): Promise<void> {
  if (conversation.isTest) {
    await persistTestOutbound(conversation, text);
    return;
  }
  try {
    await sendText({
      conversationId: conversation.id,
      organizationId: conversation.organizationId,
      text,
      aiGenerated: true,
    });
  } catch (err) {
    if (err instanceof SendError && err.code === "window_closed") {
      await applyHandoff(conversation.id, conversation.organizationId, "ventana");
      return;
    }
    throw err;
  }
}

/**
 * 019 — El pin del local. Misma regla que el texto: una conversación de prueba
 * se persiste y JAMÁS toca la API; una real pasa por el pre-flight común del
 * sender (ventana de 24 h, credenciales, destinatario).
 */
async function deliverLocationPin(
  conversation: Conversation,
  pin: LocationPin
): Promise<void> {
  if (conversation.isTest) {
    await persistTestLocation(conversation, pin);
    return;
  }
  await sendStructured({
    conversationId: conversation.id,
    organizationId: conversation.organizationId,
    kind: "location",
    location: pin,
    aiGenerated: true,
  });
}

/** Pin saliente del sandbox: se guarda como cualquier ubicación, sin red. */
async function persistTestLocation(
  conversation: Conversation,
  pin: LocationPin
): Promise<void> {
  const db = getDb();
  const assetId = newId("mediaAsset");
  await db.insert(schema.mediaAsset).values({
    id: assetId,
    organizationId: conversation.organizationId,
    kind: "location",
    payload: pin,
    fetchStatus: "available",
  });
  await db.insert(schema.message).values({
    id: newId("message"),
    organizationId: conversation.organizationId,
    conversationId: conversation.id,
    direction: "out",
    type: "location",
    text: null,
    status: "sent",
    aiGenerated: true,
    origin: "ai",
    mediaAssetId: assetId,
  });
  await db
    .update(schema.conversation)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.conversation.id, conversation.id));
}

/** Mensaje saliente del sandbox: se persiste, JAMÁS toca la API (FR-031). */
async function persistTestOutbound(
  conversation: Conversation,
  text: string
): Promise<void> {
  const db = getDb();
  await db.insert(schema.message).values({
    id: newId("message"),
    organizationId: conversation.organizationId,
    conversationId: conversation.id,
    direction: "out",
    type: "text",
    text,
    status: "sent",
    aiGenerated: true,
    origin: "ai",
  });
  await db
    .update(schema.conversation)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.conversation.id, conversation.id));
}

/** Motivos que el modelo puede dar con la agenda encendida (019). */
const AGENDA_HANDOFF_REASONS = [
  "cancelacion",
  "reprogramacion",
  "llegada",
  "cliente",
] as const;

/** Un motivo desconocido no cuesta el handoff: cae en `modelo`. */
function toAgendaHandoffReason(
  raw: string | undefined
): (typeof AGENDA_HANDOFF_REASONS)[number] | "modelo" {
  const reason = raw?.trim().toLowerCase();
  return AGENDA_HANDOFF_REASONS.find((r) => r === reason) ?? "modelo";
}

export async function applyHandoff(
  conversationId: string,
  organizationId: string,
  reason:
    | "cliente"
    | "modelo"
    | "error"
    | "ventana"
    | "cancelacion"
    | "reprogramacion"
    | "llegada"
    | "atascado"
): Promise<void> {
  const db = getDb();
  const updated = await db
    .update(schema.conversation)
    .set({ handoffAt: new Date(), handoffReason: reason, updatedAt: new Date() })
    .where(eq(schema.conversation.id, conversationId))
    .returning();
  if (!updated[0]) return;
  publish(organizationId, {
    type: "conversation.updated",
    data: {
      conversation: { id: conversationId, handoffReason: reason },
    },
  });
}

async function moveLeadToStage(
  organizationId: string,
  contactId: string,
  stageId: string
): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.lead.id })
    .from(schema.lead)
    .where(
      scoped(
        schema.lead.organizationId,
        organizationId,
        eq(schema.lead.contactId, contactId)
      )
    )
    .limit(1);
  const leadId = rows[0]?.id;
  if (!leadId) return;

  // Por la puerta única: el agente mueve tarjetas igual que el dueño, y su
  // movimiento tiene que quedar en la bitácora o el embudo mentirá sobre
  // quién hizo avanzar cada lead.
  await moveLeadThroughHistory({
    organizationId,
    leadId,
    toStageId: stageId,
    source: "bot",
    extra: { lastActivityAt: new Date() },
    // El agente no clasifica pérdidas: si su etapa destino resultara ser la
    // perdida, la puerta lo rechaza y el lead se queda donde está — mejor eso
    // que un motivo inventado.
  });
}

async function appendLeadNote(
  organizationId: string,
  contactId: string,
  note: string
): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.contact.id, notes: schema.contact.notes })
    .from(schema.contact)
    .where(eq(schema.contact.id, contactId))
    .limit(1);
  const contact = rows[0];
  if (!contact) return;
  const stamped = `[IA] ${note}`;
  await db
    .update(schema.contact)
    .set({
      notes: contact.notes ? `${contact.notes}\n${stamped}` : stamped,
      updatedAt: new Date(),
    })
    .where(eq(schema.contact.id, contact.id));
}
