import { dayIsoInTz, weekdayKeyOf, zonedWallClockToUtc } from "@/lib/time/slots";
import { BookingError } from "@/server/agenda/booking-error";
import { effectiveHours } from "@/server/agenda/hours";
import { AgendaHttpError } from "@/server/agenda/http";
import type { WeeklyHours } from "@/server/agenda/settings";

export type BookingServiceSnapshot = {
  durationMinutes: number;
  priceCents: number;
  currency: string;
};

export type BookingTargetInput = {
  staff: { id: string; active: boolean; weeklyHours: WeeklyHours | null };
  service: {
    id: string;
    active: boolean;
    durationMinutes: number;
    priceCents: number;
    currency: string;
  } | null;
  staffService: { active: boolean; durationMinutes: number | null } | null;
  shopHours: WeeklyHours;
  blocks: Array<{ staffId: string | null; startUtc: Date; endUtc: Date }>;
  startUtc: Date;
  timeZone: string;
  /** When set, hours are checked with this length instead of the catalog one. */
  durationMinutes?: number;
};

function notOffered(): never {
  throw new AgendaHttpError(
    "service_not_offered",
    "Ese servicio no está disponible para este profesional."
  );
}

function slotTaken(): never {
  throw new BookingError("slot_taken", "Ese hueco ya no está libre.");
}

function fitsHours(
  startUtc: Date,
  durationMinutes: number,
  weeklyHours: WeeklyHours,
  timeZone: string
): boolean {
  const date = dayIsoInTz(startUtc, timeZone);
  const weekday = weekdayKeyOf(date, timeZone);
  const intervals = weekday ? (weeklyHours[weekday] ?? []) : [];
  const endMs = startUtc.getTime() + durationMinutes * 60_000;
  for (const interval of intervals) {
    const open = zonedWallClockToUtc(date, interval.start, timeZone);
    const close = zonedWallClockToUtc(date, interval.end, timeZone);
    if (!open || !close) continue;
    if (startUtc.getTime() >= open.getTime() && endMs <= close.getTime()) return true;
  }
  return false;
}

/**
 * Duration, price, and currency copied onto the booking.
 * Mutating the catalog afterwards does not change the snapshot.
 */
export function validateBookingTarget(input: BookingTargetInput): BookingServiceSnapshot {
  if (!input.service || !input.service.active || !input.staff.active) notOffered();
  if (!input.staffService || !input.staffService.active) notOffered();
  const durationMinutes =
    input.durationMinutes ??
    input.staffService.durationMinutes ??
    input.service.durationMinutes;
  const priceCents = input.service.priceCents;
  const currency = input.service.currency;
  const effective = effectiveHours(input.staff.weeklyHours, input.shopHours);
  if (!fitsHours(input.startUtc, durationMinutes, effective.weeklyHours, input.timeZone)) {
    slotTaken();
  }
  const endMs = input.startUtc.getTime() + durationMinutes * 60_000;
  const blocked = input.blocks.some((block) => {
    if (block.staffId !== null && block.staffId !== input.staff.id) return false;
    return input.startUtc.getTime() < block.endUtc.getTime() && endMs > block.startUtc.getTime();
  });
  if (blocked) slotTaken();
  return { durationMinutes, priceCents, currency };
}
