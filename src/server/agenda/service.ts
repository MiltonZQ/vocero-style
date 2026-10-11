import { and, asc, desc, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { labelInTz } from "@/lib/time/slots";
import { CONNECTOR_META, type ConnectorId } from "@/lib/agenda-connectors";
import {
  computeAvailability,
  findSlot,
  type AvailableSlot,
} from "@/server/agenda/availability";
import { getSettings, type CalendarSettings } from "@/server/agenda/settings";
import {
  clearOffers,
  findOffered,
  getOffers,
  replaceOffers,
  type OfferedSlot,
} from "@/server/agenda/offers";
import {
  bindConnector,
  markConnectorAuthError,
} from "@/server/agenda/connectors";
import { ConnectorError } from "@/server/agenda/connectors/types";
import { validateBookingTarget } from "@/server/agenda/booking-target";
import { withBlockLock, withSessionLock } from "@/server/agenda/locks";
import { moveLeadToStage } from "@/server/leads/stage-history";
import { bookingUpdatedData } from "@/server/events/booking-event";
import { publish } from "@/server/events/bus";
import { BookingError, type BookingErrorCode } from "@/server/agenda/booking-error";

export { BookingError, type BookingErrorCode };

/**
 * 015 — Ciclo de vida de la cita y las dos reglas INNEGOCIABLES:
 *
 *  1. Quien conduce la conversación (agente in-process o cerebro externo) solo
 *     puede reservar un instante que ya se ofreció a ESA conversación
 *     (`offered_slot`, comparación por epoch exacto).
 *  2. Al confirmar se re-valida el hueco y la base lo cierra con su índice
 *     único parcial; si se ocupó, se responde `slot_taken` con alternativas
 *     frescas y NO se crea nada. Nunca se confirma una reserva que no se creó.
 *
 * Y una regla de honestidad: la entrega de la reunión (el conector) corre
 * DESPUÉS de escribir la verdad del CRM y es best-effort. Si el proveedor está
 * caído, la cita se crea igual con el enlace pendiente — un tercero no puede
 * costarnos la conversión, ni hacernos prometer un enlace que no existe.
 */

type BookingRow = typeof schema.booking.$inferSelect;

export type BookingResult = {
  booking: BookingRow;
  meetingLink: string | null;
  linkPending: boolean;
  label: string;
};

/** Cuántas alternativas se devuelven cuando el hueco se ocupó. */
const FRESH_ALTERNATIVES = 3;

export async function createSessionBooking(input: {
  organizationId: string;
  startUtc: string;
  source: "manual" | "ai";
  /** Obligatoria en el camino conversacional; de ella sale el contacto. */
  conversationId?: string | null;
  /** Camino manual del operador. */
  contactId?: string | null;
  notes?: string | null;
  /**
   * true ⇒ exige que el instante figure entre los ofrecidos a la conversación
   * (agente/bot). El operador elige de la disponibilidad que está viendo, así
   * que reserva sin oferta previa.
   */
  requireOffer: boolean;
  now?: Date;
  staffId: string;
  serviceId: string;
  /** Duración de la fila ofrecida. Sin ella se usa la del catálogo. */
  durationMinutes?: number;
  /**
   * false ⇒ `slot_taken` no reemplaza la oferta. El agente reintenta una vez
   * con otro profesional antes de registrar alternativas.
   */
  refreshOnTaken?: boolean;
  /** 019 — cita presencial: no se crea reunión en ningún conector. */
  skipMeeting?: boolean;
}): Promise<BookingResult> {
  const db = getDb();
  const settings = await getSettings(input.organizationId);

  if (!input.staffId || !input.serviceId) {
    throw new BookingError("service_required", "Hay que elegir profesional y servicio");
  }
  if (Number.isNaN(Date.parse(input.startUtc))) {
    throw new BookingError("invalid", "Instante inválido");
  }

  const startUtc = new Date(input.startUtc);
  const snapshot = await assertBookingTarget(db, {
    organizationId: input.organizationId,
    staffId: input.staffId,
    serviceId: input.serviceId,
    startUtc,
    timeZone: settings.timezone,
    shopHours: settings.weeklyHours,
    durationMinutes: input.durationMinutes,
  });

  // Contexto de la conversación: contacto y si es del Laboratorio.
  let isTest = false;
  let contactId = input.contactId ?? null;
  let contactName = "";
  if (input.conversationId) {
    const rows = await db
      .select({
        contactId: schema.conversation.contactId,
        isTest: schema.conversation.isTest,
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
    const conv = rows[0];
    if (!conv) throw new BookingError("not_found", "Conversación no encontrada");
    isTest = conv.isTest;
    contactId = contactId ?? conv.contactId;
  }

  if (!contactId) {
    throw new BookingError("invalid", "La cita necesita un contacto");
  }
  contactName = await getContactName(input.organizationId, contactId);

  // REGLA 1: solo se reserva lo que se ofreció.
  if (input.requireOffer) {
    if (!input.conversationId) {
      throw new BookingError(
        "invalid",
        "Se necesita la conversación para validar la oferta"
      );
    }
    const offers = await getOffers(input.organizationId, input.conversationId);
    if (!findOffered(offers, input.startUtc)) {
      throw new BookingError(
        "slot_not_offered",
        "Ese horario no se ofreció en esta conversación",
        offers
      );
    }
  }

  // REGLA 2 (primera mitad): el hueco debe seguir libre AHORA.
  const slot = await findSlot(input.organizationId, input.startUtc, {
    now: input.now,
    settings,
    staffId: input.staffId,
    serviceId: input.serviceId,
    durationMinutes: snapshot.durationMinutes,
  });
  if (!slot) {
    throw new BookingError(
      "slot_taken",
      "Ese horario ya no está disponible",
      input.refreshOnTaken === false
        ? []
        : await refreshOffer(input.organizationId, input.conversationId, {
            now: input.now,
            staffId: input.staffId,
            serviceId: input.serviceId,
            durationMinutes: snapshot.durationMinutes,
          })
    );
  }

  const leadRows = await db
    .select({ id: schema.lead.id })
    .from(schema.lead)
    .where(
      scoped(
        schema.lead.organizationId,
        input.organizationId,
        eq(schema.lead.contactId, contactId)
      )
    )
    .limit(1);

  const endUtc = new Date(startUtc.getTime() + snapshot.durationMinutes * 60_000);
  let booking: BookingRow;
  try {
    booking = await withDeadlockRetry(() => db.transaction(async (tx) => {
      // Shared: a shop block's exclusive lock waits, and we wait for it.
      await withSessionLock(tx, input.organizationId);
      const blocked = await blocksOverlapping(tx, input.organizationId, {
        staffId: input.staffId,
        start: startUtc,
        end: endUtc,
      });
      if (blocked.length > 0) {
        throw new BookingError("slot_taken", "Ese horario ya no está disponible");
      }
      const inserted = await tx
        .insert(schema.booking)
        .values({
          id: newId("booking"),
          organizationId: input.organizationId,
          kind: "session",
          source: input.source === "ai" ? "ai" : "manual",
          contactId,
          conversationId: input.conversationId ?? null,
          leadId: leadRows[0]?.id ?? null,
          scheduledAt: new Date(slot.startUtc),
          // Copias históricas del catálogo (FR-015). El precio no sigue al catálogo.
          staffId: input.staffId,
          serviceId: input.serviceId,
          durationMinutes: snapshot.durationMinutes,
          priceCents: snapshot.priceCents,
          currency: snapshot.currency,
          connector: settings.connector,
          isTest,
          notes: input.notes ?? null,
        })
        .returning();
      return inserted[0]!;
    }));
  } catch (err) {
    if (err instanceof BookingError) {
      if (input.refreshOnTaken !== false) {
        err.slots = await refreshOffer(input.organizationId, input.conversationId, {
          now: input.now,
          staffId: input.staffId,
          serviceId: input.serviceId,
          durationMinutes: snapshot.durationMinutes,
        });
      }
      throw err;
    }
    // 23505 (015) and 23P01 (EXCLUDE por profesional) are the same answer.
    if (isSlotConflict(err) || isDeadlock(err)) {
      throw new BookingError(
        "slot_taken",
        "Ese horario acaba de ocuparse",
        input.refreshOnTaken === false
          ? []
          : await refreshOffer(input.organizationId, input.conversationId, {
              now: input.now,
              staffId: input.staffId,
              serviceId: input.serviceId,
              durationMinutes: snapshot.durationMinutes,
            })
      );
    }
    throw err;
  }

  // La oferta cumplió su propósito.
  if (input.conversationId) {
    await clearOffers(input.organizationId, input.conversationId).catch(
      (err) => {
        console.warn(`[agenda] no pude limpiar la oferta: ${err}`);
      }
    );
  }

  // Efectos secundarios: ninguno puede revertir la cita.
  const delivered = input.skipMeeting
    ? booking
    : await deliverMeeting(booking, settings, contactName);
  await advanceLeadStage(
    input.organizationId,
    contactId,
    input.source === "ai" ? "bot" : "dueno"
  ).catch((err) => {
    console.warn(`[agenda] avance de etapa falló: ${err}`);
  });

  publish(input.organizationId, {
    type: "booking.updated",
    data: bookingUpdatedData(delivered),
  });

  return {
    booking: delivered,
    meetingLink: delivered.meetingLink,
    linkPending: delivered.linkPending,
    label: labelInTz(slot.startUtc, settings.timezone),
  };
}

export type BlockConflict = {
  bookingId: string;
  staffId: string | null;
  label: string;
};

/**
 * Personal block (`staffId` string) or whole-shop block (`null`).
 * Sessions inside the range are listed and left untouched — never cancelled.
 * A shop block holds the exclusive advisory lock; the EXCLUDE cannot see it
 * because `staff_id` is NULL.
 */
export async function createBlock(input: {
  organizationId: string;
  startUtc: string;
  durationMinutes: number;
  notes?: string | null;
  staffId: string | null;
}): Promise<{ block: BookingRow | null; conflicts: BlockConflict[] }> {
  const start = new Date(input.startUtc);
  if (Number.isNaN(start.getTime())) {
    throw new BookingError("invalid", "Instante inválido");
  }
  const end = new Date(start.getTime() + input.durationMinutes * 60_000);
  const db = getDb();
  const settings = await getSettings(input.organizationId);

  const place = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
    if (input.staffId === null) await withBlockLock(tx, input.organizationId);
    const conflicts = await sessionConflicts(tx, input.organizationId, {
      staffId: input.staffId,
      start,
      end,
      timeZone: settings.timezone,
    });
    if (conflicts.length > 0) return { block: null, conflicts };
    const inserted = await tx
      .insert(schema.booking)
      .values({
        id: newId("booking"),
        organizationId: input.organizationId,
        kind: "block",
        source: "manual",
        staffId: input.staffId,
        scheduledAt: start,
        durationMinutes: input.durationMinutes,
        notes: input.notes ?? null,
      })
      .returning();
    return { block: inserted[0]!, conflicts: [] as BlockConflict[] };
  };

  try {
    const result = await withDeadlockRetry(() => db.transaction(place));
    if (result.block) {
      publish(input.organizationId, {
        type: "booking.updated",
        data: bookingUpdatedData(result.block),
      });
    }
    return result;
  } catch (err) {
    if (!isSlotConflict(err) && !isDeadlock(err)) throw err;
    const conflicts = await sessionConflicts(db, input.organizationId, {
      staffId: input.staffId,
      start,
      end,
      timeZone: settings.timezone,
    });
    return { block: null, conflicts };
  }
}

export async function rescheduleBooking(input: {
  organizationId: string;
  bookingId: string;
  startUtc: string;
  now?: Date;
}): Promise<BookingResult> {
  const db = getDb();
  const booking = await getOwnBooking(input.organizationId, input.bookingId);
  if (booking.status === "cancelada") {
    throw new BookingError("invalid", "La cita está cancelada");
  }

  const settings = await getSettings(input.organizationId);
  if (!booking.staffId || !booking.serviceId) {
    throw new BookingError("invalid", "Esta cita no se puede mover");
  }
  // Mismo profesional. La duración histórica no cambia con el catálogo.
  const slot = await findSlot(input.organizationId, input.startUtc, {
    excludeBookingId: booking.id,
    now: input.now,
    settings,
    staffId: booking.staffId,
    serviceId: booking.serviceId,
    durationMinutes: booking.durationMinutes,
  });
  if (!slot) {
    throw new BookingError("slot_taken", "Ese horario ya no está disponible");
  }

  let next: BookingRow;
  try {
    next = await withDeadlockRetry(async () => {
      const updated = await db
        .update(schema.booking)
        .set({
          scheduledAt: new Date(slot.startUtc),
          // Mover normaliza una cita legada solapada: desde ahora la cubre el EXCLUDE.
          legacyOverlap: false,
          updatedAt: new Date(),
        })
        .where(eq(schema.booking.id, booking.id))
        .returning();
      return updated[0]!;
    });
  } catch (err) {
    if (isSlotConflict(err) || isDeadlock(err)) {
      throw new BookingError(
        "slot_taken",
        "Ese horario acaba de ocuparse",
        await refreshOffer(input.organizationId, booking.conversationId, {
          now: input.now,
          staffId: booking.staffId!,
          serviceId: booking.serviceId!,
          durationMinutes: booking.durationMinutes,
        })
      );
    }
    throw err;
  }

  // Mover la reunión en el proveedor conserva el enlace: es la MISMA reunión,
  // en otra hora. Un fallo aquí no deshace nada — el enlace anterior sigue
  // sirviendo en la práctica.
  await withConnector(next, settings, async (conn, externalRef) => {
    await conn.updateMeeting(externalRef, {
      startUtc: slot.startUtc,
      durationMinutes: next.durationMinutes,
      timezone: settings.timezone,
    });
  });

  publish(input.organizationId, {
    type: "booking.updated",
    data: bookingUpdatedData(next),
  });
  return {
    booking: next,
    meetingLink: next.meetingLink,
    linkPending: next.linkPending,
    label: labelInTz(slot.startUtc, settings.timezone),
  };
}

/**
 * Reprograma la PRÓXIMA cita activa de la conversación. Es el camino del
 * agente: mover una cita no debería obligar a pausar la IA y pasarle el
 * problema a un humano.
 */
export async function rescheduleForConversation(input: {
  organizationId: string;
  conversationId: string;
  startUtc: string;
  now?: Date;
}): Promise<BookingResult> {
  const db = getDb();
  const now = input.now ?? new Date();

  const convRows = await db
    .select({ contactId: schema.conversation.contactId })
    .from(schema.conversation)
    .where(
      scoped(
        schema.conversation.organizationId,
        input.organizationId,
        eq(schema.conversation.id, input.conversationId)
      )
    )
    .limit(1);
  const conv = convRows[0];
  if (!conv) throw new BookingError("not_found", "Conversación no encontrada");

  // Mismas reglas que al crear: el instante nuevo tiene que haberse ofrecido.
  const offers = await getOffers(input.organizationId, input.conversationId);
  const offered = findOffered(offers, input.startUtc);
  if (!offered) {
    throw new BookingError(
      "slot_not_offered",
      "Ese horario no se ofreció en esta conversación",
      offers
    );
  }

  const rows = await db
    .select()
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        input.organizationId,
        and(
          eq(schema.booking.contactId, conv.contactId),
          eq(schema.booking.kind, "session"),
          eq(schema.booking.status, "agendada"),
          gte(schema.booking.scheduledAt, now)
        )
      )
    )
    .orderBy(asc(schema.booking.scheduledAt))
    .limit(1);

  const target = rows[0];
  if (!target) {
    throw new BookingError("not_found", "No hay una cita activa que mover");
  }
  if (offered.staffId !== target.staffId) {
    throw new BookingError(
      "slot_not_offered",
      "Ese horario no se ofreció para este profesional",
      offers
    );
  }

  const result = await rescheduleBooking({
    organizationId: input.organizationId,
    bookingId: target.id,
    startUtc: input.startUtc,
    now: input.now,
  });
  await clearOffers(input.organizationId, input.conversationId).catch(() => {});
  return result;
}

