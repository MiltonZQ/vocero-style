import type { schema } from "@/lib/db";
import type { AgendaCatalog, AgendaCatalogService } from "@/server/agenda/agent";
import { bookFromOffer } from "@/server/agenda/agent";
import { AgendaHttpError } from "@/server/agenda/http";
import { BookingError } from "@/server/agenda/booking-error";
import {
  buildCatalogMessage,
  buildConfirmation,
  buildStaffChoiceMessage,
} from "@/server/agenda/confirmation";
import {
  clearDraft,
  deriveStep,
  getDraft,
  upsertDraft,
  type BookingDraft,
  type DraftStep,
  type DraftWhen,
} from "@/server/agenda/draft";
import { getShopLocation } from "@/server/agenda/location";
import { isAnyStaff, matchByName } from "@/server/agenda/match";
import {
  buildMyBookingsMessage,
  existingBookingNotice,
  listUpcomingBookings,
} from "@/server/agenda/my-bookings";
import { clearOffers, getOffers, type OfferedSlot } from "@/server/agenda/offers";
import { offerByPreference, SHOWN_OPTIONS } from "@/server/agenda/preference-offers";
import { getSettings, type CalendarSettings } from "@/server/agenda/settings";
import type { AgentActionType } from "@/server/ai/actions";
import { guardAction, type BotAction, type Directive } from "@/server/ai/guards";
import { buildDraftStateBlock } from "@/server/ai/prompts";

/**
 * 019 — El turno del bot de barbería, del lado del CÓDIGO.
 *
 * El modelo solo dice qué decidió el cliente (`update_draft`) y qué opción
 * numerada eligió (`book_slot`). Aquí se resuelven los nombres contra el
 * catálogo, se guarda el borrador, se avanza al paso que falta y se redactan
 * los mensajes: lo que el cliente lee de horarios, precios y confirmación
 * nunca lo escribe el modelo.
 *
 * Un turno envía A LO MÁS un mensaje (como el agente de siempre): los
 * manejadores devuelven texto y `runAgendaAction` lo entrega una vez.
 */

type Conversation = typeof schema.conversation.$inferSelect;

/** Turnos seguidos sin avance antes de pasar la conversación a una persona. */
export const STUCK_LIMIT = 3;
/** Turnos seguidos en que el modelo falla antes de escalar por error. */
export const FAILED_LIMIT = 2;

const STUCK_TEXT =
  "No estoy logrando ayudarte con esto por aquí. Te paso con alguien del equipo para que te atienda.";
const GENERIC_ERROR_TEXT =
  "No pude agendarlo en este momento. Lo reviso con el equipo y te confirmo.";
const PICK_TEXT = "Responde con el número de la opción que prefieras, o dime otro día u hora.";

export type AgendaDeps = {
  deliver(text: string): Promise<void>;
  handoff(reason: "atascado" | "error"): Promise<void>;
  /** La cita quedó registrada: refresca la bandeja. */
  notifyBooked(): void;
};

export type AgendaState = {
  draft: BookingDraft | null;
  offers: OfferedSlot[];
  step: DraftStep;
};

export type AgendaContext = {
  conversation: Conversation;
  catalog: AgendaCatalog;
  settings: CalendarSettings;
  now: Date;
};

export type AgendaOutcome =
  | { kind: "sent" }
  /** Lo atiende el manejador común del pipeline (reply, lead, etapa, handoff). */
  | { kind: "delegate" };

/* ----------------------------- state ----------------------------- */

export async function loadAgendaState(
  ctx: Pick<AgendaContext, "conversation">
): Promise<AgendaState> {
  const { organizationId, id: conversationId } = ctx.conversation;
  const draft = await getDraft(organizationId, conversationId);
  let offers = await getOffers(organizationId, conversationId);
  const stale =
    offers.length > 0 &&
    (!draft?.serviceId ||
      !draft.staffChoice ||
      offers.some((o) => o.serviceId && o.serviceId !== draft.serviceId));
  if (stale) {
    await clearOffers(organizationId, conversationId);
    offers = [];
  }
  const step = deriveStep(
    { serviceId: draft?.serviceId ?? null, staffChoice: draft?.staffChoice ?? null },
    { hasOffers: offers.length > 0 }
  );
  return { draft, offers, step };
}

