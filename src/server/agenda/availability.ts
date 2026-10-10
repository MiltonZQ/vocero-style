import { and, asc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import {
  addDaysISO,
  dayIsoInTz,
  eachDateInRange,
  expandWorkingDayToUtc,
  labelInTz,
  overlaps,
  todayInTz,
  weekdayKeyOf,
  zonedWallClockToUtc,
  type SlotUtc,
} from "@/lib/time/slots";
import { pickAssignee, rankCandidates } from "@/server/agenda/assignment";
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

export type AvailableSlot = SlotUtc & {
  label: string;
  staffId?: string;
  staffName?: string | null;
  serviceId?: string;
  durationMinutes?: number;
  priceCents?: number | null;
};

export type FreeStaffAt = {
  id: string;
  displayName: string;
  position: number;
  durationMinutes: number;
};

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
  if (opts.staffId === "any") {
    return computeAnyAvailability(organizationId, opts);
  }
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
    staffIds: [opts.staffId],
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
  }).map((slot) => ({
    ...slot,
    label: labelInTz(slot.startUtc, tz),
    staffId: opts.staffId,
    staffName: target.displayName,
    serviceId: opts.serviceId,
    durationMinutes,
    priceCents: target.priceCents,
  }));
}

type OfferingStaff = {
  id: string;
  displayName: string;
  position: number;
  weeklyHours: WeeklyHours | null;
  durationMinutes: number;
  priceCents: number;
};

type FreeCandidate = {
  staff: OfferingStaff;
  startUtc: string;
  endUtc: string;
};

/**
 * Profesionales activos que ofrecen el servicio, en UNA consulta, y los
 * ocupados de todos ellos en OTRA. `staffId: "any"` fusiona por instante.
 */
async function computeAnyAvailability(
  organizationId: string,
  opts: {
    serviceId: string;
    fromISO?: string;
    toISO?: string;
    excludeBookingId?: string;
    now?: Date;
    settings?: CalendarSettings;
    durationMinutes?: number;
  }
): Promise<AvailableSlot[]> {
  const settings = opts.settings ?? (await getSettings(organizationId));
  const now = opts.now ?? new Date();
  const staff = await loadOfferingStaff(organizationId, opts.serviceId);
  if (staff.length === 0) {
    throw new AgendaHttpError(
      "service_not_offered",
      "Ese servicio no está disponible para este profesional."
    );
  }
  const { free, busy } = await collectFree(organizationId, staff, settings, now, opts);
  const byStart = new Map<string, FreeCandidate[]>();
  for (const candidate of free) {
    const bucket = byStart.get(candidate.startUtc);
    if (bucket) bucket.push(candidate);
    else byStart.set(candidate.startUtc, [candidate]);
  }
  const loads = bookingLoad(busy, settings.timezone);
  const starts = [...byStart.keys()].sort((a, b) => Date.parse(a) - Date.parse(b));
  const out: AvailableSlot[] = [];
  for (const startUtc of starts) {
    const candidates = byStart.get(startUtc) ?? [];
    const day = dayIsoInTz(new Date(startUtc), settings.timezone);
    const load = loads.get(day) ?? {};
    const winner = pickAssignee(
      candidates.map((candidate) => ({
        id: candidate.staff.id,
        position: candidate.staff.position,
        offersService: true,
      })),
      load
    );
    if (!winner) continue;
    load[winner.id] = (load[winner.id] ?? 0) + 1;
    loads.set(day, load);
    const chosen = candidates.find((candidate) => candidate.staff.id === winner.id);
    if (!chosen) continue;
    out.push({
      startUtc: chosen.startUtc,
      endUtc: chosen.endUtc,
      label: labelInTz(chosen.startUtc, settings.timezone),
      staffId: chosen.staff.id,
      staffName: chosen.staff.displayName,
      serviceId: opts.serviceId,
      durationMinutes: chosen.staff.durationMinutes,
      priceCents: chosen.staff.priceCents,
    });
  }
  return out;
}

/** Quién sigue libre en ese instante, del menos cargado al más cargado. */
export async function rankStaffFreeAt(
  organizationId: string,
  opts: {
    serviceId: string;
    startUtc: string;
    now?: Date;
    settings?: CalendarSettings;
    excludeStaffIds?: readonly string[];
    excludeBookingId?: string;
  }
): Promise<FreeStaffAt[]> {
  const target = Date.parse(opts.startUtc);
  if (Number.isNaN(target)) return [];
  const settings = opts.settings ?? (await getSettings(organizationId));
  const now = opts.now ?? new Date();
  const staff = await loadOfferingStaff(organizationId, opts.serviceId);
  const excluded = new Set(opts.excludeStaffIds ?? []);
  const day = dayIsoInTz(new Date(target), settings.timezone);
  const { free, busy } = await collectFree(organizationId, staff, settings, now, {
    fromISO: addDaysISO(day, -1),
    toISO: addDaysISO(day, 1),
    excludeBookingId: opts.excludeBookingId,
  });
  const atInstant = free.filter(
    (candidate) =>
      Date.parse(candidate.startUtc) === target && !excluded.has(candidate.staff.id)
  );
  const load = bookingLoad(busy, settings.timezone).get(day) ?? {};
  const ranked = rankCandidates(
    atInstant.map((candidate) => ({
      id: candidate.staff.id,
      position: candidate.staff.position,
      offersService: true,
    })),
    load
  );
  return ranked.flatMap((chosen) => {
    const candidate = atInstant.find((item) => item.staff.id === chosen.id);
    if (!candidate) return [];
    return [
      {
        id: candidate.staff.id,
        displayName: candidate.staff.displayName,
        position: candidate.staff.position,
        durationMinutes: candidate.staff.durationMinutes,
      },
    ];
  });
}