/**
 * Moves a session to another professional. Price stays the historical copy.
 * `keepDuration` keeps the booking length; otherwise the new professional's
 * effective duration is used. 23P01 comes back as `slot_taken`.
 */
export async function reassignBooking(input: {
  organizationId: string;
  bookingId: string;
  staffId: string;
  keepDuration?: boolean;
}): Promise<BookingResult> {
  const db = getDb();
  const booking = await getOwnBooking(input.organizationId, input.bookingId);
  if (booking.kind !== "session" || booking.status === "cancelada" || !booking.serviceId) {
    throw new BookingError("invalid", "Esta cita no se puede reasignar");
  }
  const settings = await getSettings(input.organizationId);
  const snapshot = await assertBookingTarget(db, {
    organizationId: input.organizationId,
    staffId: input.staffId,
    serviceId: booking.serviceId,
    startUtc: booking.scheduledAt,
    timeZone: settings.timezone,
    shopHours: settings.weeklyHours,
    durationMinutes: input.keepDuration ? booking.durationMinutes : undefined,
  });
  const durationMinutes = input.keepDuration ? booking.durationMinutes : snapshot.durationMinutes;

  let next: BookingRow;
  try {
    next = await withDeadlockRetry(() => db.transaction(async (tx) => {
      await withSessionLock(tx, input.organizationId);
      const updated = await tx
        .update(schema.booking)
        .set({
          staffId: input.staffId,
          durationMinutes,
          legacyOverlap: false,
          updatedAt: new Date(),
        })
        .where(eq(schema.booking.id, booking.id))
        .returning();
      return updated[0]!;
    }));
  } catch (err) {
    if (isSlotConflict(err) || isDeadlock(err)) {
      throw new BookingError(
        "slot_taken",
        "Ese horario ya está ocupado",
        await refreshOffer(input.organizationId, booking.conversationId, {
          now: new Date(),
          staffId: input.staffId,
          serviceId: booking.serviceId,
          durationMinutes,
        })
      );
    }
    throw err;
  }

  publish(input.organizationId, {
    type: "booking.updated",
    data: bookingUpdatedData(next),
  });
  return {
    booking: next,
    meetingLink: next.meetingLink,
    linkPending: next.linkPending,
    label: labelInTz(next.scheduledAt.toISOString(), settings.timezone),
  };
}