function signature(state: AgendaState): string {
  const d = state.draft;
  return [
    d?.serviceId ?? "",
    d?.staffChoice ?? "",
    JSON.stringify(d?.when ?? null),
    state.offers.map((o) => `${o.startUtc}@${o.staffId ?? ""}`).join(","),
  ].join("|");
}

function bookable(catalog: AgendaCatalog): AgendaCatalogService[] {
  return catalog.services.filter((s) => s.staff.length > 0);
}

function whenText(when: DraftWhen | null | undefined): string | null {
  if (!when) return null;
  const hours =
    when.from && when.to
      ? `de ${when.from} a ${when.to}`
      : when.from
        ? `después de las ${when.from}`
        : when.to
          ? `antes de las ${when.to}`
          : "";
  const text = [when.day, hours].filter(Boolean).join(" ");
  return text || null;
}

function offerLines(offers: readonly { label: string; staffName?: string | null }[]): string {
  return offers
    .slice(0, SHOWN_OPTIONS)
    .map((o, i) => `${i + 1}) ${o.label}${o.staffName ? ` con ${o.staffName}` : ""}`)
    .join("\n");
}

/** El bloque que el modelo ve al final de la conversación. */
export function renderDraftState(state: AgendaState, ctx: AgendaContext): string {
  const { draft } = state;
  const service = draft?.serviceId
    ? ctx.catalog.services.find((s) => s.id === draft.serviceId)
    : undefined;
  const staffLabel =
    draft?.staffChoice === "any"
      ? "cualquiera"
      : (ctx.catalog.staff.find((s) => s.id === draft?.staffChoice)?.displayName ?? null);
  return buildDraftStateBlock({
    now: ctx.now,
    timezone: ctx.settings.timezone,
    step: state.step,
    serviceName: service?.name ?? null,
    staffLabel,
    whenLabel: whenText(draft?.when),
    options: state.offers
      .slice(0, SHOWN_OPTIONS)
      .map((o) => `${o.label}${o.staffName ? ` · ${o.staffName}` : ""}`),
  });
}

/* ------------------------- step messages -------------------------- */

type StepOptions = {
  prefix?: string;
  /** ¿Es el primer mensaje de horarios? Por defecto, si no hay oferta vigente. */
  firstOffer?: boolean;
};

async function offerMessage(
  state: AgendaState,
  ctx: AgendaContext,
  opts: StepOptions = {}
): Promise<string> {
  const { conversation, catalog, settings, now } = ctx;
  const service = catalog.services.find((s) => s.id === state.draft?.serviceId);
  const choice = state.draft?.staffChoice;
  if (!service || !choice) return buildCatalogMessage(bookable(catalog));

  // El aviso de cita vigente va solo en el primer mensaje de horarios.
  const notice =
    (opts.firstOffer ?? state.offers.length === 0)
      ? existingBookingNotice(
          await listUpcomingBookings(conversation.organizationId, conversation.contactId, {
            isTest: conversation.isTest,
            now,
          }),
          settings.timezone
        )
      : null;
  const turn = await offerByPreference({
    organizationId: conversation.organizationId,
    conversationId: conversation.id,
    service: {
      id: service.id,
      name: service.name,
      staff: service.staff.map((p) => ({ id: p.id, displayName: p.displayName })),
    },
    staffChoice: choice,
    when: state.draft?.when ?? null,
    notice,
    now,
  });
  return opts.prefix ? `${opts.prefix}\n\n${turn.text}` : turn.text;
}

/** Vuelve a preguntar el paso en el que está la conversación. */
export async function askCurrentStep(
  state: AgendaState,
  ctx: AgendaContext,
  opts: StepOptions = {}
): Promise<string> {
  const service = ctx.catalog.services.find((s) => s.id === state.draft?.serviceId);
  let body: string;
  switch (state.step) {
    case "need_service":
      body = buildCatalogMessage(bookable(ctx.catalog));
      break;
    case "need_staff":
      body = service
        ? buildStaffChoiceMessage(
            service.name,
            service.staff.map((p) => ({ name: p.displayName }))
          )
        : buildCatalogMessage(bookable(ctx.catalog));
      break;
    case "need_slot":
      return offerMessage(state, ctx, opts);
    case "ready":
      body = `${offerLines(state.offers)}\n\n${PICK_TEXT}`;
      break;
  }
  return opts.prefix ? `${opts.prefix}\n\n${body}` : body;
}

