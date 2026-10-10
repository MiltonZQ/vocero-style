import { and, eq, gte, lt } from "drizzle-orm";
import type { Actor } from "@/lib/auth/actor";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { addDaysISO, zonedWallClockToUtc } from "@/lib/time/slots";
import { buildBoard, type BoardStaff } from "@/server/agenda/board";
import { AgendaHttpError } from "@/server/agenda/http";
import { getSettings, normalizeWeeklyHours, type WeeklyHours } from "@/server/agenda/settings";

function storedHours(value: unknown): WeeklyHours | null {
  if (value == null) return null;
  const hours = normalizeWeeklyHours(value);
  return Object.keys(hours).length > 0 ? hours : null;
}

/**
 * One range query for bookings, then an in-memory board.
 * Owner and reception only — the route rejects staff first.
 */
export async function getCalendarBoard(
  actor: Actor,
  query: { from: string; days: number; staffId?: string | null; jobTitle?: string | null }
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(query.from) || (query.days !== 1 && query.days !== 7)) {
    throw new AgendaHttpError("invalid_body", "Indica un día (from) y days 1 o 7");
  }
  const settings = await getSettings(actor.organizationId);
  const start = zonedWallClockToUtc(query.from, "00:00", settings.timezone);
  const end = zonedWallClockToUtc(addDaysISO(query.from, query.days), "00:00", settings.timezone);
  if (!start || !end) {
    throw new AgendaHttpError("invalid_body", "Ese día no existe en la zona del negocio");
  }

  const db = getDb();
  const staffRows = await db
    .select({
      id: schema.staff.id,
      displayName: schema.staff.displayName,
      jobTitle: schema.staff.jobTitle,
      active: schema.staff.active,
      color: schema.staff.color,
      position: schema.staff.position,
      weeklyHours: schema.staff.weeklyHours,
    })
    .from(schema.staff)
    .where(scoped(schema.staff.organizationId, actor.organizationId));

  const bookingRows = await db
    .select({
      id: schema.booking.id,
      kind: schema.booking.kind,
      staffId: schema.booking.staffId,
      status: schema.booking.status,
      scheduledAt: schema.booking.scheduledAt,
      durationMinutes: schema.booking.durationMinutes,
      notes: schema.booking.notes,
    })
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        actor.organizationId,
        and(
          gte(schema.booking.scheduledAt, start),
          lt(schema.booking.scheduledAt, end),
          eq(schema.booking.isTest, false)
        )
      )
    );

  const staff: BoardStaff[] = staffRows.map((row) => ({
    id: row.id,
    displayName: row.displayName,
    jobTitle: row.jobTitle,
    active: row.active,
    color: row.color,
    position: row.position,
    weeklyHours: storedHours(row.weeklyHours),
  }));

  return buildBoard({
    timeZone: settings.timezone,
    from: query.from,
    days: query.days,
    now: new Date(),
    shopHours: settings.weeklyHours,
    staff,
    staffId: query.staffId,
    jobTitle: query.jobTitle,
    rows: bookingRows.map((row) => ({
      id: row.id,
      kind: row.kind,
      staffId: row.staffId,
      status: row.status,
      startUtc: row.scheduledAt,
      endUtc: new Date(row.scheduledAt.getTime() + row.durationMinutes * 60_000),
      notes: row.notes,
    })),
  });
}