/** Idempotente: cancelar una cita ya cancelada no falla ni cambia nada. */
export async function cancelBooking(input: {
  organizationId: string;
  bookingId: string;
}): Promise<void> {
  const db = getDb();
  const booking = await getOwnBooking(input.organizationId, input.bookingId);
  if (booking.status === "cancelada") return;

  await db
    .update(schema.booking)
    .set({ status: "cancelada", updatedAt: new Date() })
    .where(eq(schema.booking.id, booking.id));

  const settings = await getSettings(input.organizationId);
  await withConnector(booking, settings, async (conn, externalRef) => {
    await conn.deleteMeeting(externalRef);
  });

  publish(input.organizationId, {
    type: "booking.updated",
    data: bookingUpdatedData(booking),
  });
}

export async function markBookingStatus(input: {
  organizationId: string;
  bookingId: string;
  status: "realizada" | "no_show";
}): Promise<void> {
  const db = getDb();
  const booking = await getOwnBooking(input.organizationId, input.bookingId);
  try {
    await withDeadlockRetry(() =>
      db
        .update(schema.booking)
        .set({ status: input.status, updatedAt: new Date() })
        .where(eq(schema.booking.id, booking.id))
    );
  } catch (err) {
    // Reactivar a `realizada` un instante que otra cita ya ocupa.
    if (isSlotConflict(err) || isDeadlock(err)) {
      throw new BookingError("slot_taken", "Ese horario ya está ocupado");
    }
    throw err;
  }
  publish(input.organizationId, {
    type: "booking.updated",
    data: bookingUpdatedData(booking),
  });
}