/** Un reply corto y sin cifras: puede abrir el mensaje del código. */
function usableIntro(reply: string | null | undefined): string | null {
  const text = reply?.trim();
  if (!text || text.length > 90 || /\d|\n/.test(text)) return null;
  return text;
}

function names(items: readonly { name: string }[]): string {
  return items.map((i) => i.name).join(", ");
}

/* ---------------------------- handlers ---------------------------- */

async function handleUpdateDraft(
  action: Extract<AgentActionType, { action: "update_draft" }>,
  state: AgendaState,
  ctx: AgendaContext
): Promise<string> {
  const { organizationId, id: conversationId } = ctx.conversation;
  const services = bookable(ctx.catalog);
  let serviceId = state.draft?.serviceId ?? null;
  let staffChoice = state.draft?.staffChoice ?? null;
  let when = state.draft?.when ?? null;
  const notes: string[] = [];
  let blocking: string | null = null;

  const askedService = action.service?.trim();
  if (askedService) {
    const match = matchByName(
      askedService,
      services.map((s) => ({ id: s.id, name: s.name }))
    );
    if (match.kind === "one") {
      if (match.item.id !== serviceId) {
        serviceId = match.item.id;
        const next = services.find((s) => s.id === serviceId);
        // Cambiar de servicio suelta al profesional que no lo hace.
        if (staffChoice && staffChoice !== "any" && !next?.staff.some((p) => p.id === staffChoice)) {
          const who = ctx.catalog.staff.find((s) => s.id === staffChoice)?.displayName;
          notes.push(`${who ?? "Ese profesional"} no hace ${next?.name ?? "ese servicio"}.`);
          staffChoice = null;
        }
      }
    } else if (match.kind === "many") {
      blocking = `¿Cuál de estos servicios te interesa?\n${match.items.map((i) => `• ${i.name}`).join("\n")}`;
    } else {
      const hint = match.closest ? `¿Quisiste decir ${match.closest.name}?\n\n` : "";
      blocking = `Por ahora no ofrecemos «${askedService}». ${hint}${buildCatalogMessage(services)}`;
    }
  }

  const askedStaff = action.staff?.trim();
  const service = services.find((s) => s.id === serviceId);
  if (askedStaff && service && !blocking) {
    if (isAnyStaff(askedStaff)) {
      staffChoice = "any";
    } else {
      const match = matchByName(
        askedStaff,
        ctx.catalog.staff.map((s) => ({ id: s.id, name: s.displayName }))
      );
      const staffList = service.staff.map((p) => ({ name: p.displayName }));
      if (match.kind === "one") {
        if (service.staff.some((p) => p.id === match.item.id)) {
          staffChoice = match.item.id;
        } else {
          blocking = `${match.item.name} no hace ${service.name}. Lo hacen: ${names(staffList)}.\n\n${buildStaffChoiceMessage(service.name, staffList)}`;
        }
      } else if (match.kind === "many") {
        blocking = `¿Con cuál de ellos?\n${match.items.map((i) => `• ${i.name}`).join("\n")}`;
      } else {
        blocking = `No encontré a «${askedStaff}» en el equipo.\n\n${buildStaffChoiceMessage(service.name, staffList)}`;
      }
    }
  }

  // Un solo profesional hace el servicio: no hay nada que preguntar.
  if (!blocking && service && !staffChoice && service.staff.length === 1) {
    const only = service.staff[0];
    if (only) {
      staffChoice = only.id;
      notes.push(`${service.name} lo hace ${only.displayName}.`);
    }
  }

  const nextWhen: DraftWhen = {};
  if (action.when?.day?.trim()) nextWhen.day = action.when.day.trim();
  if (action.when?.from?.trim()) nextWhen.from = action.when.from.trim();
  if (action.when?.to?.trim()) nextWhen.to = action.when.to.trim();
  if (Object.keys(nextWhen).length > 0) when = nextWhen;

  const changed =
    serviceId !== (state.draft?.serviceId ?? null) ||
    staffChoice !== (state.draft?.staffChoice ?? null) ||
    JSON.stringify(when) !== JSON.stringify(state.draft?.when ?? null);

  if (changed) {
    await upsertDraft(organizationId, conversationId, { serviceId, staffChoice, when });
    // Lo ofrecido respondía al borrador anterior.
    await clearOffers(organizationId, conversationId);
  }
  if (blocking) return [...notes, blocking].join("\n");

  const next: AgendaState = {
    draft: {
      serviceId,
      staffChoice,
      when,
      stuckTurns: state.draft?.stuckTurns ?? 0,
      failedTurns: state.draft?.failedTurns ?? 0,
      lastStep: state.draft?.lastStep ?? null,
      updatedAt: new Date(),
    },
    offers: changed ? [] : state.offers,
    step: "need_service",
  };
  next.step = deriveStep(
    { serviceId, staffChoice },
    { hasOffers: next.offers.length > 0 }
  );

  const intro = notes.length === 0 ? usableIntro(action.reply) : null;
  const prefix = [...notes, ...(intro ? [intro] : [])].join(" ");
  return askCurrentStep(next, ctx, {
    ...(prefix ? { prefix } : {}),
    // Cambiar el borrador vacía la oferta, pero el aviso ya se dio la primera vez.
    firstOffer: state.offers.length === 0,
  });
}