async function loadOfferingStaff(
  organizationId: string,
  serviceId: string
): Promise<OfferingStaff[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: schema.staff.id,
      displayName: schema.staff.displayName,
      position: schema.staff.position,
      weeklyHours: schema.staff.weeklyHours,
      ownDuration: schema.staffService.durationMinutes,
      serviceDuration: schema.service.durationMinutes,
      priceCents: schema.service.priceCents,
      serviceActive: schema.service.active,
    })
    .from(schema.staff)
    .innerJoin(
      schema.staffService,
      and(
        eq(schema.staffService.staffId, schema.staff.id),
        eq(schema.staffService.serviceId, serviceId),
        eq(schema.staffService.organizationId, organizationId)
      )
    )
    .innerJoin(schema.service, eq(schema.service.id, schema.staffService.serviceId))
    .where(
      scoped(
        schema.staff.organizationId,
        organizationId,
        eq(schema.staff.active, true),
        eq(schema.service.active, true)
      )
    )
    .orderBy(asc(schema.staff.position), asc(schema.staff.id));

  return rows
    .filter((row) => row.serviceActive)
    .map((row) => ({
      id: row.id,
      displayName: row.displayName,
      position: row.position,
      weeklyHours: storedStaffHours(row.weeklyHours),
      durationMinutes: row.ownDuration ?? row.serviceDuration,
      priceCents: row.priceCents,
    }));
}

async function collectFree(
  organizationId: string,
  staff: OfferingStaff[],
  settings: CalendarSettings,
  now: Date,
  opts: {
    fromISO?: string;
    toISO?: string;
    excludeBookingId?: string;
    durationMinutes?: number;
  }
): Promise<{ free: FreeCandidate[]; busy: GridBusy[] }> {
  const tz = settings.timezone;
  const from = opts.fromISO ?? todayInTz(now, tz);
  const to = opts.toISO ?? addDaysISO(from, settings.maxDaysAhead);
  const dates = eachDateInRange(from, to);
  if (dates.length === 0 || staff.length === 0) return { free: [], busy: [] };

  const busy = await getBusyIntervals(organizationId, {
    staffIds: staff.map((person) => person.id),
    fromUtc: zonedWallClockToUtc(from, "00:00", tz) ?? new Date(0),
    toUtc:
      zonedWallClockToUtc(addDaysISO(to, 1), "00:00", tz) ??
      new Date(now.getTime() + 86_400_000 * 61),
    excludeBookingId: opts.excludeBookingId,
  });

  const free: FreeCandidate[] = [];
  for (const person of staff) {
    const durationMinutes = opts.durationMinutes ?? person.durationMinutes;
    if (durationMinutes <= 0) continue;
    const hours = effectiveHours(person.weeklyHours, settings.weeklyHours).weeklyHours;
    const slots = buildServiceSlots({
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
      staffId: person.id,
      busy,
    });
    for (const slot of slots) {
      free.push({
        staff: { ...person, durationMinutes },
        startUtc: slot.startUtc,
        endUtc: slot.endUtc,
      });
    }
  }
  return { free, busy };
}

function bookingLoad(busy: GridBusy[], timezone: string): Map<string, Record<string, number>> {
  const byDay = new Map<string, Record<string, number>>();
  for (const item of busy) {
    if (item.kind !== "session" || !item.staffId) continue;
    const day = dayIsoInTz(new Date(item.startUtc), timezone);
    const load = byDay.get(day) ?? {};
    load[item.staffId] = (load[item.staffId] ?? 0) + 1;
    byDay.set(day, load);
  }
  return byDay;
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
): Promise<{
  durationMinutes: number;
  weeklyHours: WeeklyHours | null;
  displayName: string;
  priceCents: number;
}> {
  const db = getDb();
  const staffRows = await db
    .select({
      active: schema.staff.active,
      weeklyHours: schema.staff.weeklyHours,
      displayName: schema.staff.displayName,
    })
    .from(schema.staff)
    .where(scoped(schema.staff.organizationId, organizationId, eq(schema.staff.id, staffId)))
    .limit(1);
  const serviceRows = await db
    .select({
      active: schema.service.active,
      durationMinutes: schema.service.durationMinutes,
      priceCents: schema.service.priceCents,
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
    displayName: staff.displayName,
    priceCents: service.priceCents,
  };
}

async function getBusyIntervals(
  organizationId: string,
  input: {
    fromUtc: Date;
    toUtc: Date;
    excludeBookingId?: string;
    staffIds: string[];
  }
): Promise<GridBusy[]> {
  if (input.staffIds.length === 0) return [];
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
            inArray(schema.booking.staffId, input.staffIds),
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