/**
 * Reintenta la entrega de una cita que quedó sin enlace porque el proveedor
 * falló. Habla con el conector con el que NACIÓ la cita, no con el activo.
 *
 * Sin esto, un hipo del proveedor sería una pérdida silenciosa que nadie
 * repara — que es exactamente lo que pasa hoy en el fork.
 */
export async function retryMeetingLink(input: {
  organizationId: string;
  bookingId: string;
}): Promise<BookingResult> {
  const booking = await getOwnBooking(input.organizationId, input.bookingId);
  if (!booking.linkPending) {
    throw new BookingError("invalid", "Esta cita no tiene un enlace pendiente");
  }
  const settings = await getSettings(input.organizationId);
  const contactName = booking.contactId
    ? await getContactName(input.organizationId, booking.contactId)
    : "";
  const delivered = await deliverMeeting(booking, settings, contactName);

  publish(input.organizationId, {
    type: "booking.updated",
    data: bookingUpdatedData(delivered),
  });
  return {
    booking: delivered,
    meetingLink: delivered.meetingLink,
    linkPending: delivered.linkPending,
    label: labelInTz(delivered.scheduledAt.toISOString(), settings.timezone),
  };
}

/**
 * Crea la reunión en el proveedor y la guarda en la cita.
 *
 * SANDBOX: una cita del Laboratorio jamás llega a un conector. La aserción va
 * aquí, ANTES de resolver cuál es, para que valga igual para todos — hoy y
 * para el que agregue un fork mañana.
 */