async function handleBookSlot(
  option: number,
  state: AgendaState,
  ctx: AgendaContext
): Promise<{ booked: boolean; text: string }> {
  const { conversation, catalog, settings } = ctx;
  const picked = state.offers[option - 1];
  if (!picked) return { booked: false, text: await askCurrentStep(state, ctx) };
  try {
    const booked = await bookFromOffer({
      organizationId: conversation.organizationId,
      conversationId: conversation.id,
      startUtc: picked.startUtc,
      // Presencial: nadie crea una reunión de Zoom o Meet para ir a la barbería.
      skipMeeting: true,
      now: ctx.now,
    });
    const location = await getShopLocation(conversation.organizationId);
    const serviceName =
      catalog.services.find((s) => s.id === booked.booking.serviceId)?.name ?? "Cita";
    return {
      booked: true,
      text: buildConfirmation({
        serviceName,
        staffName: booked.staffName,
        startUtc: booked.booking.scheduledAt.toISOString(),
        durationMinutes: booked.booking.durationMinutes,
        priceCents: booked.booking.priceCents ?? 0,
        currency: booked.booking.currency ?? "MXN",
        timezone: settings.timezone,
        locationAddress: location.locationAddress,
        locationMapsUrl: location.locationMapsUrl,
        arrivalLeadMinutes: location.arrivalLeadMinutes,
        locale: "es-MX",
      }),
    };
  } catch (err) {
    if (err instanceof BookingError) {
      if (err.code === "slot_taken" && err.slots.length > 0) {
        return {
          booked: false,
          text: `Ese horario se acaba de ocupar. Estas son las opciones más cercanas:\n${offerLines(err.slots)}\n\n${PICK_TEXT}`,
        };
      }
      const fresh = await loadAgendaState(ctx);
      const prefix =
        err.code === "slot_taken"
          ? "Ese horario se acaba de ocupar."
          : "Ese horario ya no está disponible.";
      return {
        booked: false,
        text: await askCurrentStep({ ...fresh, step: "need_slot", offers: [] }, ctx, {
          prefix,
          firstOffer: false,
        }),
      };
    }
    if (err instanceof AgendaHttpError) return { booked: false, text: GENERIC_ERROR_TEXT };
    throw err;
  }
}

async function handleMyBookings(ctx: AgendaContext): Promise<string> {
  const { conversation, settings, now } = ctx;
  const [bookings, location] = await Promise.all([
    listUpcomingBookings(conversation.organizationId, conversation.contactId, {
      isTest: conversation.isTest,
      now,
    }),
    getShopLocation(conversation.organizationId),
  ]);
  return buildMyBookingsMessage(bookings, {
    timezone: settings.timezone,
    locationAddress: location.locationAddress,
    locationMapsUrl: location.locationMapsUrl,
  });
}

async function textForDirective(
  directive: Directive,
  state: AgendaState,
  ctx: AgendaContext
): Promise<string> {
  switch (directive.type) {
    case "ask_service":
      return askCurrentStep({ ...state, step: "need_service" }, ctx);
    case "ask_staff":
      return askCurrentStep({ ...state, step: "need_staff" }, ctx);
    case "offer_slots":
      return askCurrentStep({ ...state, step: "need_slot", offers: [] }, ctx);
    case "ask_option":
      return askCurrentStep(state, ctx, { prefix: "No encontré esa opción." });
  }
}

