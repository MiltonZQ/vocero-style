import { and, desc, eq, gte, lt } from "drizzle-orm";
import type { Actor } from "@/lib/auth/actor";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { partsInTz } from "@/lib/time/slots";
import { bookingScope } from "@/server/agenda/scope";
import { getSettings } from "@/server/agenda/settings";

/** Listado de citas. Staff nunca recibe id de contacto ni conversación. */

export type BookingListItem = {
  id: string;
  kind: "session" | "block";
  status: "agendada" | "realizada" | "no_show" | "cancelada";
  source: "manual" | "ai";
  scheduledAtUtc: string;
  endUtc: string;
  durationMinutes: number;
  priceCents: number | null;
  currency: string | null;
  date: string;
  time: string;
  weekday: string;
  contact: { name: string; phone: string | null; id?: string } | null;
  staff: { id: string; name: string } | null;
  service: { id: string; name: string } | null;
  conversationId?: string | null;
  connector: string | null;
  meetingLink: string | null;
  linkPending: boolean;
  isTest: boolean;
  notes: string | null;
};

export async function listBookings(
  actor: Actor,
  filters: { from?: Date; to?: Date } = {}
): Promise<BookingListItem[]> {
  const ranged = filters.from instanceof Date || filters.to instanceof Date;
  return loadBookings(actor, filters, ranged ? undefined : 200);
}

export async function getBooking(actor: Actor, bookingId: string): Promise<BookingListItem | null> {
  const rows = await loadBookings(actor, {}, undefined, bookingId);
  return rows[0] ?? null;
}

async function loadBookings(
  actor: Actor,
  filters: { from?: Date; to?: Date },
  limit: number | undefined,
  bookingId?: string
): Promise<BookingListItem[]> {
  const db = getDb();
  const settings = await getSettings(actor.organizationId);
  const from =
    filters.from instanceof Date && !Number.isNaN(filters.from.getTime()) ? filters.from : undefined;
  const to = filters.to instanceof Date && !Number.isNaN(filters.to.getTime()) ? filters.to : undefined;

  const rows = await db
    .select({
      booking: schema.booking,
      contactId: schema.contact.id,
      contactName: schema.contact.name,
      contactPhone: schema.contact.phone,
      staffName: schema.staff.displayName,
      serviceName: schema.service.name,
    })
    .from(schema.booking)
    .leftJoin(
      schema.contact,
      and(
        eq(schema.booking.contactId, schema.contact.id),
        eq(schema.contact.organizationId, actor.organizationId)
      )
    )
    .leftJoin(
      schema.staff,
      and(
        eq(schema.booking.staffId, schema.staff.id),
        eq(schema.staff.organizationId, actor.organizationId)
      )
    )
    .leftJoin(
      schema.service,
      and(
        eq(schema.booking.serviceId, schema.service.id),
        eq(schema.service.organizationId, actor.organizationId)
      )
    )
    .where(
      scoped(
        schema.booking.organizationId,
        actor.organizationId,
        bookingScope(actor),
        bookingId ? eq(schema.booking.id, bookingId) : undefined,
        from ? gte(schema.booking.scheduledAt, from) : undefined,
        to ? lt(schema.booking.scheduledAt, to) : undefined
      )
    )
    .orderBy(desc(schema.booking.scheduledAt))
    .limit(limit ?? 500);

  const staffViewer = actor.role === "staff";
  return rows.map((r) => {
    const scheduledAtUtc = r.booking.scheduledAt.toISOString();
    const endUtc = new Date(
      r.booking.scheduledAt.getTime() + r.booking.durationMinutes * 60_000
    ).toISOString();
    const parts = partsInTz(scheduledAtUtc, settings.timezone);
    const shopBlock = r.booking.kind === "block" && r.booking.staffId === null;
    const contact =
      r.contactName == null
        ? null
        : staffViewer
          ? { name: r.contactName, phone: r.contactPhone }
          : { id: r.contactId ?? undefined, name: r.contactName, phone: r.contactPhone };
    const item: BookingListItem = {
      id: r.booking.id,
      kind: r.booking.kind,
      status: r.booking.status,
      source: r.booking.source,
      scheduledAtUtc,
      endUtc,
      durationMinutes: r.booking.durationMinutes,
      priceCents: r.booking.priceCents,
      currency: r.booking.currency,
      date: parts.date,
      time: parts.time,
      weekday: parts.weekday,
      contact,
      staff: shopBlock || !r.booking.staffId
        ? null
        : { id: r.booking.staffId, name: r.staffName ?? "" },
      service:
        r.booking.serviceId && r.serviceName
          ? { id: r.booking.serviceId, name: r.serviceName }
          : null,
      connector: r.booking.connector,
      meetingLink: r.booking.meetingLink,
      linkPending: r.booking.linkPending,
      isTest: r.booking.isTest,
      notes: r.booking.notes,
    };
    if (!staffViewer) item.conversationId = r.booking.conversationId;
    return item;
  });
}

/** A staff member may reuse a contact only when it is already on one of their bookings. */
export async function staffMayUseContact(actor: Actor, contactId: string): Promise<boolean> {
  if (actor.role !== "staff") return true;
  if (!actor.staffId) return false;
  const db = getDb();
  const rows = await db
    .select({ id: schema.booking.id })
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        actor.organizationId,
        eq(schema.booking.staffId, actor.staffId),
        eq(schema.booking.contactId, contactId)
      )
    )
    .limit(1);
  return Boolean(rows[0]);
}