async function deliverMeeting(
  booking: BookingRow,
  settings: CalendarSettings,
  contactName: string
): Promise<BookingRow> {
  if (booking.isTest) return booking;
  const connectorId = (booking.connector ?? settings.connector) as ConnectorId;

  try {
    const conn = await bindConnector(
      booking.organizationId,
      connectorId,
      settings
    );

    // Si la cita YA tiene reunión, esto es un reintento: se vuelve a leer, no
    // se crea otra. Sin esta rama, reintentar el enlace de un evento de Google
    // dejaría al dueño con dos citas en su calendario.
    const meeting =
      booking.externalRef && conn.refreshMeeting
        ? await conn.refreshMeeting(booking.externalRef)
        : await conn.createMeeting({
            topic: contactName ? `Cita — ${contactName}` : "Cita",
            startUtc: booking.scheduledAt.toISOString(),
            durationMinutes: booking.durationMinutes,
            timezone: settings.timezone,
            notes: booking.notes ?? undefined,
          });

    return await persistDelivery(booking.id, {
      externalRef: meeting.externalId ?? booking.externalRef,
      meetingLink: meeting.joinUrl,
      // Un conector que promete enlace por cita y no lo trajo todavía deja la
      // cita "sin enlace" — reintentable. `enlace-fijo` sin sala configurada,
      // en cambio, no tiene nada pendiente: simplemente no hay enlace.
      linkPending: CONNECTOR_META[connectorId].perBookingLink && !meeting.joinUrl,
    });
  } catch (err) {
    console.warn(
      `[agenda] el conector ${connectorId} no pudo entregar la reunión: ${err}`
    );
    if (err instanceof ConnectorError && err.isAuthError) {
      await markConnectorAuthError(booking.organizationId, connectorId).catch(
        () => {}
      );
    }
    // La cita ya existe y se queda: el enlace es lo único que falta. Se
    // conserva la referencia externa si ya la había, para que el reintento
    // sepa que no debe crear otra reunión.
    return await persistDelivery(booking.id, {
      externalRef: booking.externalRef,
      meetingLink: null,
      linkPending: true,
    });
  }
}