/* ---------------------------- orchestration ---------------------------- */

/** Registra el avance (o la falta de él) del turno. true ⇒ hay que escalar. */
async function trackProgress(
  before: AgendaState,
  after: AgendaState,
  ctx: AgendaContext
): Promise<boolean> {
  const progressed = signature(before) !== signature(after);
  const stuckTurns = progressed ? 0 : (after.draft?.stuckTurns ?? before.draft?.stuckTurns ?? 0) + 1;
  await upsertDraft(ctx.conversation.organizationId, ctx.conversation.id, {
    failedTurns: 0,
    stuckTurns,
    lastStep: after.step,
  });
  return stuckTurns >= STUCK_LIMIT;
}

/**
 * Ejecuta la acción del modelo para este turno. Devuelve `delegate` cuando la
 * acción no es de agenda y la atiende el manejador común del pipeline.
 */
export async function runAgendaAction(
  action: AgentActionType,
  before: AgendaState,
  ctx: AgendaContext,
  deps: AgendaDeps
): Promise<AgendaOutcome> {
  // Ni el silencio ni el handoff cuentan como "turno sin avance".
  if (action.action === "none" || action.action === "handoff") return { kind: "delegate" };

  const guard = guardAction(action as BotAction, before.step, {
    draft: {
      serviceId: before.draft?.serviceId ?? null,
      staffChoice: before.draft?.staffChoice ?? null,
    },
    offerCount: Math.min(before.offers.length, SHOWN_OPTIONS),
  });

  let text: string | null = null;
  try {
    if (guard.kind === "redirect") {
      text = await textForDirective(guard.directive, before, ctx);
    } else if (action.action === "update_draft") {
      text = await handleUpdateDraft(action, before, ctx);
    } else if (action.action === "book_slot") {
      const result = await handleBookSlot(action.option, before, ctx);
      if (result.booked) {
        await clearDraft(ctx.conversation.organizationId, ctx.conversation.id);
        await deps.deliver(result.text);
        deps.notifyBooked();
        return { kind: "sent" };
      }
      text = result.text;
    } else if (action.action === "my_bookings") {
      text = await handleMyBookings(ctx);
    }
  } catch (err) {
    console.error(`[agente] el motor de agenda falló: ${err}`);
    text = GENERIC_ERROR_TEXT;
  }

  // Solo los turnos del flujo de reserva cuentan como "sin avance": una
  // pregunta frecuente, "mis citas" o una nota de lead ni suman ni reinician.
  const bookingTurn =
    guard.kind === "redirect" ||
    action.action === "update_draft" ||
    action.action === "book_slot";
  if (bookingTurn) {
    const after = await loadAgendaState(ctx);
    if (await trackProgress(before, after, ctx)) {
      await deps.deliver(STUCK_TEXT);
      await deps.handoff("atascado");
      return { kind: "sent" };
    }
  } else {
    await upsertDraft(ctx.conversation.organizationId, ctx.conversation.id, {
      failedTurns: 0,
    });
  }
  if (text === null) return { kind: "delegate" };
  await deps.deliver(text);
  return { kind: "sent" };
}

/**
 * El modelo no produjo una acción válida. Se vuelve a preguntar el paso desde
 * el código; solo el segundo fallo seguido escala a una persona.
 */
export async function runAgendaFailure(
  before: AgendaState,
  ctx: AgendaContext,
  deps: AgendaDeps
): Promise<void> {
  const failed = (before.draft?.failedTurns ?? 0) + 1;
  if (failed >= FAILED_LIMIT) {
    await deps.handoff("error");
    return;
  }
  await upsertDraft(ctx.conversation.organizationId, ctx.conversation.id, {
    failedTurns: failed,
  });
  await deps.deliver(await askCurrentStep(before, ctx));
}

export async function loadAgendaContext(
  conversation: Conversation,
  catalog: AgendaCatalog
): Promise<AgendaContext> {
  return {
    conversation,
    catalog,
    settings: await getSettings(conversation.organizationId),
    now: new Date(),
  };
}
