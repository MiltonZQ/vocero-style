import { and, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import {
  addDaysISO,
  eachDateInRange,
  expandWorkingDayToUtc,
  labelInTz,
  overlaps,
  todayInTz,
  weekdayKeyOf,
  zonedWallClockToUtc,
  type SlotUtc,
} from "@/lib/time/slots";
import { buildServiceSlots, type GridBusy } from "@/server/agenda/grid";
import { effectiveHours } from "@/server/agenda/hours";
import { AgendaHttpError } from "@/server/agenda/http";
import {
  getSettings,
  normalizeWeeklyHours,
  type CalendarSettings,
  type WeeklyHours,
} from "@/server/agenda/settings";

/**
 * 015 — Motor de disponibilidad:
 *   horario semanal del negocio − citas activas − bloqueos manuales.
 *
 * Limitación v1 documentada (Constitución VII): NO lee calendarios externos.
 * Es una decisión, no un olvido: meter al proveedor en este camino acoplaría su
 * latencia y sus caídas a la pantalla que más se usa. Los compromisos de fuera
 * se reflejan con bloqueos manuales.
 */

export type AvailableSlot = SlotUtc & { label: string };

/**
 * PURA: expande el horario semanal a slots candidatos en UTC. Sin BD, sin
 * reloj — se testea sola (tests/unit/availability.test.ts).
 */
export function buildCandidateSlots(
  settings: CalendarSettings,
  fromISO: string,
  toISO: string
): SlotUtc[] {
  const tz = settings.timezone;
  const candidates: SlotUtc[] = [];
  for (const date of eachDateInRange(fromISO, toISO)) {
    const weekday = weekdayKeyOf(date, tz);
    if (!weekday) continue;
    const intervals = settings.weeklyHours[weekday] ?? [];
    if (intervals.length === 0) continue; // día cerrado
    candidates.push(
      ...expandWorkingDayToUtc(
        date,
        intervals,
        tz,
        settings.slotMinutes,
        settings.bufferMinutes
      )
    );
  }
  return candidates;
}

/**
 * PURA: descarta lo que ya pasó (con aviso mínimo) y lo que se solapa con algo
 * ocupado, ordena y etiqueta.
 */
export function filterFreeSlots(
  candidates: SlotUtc[],
  busy: SlotUtc[],
  opts: { now: Date; minNoticeHours: number; timezone: string }
): AvailableSlot[] {
  const minStartMs = opts.now.getTime() + opts.minNoticeHours * 3_600_000;
  return candidates
    .filter((c) => Date.parse(c.startUtc) >= minStartMs)
    .filter(
      (c) =>
        !busy.some((b) => overlaps(c.startUtc, c.endUtc, b.startUtc, b.endUtc))
    )
    .sort((a, b) => Date.parse(a.startUtc) - Date.parse(b.startUtc))
    .map((c) => ({ ...c, label: labelInTz(c.startUtc, opts.timezone) }));
}

export async function computeAvailability(
  organizationId: string,
  opts: {
    staffId: string;
    serviceId: string;
    fromISO?: string;
    toISO?: string;
    excludeBookingId?: string;
    now?: Date;
    settings?: CalendarSettings;
    /** Keeps a booking's own duration when rescheduling. */
    durationMinutes?: number;
  }
): Promise<AvailableSlot[]> {
  const settings = opts.settings ?? (await getSettings(organizationId));
  const now = opts.now ?? new Date();
  const tz = settings.timezone;
  const target = await loadServiceTarget(organizationId, opts.staffId, opts.serviceId);
  const durationMinutes = opts.durationMinutes ?? target.durationMinutes;
  const hours = effectiveHours(target.weeklyHours, settings.weeklyHours).weeklyHours;

  const from = opts.fromISO ?? todayInTz(now, tz);
  const to = opts.toISO ?? addDaysISO(from, settings.maxDaysAhead);
  const dates = eachDateInRange(from, to);
  if (dates.length === 0 || durationMinutes <= 0) return [];

  const busy = await getBusyIntervals(organizationId, {
    staffId: opts.staffId,
    fromUtc: zonedWallClockToUtc(from, "00:00", tz) ?? new Date(0),
    toUtc:
      zonedWallClockToUtc(addDaysISO(to, 1), "00:00", tz) ??
      new Date(now.getTime() + 86_400_000 * 61),
    excludeBookingId: opts.excludeBookingId,
  });

  return buildServiceSlots({
    timeZone: tz,
    fromDate: from,
    days: dates.length,
    weeklyHours: hours,
    durationMinutes,
    stepMinutes: settings.slotMinutes,
    bufferMinutes: settings.bufferMinutes,
    minNoticeMinutes: settings.minNoticeHours * 60,
    windowDays: 400,
    now,
    staffId: opts.staffId,
    busy,
  }).map((slot) => ({ ...slot, label: labelInTz(slot.startUtc, tz) }));
}

/**
 * Re-valida que un instante concreto siga libre. Se llama AL CONFIRMAR, nunca
 * al ofrecer. `excludeBookingId` permite reprogramar sin que la propia cita se
 * bloquee a sí misma.
 *
 * Solo recalcula ±1 día alrededor del instante pedido.
 *
 * OJO: esto reduce la ventana de la carrera, no la cierra — entre este SELECT
 * y el INSERT cabe otra confirmación. Quien cierra de verdad es el índice
 * `EXCLUDE` por profesional de `booking` (018; antes, el índice único parcial); esto existe para dar una respuesta
 * útil (con alternativas) en el caso normal.
 */
export async function findSlot(
  organizationId: string,
  whenISO: string,
  opts: {
    staffId: string;
    serviceId: string;
    excludeBookingId?: string;
    now?: Date;
    settings?: CalendarSettings;
    durationMinutes?: number;
  }
): Promise<AvailableSlot | null> {
  const target = Date.parse(whenISO);
  if (Number.isNaN(target)) return null;

  const settings = opts.settings ?? (await getSettings(organizationId));
  const dayInTz = todayInTz(new Date(target), settings.timezone);

  const slots = await computeAvailability(organizationId, {
    fromISO: addDaysISO(dayInTz, -1),
    toISO: addDaysISO(dayInTz, 1),
    excludeBookingId: opts.excludeBookingId,
    now: opts.now,
    settings,
    staffId: opts.staffId,
    serviceId: opts.serviceId,
    durationMinutes: opts.durationMinutes,
  });
  return slots.find((s) => Date.parse(s.startUtc) === target) ?? null;
}

function storedStaffHours(value: unknown): WeeklyHours | null {
  if (value == null) return null;
  const hours = normalizeWeeklyHours(value);
  return Object.keys(hours).length > 0 ? hours : null;
}

async function loadServiceTarget(
  organizationId: string,
  staffId: string,
  serviceId: string
): Promise<{ durationMinutes: number; weeklyHours: WeeklyHours | null }> {
  const db = getDb();
  const staffRows = await db
    .select({ active: schema.staff.active, weeklyHours: schema.staff.weeklyHours })
    .from(schema.staff)
    .where(scoped(schema.staff.organizationId, organizationId, eq(schema.staff.id, staffId)))
    .limit(1);
  const serviceRows = await db
    .select({
      active: schema.service.active,
      durationMinutes: schema.service.durationMinutes,
    })
    .from(schema.service)
    .where(
      scoped(schema.service.organizationId, organizationId, eq(schema.service.id, serviceId))
    )
    .limit(1);
  const linkRows = await db
    .select({ durationMinutes: schema.staffService.durationMinutes })
    .from(schema.staffService)
    .where(
      scoped(
        schema.staffService.organizationId,
        organizationId,
        and(
          eq(schema.staffService.staffId, staffId),
          eq(schema.staffService.serviceId, serviceId)
        )
      )
    )
    .limit(1);
  const staff = staffRows[0];
  const service = serviceRows[0];
  const link = linkRows[0];
  if (!staff?.active || !service?.active || !link) {
    throw new AgendaHttpError(
      "service_not_offered",
      "Ese servicio no está disponible para este profesional."
    );
  }
  return {
    durationMinutes: link.durationMinutes ?? service.durationMinutes,
    weeklyHours: storedStaffHours(staff.weeklyHours),
  };
}

async function getBusyIntervals(
  organizationId: string,
  input: {
    fromUtc: Date;
    toUtc: Date;
    excludeBookingId?: string;
    staffId: string;
  }
): Promise<GridBusy[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: schema.booking.id,
      kind: schema.booking.kind,
      staffId: schema.booking.staffId,
      scheduledAt: schema.booking.scheduledAt,
      durationMinutes: schema.booking.durationMinutes,
    })
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        and(
          // Canceladas y no-show liberan el hueco.
          inArray(schema.booking.status, ["agendada", "realizada"]),
          // Sandbox: una cita de prueba no consume la agenda real.
          eq(schema.booking.isTest, false),
          // Una fila legada solapada no ocupa hasta que se mueva.
          eq(schema.booking.legacyOverlap, false),
          or(
            eq(schema.booking.staffId, input.staffId),
            and(eq(schema.booking.kind, "block"), isNull(schema.booking.staffId))
          ),
          gte(schema.booking.scheduledAt, input.fromUtc),
          lte(schema.booking.scheduledAt, input.toUtc)
        )
      )
    );

  return rows
    .filter((r) => r.id !== input.excludeBookingId)
    .map((r) => ({
      staffId: r.staffId,
      kind: r.kind === "block" ? "block" : "session",
      status: "agendada",
      startUtc: r.scheduledAt.toISOString(),
      endUtc: new Date(r.scheduledAt.getTime() + r.durationMinutes * 60_000).toISOString(),
    }));
}