async function persistDelivery(
  bookingId: string,
  values: {
    externalRef: string | null;
    meetingLink: string | null;
    linkPending: boolean;
  }
): Promise<BookingRow> {
  const db = getDb();
  const rows = await db
    .update(schema.booking)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(schema.booking.id, bookingId))
    .returning();
  return rows[0]!;
}

/**
 * Corre un efecto sobre el proveedor de una cita ya creada (mover, borrar).
 * Best-effort y con el mismo guardarraíl de sandbox. Sin `external_ref` no hay
 * nada que mover: el conector no generó reunión (p. ej. el enlace fijo).
 */
async function withConnector(
  booking: BookingRow,
  settings: CalendarSettings,
  run: (
    conn: Awaited<ReturnType<typeof bindConnector>>,
    externalRef: string
  ) => Promise<void>
): Promise<void> {
  if (booking.isTest || !booking.externalRef) return;
  const connectorId = (booking.connector ?? settings.connector) as ConnectorId;
  try {
    const conn = await bindConnector(
      booking.organizationId,
      connectorId,
      settings
    );
    await run(conn, booking.externalRef);
  } catch (err) {
    console.warn(`[agenda] efecto en ${connectorId} falló: ${err}`);
    if (err instanceof ConnectorError && err.isAuthError) {
      await markConnectorAuthError(booking.organizationId, connectorId).catch(
        () => {}
      );
    }
  }
}

/**
 * Alternativas frescas para re-ofrecer. Si hay conversación, quedan
 * REGISTRADAS como su nueva oferta: el cliente puede aceptar una de inmediato
 * y la validación seguirá siendo válida.
 */
async function refreshOffer(
  organizationId: string,
  conversationId: string | null | undefined,
  opts: { now?: Date; staffId: string; serviceId: string; durationMinutes?: number }
): Promise<OfferedSlot[]> {
  let fresh: AvailableSlot[] = [];
  try {
    fresh = (
      await computeAvailability(organizationId, {
        now: opts.now,
        staffId: opts.staffId,
        serviceId: opts.serviceId,
        durationMinutes: opts.durationMinutes,
      })
    ).slice(0, FRESH_ALTERNATIVES);
  } catch (err) {
    console.warn(`[agenda] no pude calcular alternativas: ${err}`);
    return [];
  }
  const offers: OfferedSlot[] = fresh.map((s) => ({
    startUtc: s.startUtc,
    label: s.label,
    staffId: s.staffId ?? opts.staffId,
    serviceId: opts.serviceId,
    durationMinutes: s.durationMinutes ?? opts.durationMinutes ?? null,
    anyStaff: false,
    staffName: s.staffName ?? null,
  }));
  if (conversationId && offers.length > 0) {
    await replaceOffers(organizationId, conversationId, offers).catch((err) => {
      console.warn(`[agenda] no pude registrar la nueva oferta: ${err}`);
    });
  }
  return offers;
}

async function getOwnBooking(
  organizationId: string,
  bookingId: string
): Promise<BookingRow> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        eq(schema.booking.id, bookingId)
      )
    )
    .limit(1);
  if (!rows[0]) throw new BookingError("not_found", "Cita no encontrada");
  return rows[0];
}

async function getContactName(
  organizationId: string,
  contactId: string
): Promise<string> {
  const db = getDb();
  const rows = await db
    .select({ name: schema.contact.name })
    .from(schema.contact)
    .where(
      scoped(
        schema.contact.organizationId,
        organizationId,
        eq(schema.contact.id, contactId)
      )
    )
    .limit(1);
  return rows[0]?.name ?? "";
}

/**
 * El lead avanza a la siguiente etapa abierta al agendar — solo hacia adelante,
 * nunca retrocede.
 *
 * Pasa por `moveLeadToStage`, la única puerta que puede escribir `stage_id`:
 * mover el lead y registrar el movimiento en la bitácora son la misma
 * operación. Escribir el UPDATE aquí no truena, solo hace que las gráficas
 * mientan meses después — y hay un test de vigilancia que lo impide.
 */
async function advanceLeadStage(
  organizationId: string,
  contactId: string,
  source: "bot" | "dueno"
): Promise<void> {
  const db = getDb();
  const leads = await db
    .select({ id: schema.lead.id, stageId: schema.lead.stageId })
    .from(schema.lead)
    .where(
      scoped(
        schema.lead.organizationId,
        organizationId,
        eq(schema.lead.contactId, contactId)
      )
    )
    .limit(1);
  const lead = leads[0];
  if (!lead) return;

  const stages = await db
    .select({
      id: schema.pipelineStage.id,
      position: schema.pipelineStage.position,
      kind: schema.pipelineStage.kind,
    })
    .from(schema.pipelineStage)
    .where(scoped(schema.pipelineStage.organizationId, organizationId))
    .orderBy(asc(schema.pipelineStage.position));

  const currentIdx = stages.findIndex((s) => s.id === lead.stageId);
  if (currentIdx < 0) return;
  const nextOpen = stages.find((s, i) => i > currentIdx && s.kind === "open");
  if (!nextOpen) return; // ya está en la última etapa abierta (o en un ancla)

  await moveLeadToStage({
    organizationId,
    leadId: lead.id,
    toStageId: nextOpen.id,
    source,
    extra: { lastActivityAt: new Date() },
  });
}

