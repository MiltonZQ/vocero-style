import { and, asc, eq, gte } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { formatWhen } from "@/server/agenda/confirmation";

/**
 * 019 — "¿Cuándo es mi cita?": las citas próximas del contacto de la
 * conversación y los textos que las describen. Los textos son del código.
 */

export type UpcomingBooking = {
  id: string;
  serviceName: string;
  staffName: string | null;
  startUtc: string;
  durationMinutes: number;
};

export type MyBookingsFormat = {
  timezone: string;
  locationAddress: string | null;
  locationMapsUrl: string | null;
};

/**
 * Sesiones `agendada` futuras de UN contacto. Las citas de prueba solo las ve
 * una conversación de prueba, y las reales nunca se mezclan con ellas.
 */
export async function listUpcomingBookings(
  organizationId: string,
  contactId: string,
  opts: { now?: Date; isTest: boolean },
  db: ReturnType<typeof getDb> = getDb()
): Promise<UpcomingBooking[]> {
  const rows = await db
    .select({
      id: schema.booking.id,
      scheduledAt: schema.booking.scheduledAt,
      durationMinutes: schema.booking.durationMinutes,
      serviceName: schema.service.name,
      staffName: schema.staff.displayName,
    })
    .from(schema.booking)
    .leftJoin(schema.service, eq(schema.booking.serviceId, schema.service.id))
    .leftJoin(schema.staff, eq(schema.booking.staffId, schema.staff.id))
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        and(
          eq(schema.booking.contactId, contactId),
          eq(schema.booking.kind, "session"),
          eq(schema.booking.status, "agendada"),
          eq(schema.booking.isTest, opts.isTest),
          gte(schema.booking.scheduledAt, opts.now ?? new Date())
        )
      )
    )
    .orderBy(asc(schema.booking.scheduledAt));
  return rows.map((r) => ({
    id: r.id,
    serviceName: r.serviceName ?? "Cita",
    staffName: r.staffName,
    startUtc: r.scheduledAt.toISOString(),
    durationMinutes: r.durationMinutes,
  }));
}

function describe(b: UpcomingBooking, timezone: string): string {
  const who = b.staffName ? ` con ${b.staffName}` : "";
  return `${b.serviceName}${who} — ${formatWhen(b.startUtc, timezone, "es-MX")} (${b.durationMinutes} min)`;
}

export function buildMyBookingsMessage(
  bookings: readonly UpcomingBooking[],
  fmt: MyBookingsFormat
): string {
  if (bookings.length === 0) {
    return "No tienes citas próximas agendadas. ¿Quieres agendar una?";
  }
  const lines = [
    bookings.length === 1 ? "Esta es tu próxima cita:" : "Estas son tus próximas citas:",
    "",
    ...bookings.map((b) => `• ${describe(b, fmt.timezone)}`),
  ];
  const place = [fmt.locationAddress, fmt.locationMapsUrl].filter(Boolean).join(" — ");
  if (place) lines.push("", `📍 ${place}`);
  return lines.join("\n");
}

/** Aviso para el primer mensaje de horarios cuando ya hay una cita vigente. */
export function existingBookingNotice(
  bookings: readonly UpcomingBooking[],
  timezone: string
): string | null {
  const [next] = bookings;
  if (!next) return null;
  return `Ya tienes una cita: ${describe(next, timezone)}. ¿Quieres agendar otra adicional?`;
}
