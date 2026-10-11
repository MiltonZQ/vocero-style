import { asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { computeAvailability, rankStaffFreeAt } from "@/server/agenda/availability";
import { effectiveDuration } from "@/server/agenda/catalog";
import { resolveDefaultCatalog, resolveSoleStaffId } from "@/server/agenda/default-staff";
import { getSettings } from "@/server/agenda/settings";
import { spreadByDay } from "@/server/agenda/spread";
import {
  findOffered,
  getOffers,
  replaceOffers,
  type OfferedSlot,
} from "@/server/agenda/offers";
import {
  BookingError,
  createSessionBooking,
  type BookingResult,
} from "@/server/agenda/service";

/**
 * 015 — Lo que el agente y la API del bot pueden hacer con la agenda: el
 * catálogo activo y la reserva de un horario ofrecido. Desde 019 el turno del
 * agente vive en `ai/agenda-turn.ts`; aquí quedan las piezas compartidas.
 *
 * Regla: si el instante no se ofreció en esta conversación, el motor lo
 * rechaza — nunca se agenda algo que el cliente no eligió.
 */

/** Cuántos huecos se le enseñan al cliente en un mensaje. */
const SHOWN = 3;
/** Cuántos se guardan como reservables: el catálogo es más ancho que el menú. */
const OFFERED = 12;

export type AgendaCatalogStaff = {
  id: string;
  displayName: string;
  jobTitle: string | null;
  position: number;
  effectiveDurationMinutes: number;
};

export type AgendaCatalogService = {
  id: string;
  name: string;
  durationMinutes: number;
  priceCents: number;
  currency: string;
  position: number;
  staff: AgendaCatalogStaff[];
};

export type AgendaCatalog = {
  services: AgendaCatalogService[];
  staff: Array<{
    id: string;
    displayName: string;
    jobTitle: string | null;
    position: number;
  }>;
  singleStaff: boolean;
  singleService: boolean;
};

/** Catálogo activo para el prompt, el bot y la oferta. Sin teléfono. */
export async function loadActiveCatalog(organizationId: string): Promise<AgendaCatalog> {
  const db = getDb();
  const [services, staffRows, links] = await Promise.all([
    db
      .select({
        id: schema.service.id,
        name: schema.service.name,
        durationMinutes: schema.service.durationMinutes,
        priceCents: schema.service.priceCents,
        currency: schema.service.currency,
        position: schema.service.position,
      })
      .from(schema.service)
      .where(
        scoped(
          schema.service.organizationId,
          organizationId,
          eq(schema.service.active, true)
        )
      )
      .orderBy(asc(schema.service.position), asc(schema.service.name)),
    db
      .select({
        id: schema.staff.id,
        displayName: schema.staff.displayName,
        jobTitle: schema.staff.jobTitle,
        position: schema.staff.position,
      })
      .from(schema.staff)
      .where(
        scoped(schema.staff.organizationId, organizationId, eq(schema.staff.active, true))
      )
      .orderBy(asc(schema.staff.position), asc(schema.staff.id)),
    db
      .select({
        staffId: schema.staffService.staffId,
        serviceId: schema.staffService.serviceId,
        durationMinutes: schema.staffService.durationMinutes,
      })
      .from(schema.staffService)
      .where(scoped(schema.staffService.organizationId, organizationId)),
  ]);

  const staffById = new Map(staffRows.map((person) => [person.id, person]));
  return {
    services: services.map((service) => ({
      ...service,
      staff: links
        .filter((link) => link.serviceId === service.id && staffById.has(link.staffId))
        .flatMap((link) => {
          const person = staffById.get(link.staffId);
          if (!person) return [];
          return [
            {
              id: person.id,
              displayName: person.displayName,
              jobTitle: person.jobTitle,
              position: person.position,
              effectiveDurationMinutes: effectiveDuration(
                { durationMinutes: link.durationMinutes },
                service
              ),
            },
          ];
        })
        .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    })),
    staff: staffRows,
    singleStaff: staffRows.length === 1,
    singleService: services.length === 1,
  };
}

/** Marcadores del Laboratorio: primer servicio/profesional relacionados. */
export async function loadAgendaMarkers(organizationId: string): Promise<{
  service1: string;
  service2: string;
  staff1: string;
}> {
  const catalog = await loadActiveCatalog(organizationId);
  const related = catalog.services.filter((service) => service.staff.length > 0);
  const first = related[0];
  const second = related[1] ?? first;
  return {
    service1: first?.name ?? "servicio",
    service2: second?.name ?? "servicio",
    staff1: first?.staff[0]?.displayName ?? "profesional",
  };
}

/** Reserva el instante ofrecido. La ruta del bot y el agente usan esto. */
export async function bookFromOffer(input: {
  organizationId: string;
  conversationId: string;
  startUtc: string;
  notes?: string | null;
  now?: Date;
  /** 019 — cita presencial: sin reunión en ningún conector. */
  skipMeeting?: boolean;
}): Promise<BookingResult & { staffName: string | null; mentionName: boolean }> {
  const offers = await getOffers(input.organizationId, input.conversationId);
  const offered = findOffered(offers, input.startUtc);
  if (!offered) {
    throw new BookingError(
      "slot_not_offered",
      "Ese horario no se ofreció en esta conversación",
      offers
    );
  }

  let staffId = offered.staffId ?? null;
  let serviceId = offered.serviceId ?? null;
  let durationMinutes = offered.durationMinutes ?? undefined;
  const anyStaff = offered.anyStaff === true;
  if (!staffId || !serviceId) {
    const sole = await resolveDefaultCatalog(input.organizationId);
    if (!sole) {
      throw new BookingError(
        "slot_not_offered",
        "Ese horario no se ofreció en esta conversación",
        offers
      );
    }
    staffId = staffId ?? sole.staffId;
    serviceId = serviceId ?? sole.serviceId;
    if (durationMinutes == null) durationMinutes = sole.durationMinutes;
  }

  const soleStaff = await resolveSoleStaffId(input.organizationId);
  const attempt = (nextStaffId: string, duration: number | undefined) =>
    createSessionBooking({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      startUtc: input.startUtc,
      notes: input.notes ?? null,
      source: "ai",
      requireOffer: true,
      staffId: nextStaffId,
      serviceId,
      durationMinutes: duration,
      refreshOnTaken: false,
      skipMeeting: input.skipMeeting,
      now: input.now,
    });

  try {
    const result = await attempt(staffId, durationMinutes);
    const staffName = await staffDisplayName(input.organizationId, result.booking.staffId);
    return {
      ...result,
      staffName,
      mentionName: !soleStaff && Boolean(staffName),
    };
  } catch (err) {
    if (!(err instanceof BookingError) || err.code !== "slot_taken") throw err;
    if (anyStaff) {
      const next = await rankStaffFreeAt(input.organizationId, {
        serviceId,
        startUtc: input.startUtc,
        now: input.now,
        excludeStaffIds: [staffId],
      });
      const candidate = next[0];
      if (candidate) {
        try {
          const result = await attempt(candidate.id, candidate.durationMinutes);
          return {
            ...result,
            staffName: candidate.displayName,
            mentionName: !soleStaff && Boolean(candidate.displayName),
          };
        } catch (retryErr) {
          if (!(retryErr instanceof BookingError) || retryErr.code !== "slot_taken") {
            throw retryErr;
          }
          retryErr.slots = await freshAlternatives(input, serviceId, true);
          throw retryErr;
        }
      }
    }
    err.slots = await freshAlternatives(input, serviceId, anyStaff, anyStaff ? undefined : staffId);
    throw err;
  }
}

async function freshAlternatives(
  input: { organizationId: string; conversationId: string; now?: Date },
  serviceId: string,
  anyStaff: boolean,
  staffId?: string
): Promise<OfferedSlot[]> {
  const settings = await getSettings(input.organizationId);
  const now = input.now ?? new Date();
  let slots;
  try {
    slots = await computeAvailability(input.organizationId, {
      settings,
      now,
      staffId: anyStaff ? "any" : (staffId ?? "any"),
      serviceId,
    });
  } catch (err) {
    console.warn(`[agenda] no pude calcular alternativas: ${err}`);
    return [];
  }
  const spread = spreadByDay(slots, {
    timezone: settings.timezone,
    limit: OFFERED,
    perDay: 3,
    now,
  }).slice(0, SHOWN);
  const fresh: OfferedSlot[] = spread.map((slot) => ({
    startUtc: slot.startUtc,
    label: slot.label,
    staffId: slot.staffId ?? null,
    serviceId,
    durationMinutes: slot.durationMinutes ?? null,
    anyStaff,
    staffName: anyStaff ? null : (slot.staffName ?? null),
  }));
  if (input.conversationId && fresh.length > 0) {
    await replaceOffers(input.organizationId, input.conversationId, fresh).catch((err) => {
      console.warn(`[agenda] no pude registrar la nueva oferta: ${err}`);
    });
  }
  return fresh;
}

async function staffDisplayName(
  organizationId: string,
  staffId: string | null
): Promise<string | null> {
  if (!staffId) return null;
  const rows = await getDb()
    .select({ displayName: schema.staff.displayName })
    .from(schema.staff)
    .where(scoped(schema.staff.organizationId, organizationId, eq(schema.staff.id, staffId)))
    .limit(1);
  return rows[0]?.displayName ?? null;
}