/** Citas que ocupan agenda de verdad. */
export const ACTIVE_STATUSES = ["agendada", "realizada"] as const;

export type ConversationBookingCheck = {
  staffId: string | null;
  staffName: string | null;
  serviceId: string | null;
  serviceName: string | null;
  durationMinutes: number;
  effectiveDurationMinutes: number | null;
  isTest: boolean;
};

/**
 * La cita de una conversación, para el juez del Laboratorio.
 * Vive aquí para que `lab/` no lea `booking` directo.
 */
export async function testBookingForConversation(
  organizationId: string,
  conversationId: string
): Promise<ConversationBookingCheck | null> {
  const db = getDb();
  const rows = await db
    .select({
      staffId: schema.booking.staffId,
      staffName: schema.staff.displayName,
      serviceId: schema.booking.serviceId,
      serviceName: schema.service.name,
      durationMinutes: schema.booking.durationMinutes,
      catalogDuration: schema.service.durationMinutes,
      ownDuration: schema.staffService.durationMinutes,
      isTest: schema.booking.isTest,
      status: schema.booking.status,
    })
    .from(schema.booking)
    .leftJoin(schema.staff, eq(schema.booking.staffId, schema.staff.id))
    .leftJoin(schema.service, eq(schema.booking.serviceId, schema.service.id))
    .leftJoin(
      schema.staffService,
      and(
        eq(schema.staffService.staffId, schema.booking.staffId),
        eq(schema.staffService.serviceId, schema.booking.serviceId)
      )
    )
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        eq(schema.booking.conversationId, conversationId),
        eq(schema.booking.kind, "session")
      )
    )
    .orderBy(desc(schema.booking.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row || row.status === "cancelada") return null;
  return {
    staffId: row.staffId,
    staffName: row.staffName,
    serviceId: row.serviceId,
    serviceName: row.serviceName,
    durationMinutes: row.durationMinutes,
    effectiveDurationMinutes:
      row.ownDuration ?? row.catalogDuration ?? null,
    isTest: row.isTest,
  };
}

/** ¿Hay alguna cita activa para este contacto? Lo usa el agente. */
export async function hasActiveBooking(
  organizationId: string,
  contactId: string,
  now = new Date()
): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.booking.id })
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        and(
          eq(schema.booking.contactId, contactId),
          eq(schema.booking.kind, "session"),
          inArray(schema.booking.status, [...ACTIVE_STATUSES]),
          gte(schema.booking.scheduledAt, now)
        )
      )
    )
    .limit(1);
  return rows.length > 0;
}

type QueryDb = Pick<ReturnType<typeof getDb>, "select">;

async function assertBookingTarget(
  db: QueryDb,
  input: {
    organizationId: string;
    staffId: string;
    serviceId: string;
    startUtc: Date;
    timeZone: string;
    shopHours: CalendarSettings["weeklyHours"];
    durationMinutes?: number;
  }
) {
  const staffRows = await db
    .select({
      id: schema.staff.id,
      active: schema.staff.active,
      weeklyHours: schema.staff.weeklyHours,
    })
    .from(schema.staff)
    .where(
      scoped(schema.staff.organizationId, input.organizationId, eq(schema.staff.id, input.staffId))
    )
    .limit(1);
  const serviceRows = await db
    .select({
      id: schema.service.id,
      active: schema.service.active,
      durationMinutes: schema.service.durationMinutes,
      priceCents: schema.service.priceCents,
      currency: schema.service.currency,
    })
    .from(schema.service)
    .where(
      scoped(
        schema.service.organizationId,
        input.organizationId,
        eq(schema.service.id, input.serviceId)
      )
    )
    .limit(1);
  const linkRows = await db
    .select({ durationMinutes: schema.staffService.durationMinutes })
    .from(schema.staffService)
    .where(
      scoped(
        schema.staffService.organizationId,
        input.organizationId,
        and(
          eq(schema.staffService.staffId, input.staffId),
          eq(schema.staffService.serviceId, input.serviceId)
        )
      )
    )
    .limit(1);
  const staff = staffRows[0];
  const service = serviceRows[0];
  const link = linkRows[0];
  const end = new Date(
    input.startUtc.getTime() +
      (input.durationMinutes ?? link?.durationMinutes ?? service?.durationMinutes ?? 0) * 60_000
  );
  const blockRows = await blocksOverlapping(db, input.organizationId, {
    staffId: input.staffId,
    start: input.startUtc,
    end,
  });
  return validateBookingTarget({
    staff: staff
      ? {
          id: staff.id,
          active: staff.active,
          weeklyHours: (staff.weeklyHours as CalendarSettings["weeklyHours"] | null) ?? null,
        }
      : { id: input.staffId, active: false, weeklyHours: null },
    service: service
      ? {
          id: service.id,
          active: service.active,
          durationMinutes: service.durationMinutes,
          priceCents: service.priceCents,
          currency: service.currency,
        }
      : null,
    staffService: link ? { active: true, durationMinutes: link.durationMinutes } : null,
    shopHours: input.shopHours,
    blocks: blockRows,
    startUtc: input.startUtc,
    timeZone: input.timeZone,
    durationMinutes: input.durationMinutes,
  });
}

async function blocksOverlapping(
  db: QueryDb,
  organizationId: string,
  input: { staffId: string; start: Date; end: Date }
): Promise<Array<{ staffId: string | null; startUtc: Date; endUtc: Date }>> {
  const lookback = new Date(input.start.getTime() - 16 * 60 * 60 * 1000);
  const rows = await db
    .select({
      staffId: schema.booking.staffId,
      scheduledAt: schema.booking.scheduledAt,
      durationMinutes: schema.booking.durationMinutes,
    })
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        eq(schema.booking.kind, "block"),
        inArray(schema.booking.status, ["agendada", "realizada"]),
        eq(schema.booking.isTest, false),
        or(eq(schema.booking.staffId, input.staffId), isNull(schema.booking.staffId)),
        gte(schema.booking.scheduledAt, lookback),
        lt(schema.booking.scheduledAt, input.end)
      )
    )
    .limit(100);
  return rows
    .map((row) => ({
      staffId: row.staffId,
      startUtc: row.scheduledAt,
      endUtc: new Date(row.scheduledAt.getTime() + row.durationMinutes * 60_000),
    }))
    .filter((row) => row.startUtc < input.end && row.endUtc > input.start);
}

async function sessionConflicts(
  db: QueryDb,
  organizationId: string,
  input: { staffId: string | null; start: Date; end: Date; timeZone: string }
): Promise<BlockConflict[]> {
  const lookback = new Date(input.start.getTime() - 16 * 60 * 60 * 1000);
  const rows = await db
    .select({
      id: schema.booking.id,
      staffId: schema.booking.staffId,
      scheduledAt: schema.booking.scheduledAt,
      durationMinutes: schema.booking.durationMinutes,
    })
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        eq(schema.booking.kind, "session"),
        inArray(schema.booking.status, ["agendada", "realizada"]),
        eq(schema.booking.isTest, false),
        eq(schema.booking.legacyOverlap, false),
        input.staffId ? eq(schema.booking.staffId, input.staffId) : undefined,
        gte(schema.booking.scheduledAt, lookback),
        lt(schema.booking.scheduledAt, input.end)
      )
    )
    .limit(50);
  return rows
    .filter((row) => {
      const end = row.scheduledAt.getTime() + row.durationMinutes * 60_000;
      return row.scheduledAt < input.end && end > input.start.getTime();
    })
    .map((row) => ({
      bookingId: row.id,
      staffId: row.staffId,
      label: labelInTz(row.scheduledAt.toISOString(), input.timeZone),
    }));
}

/** Códigos de Postgres con los que la BASE cierra un choque de hueco. */
const SLOT_CONFLICT_CODES = new Set([
  "23505", // unique_violation (índice único de la 015)
  "23P01", // exclusion_violation (EXCLUDE por profesional, 018)
]);

function postgresCode(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") return code;
  // Drizzle envuelve el error del driver: el código real viaja en `cause`.
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause !== "object" || cause === null) return null;
  const inner = (cause as { code?: unknown }).code;
  return typeof inner === "string" ? inner : null;
}

/** ¿La BASE rechazó el hueco? Cualquiera de las dos garantías cuenta igual. */
export function isSlotConflict(err: unknown): boolean {
  const code = postgresCode(err);
  return code != null && SLOT_CONFLICT_CODES.has(code);
}

/**
 * Dos INSERT solapados pueden trabarse en el EXCLUDE gist (`40P01`) en vez de
 * que uno reciba `23P01`. El detector aborta una transacción y deja vivir la
 * otra: reintentar la abortada la convierte en `slot_taken`.
 */
export function isDeadlock(err: unknown): boolean {
  return postgresCode(err) === "40P01";
}

async function withDeadlockRetry<T>(run: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      last = err;
      if (!isDeadlock(err) || attempt === 2) throw err;
    }
  }
  throw last;
}
