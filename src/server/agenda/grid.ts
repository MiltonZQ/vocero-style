import {
  addDaysISO,
  dayIsoInTz,
  overlaps,
  weekdayKeyOf,
  zonedWallClockToUtc,
  type SlotUtc,
} from "@/lib/time/slots";
import type { WeeklyHours } from "@/server/agenda/settings";

export type { WeeklyHours };

export type GridBusy = {
  staffId: string | null;
  startUtc: Date | string;
  endUtc: Date | string;
  kind: "session" | "block";
  status?: string;
  isTest?: boolean;
  legacyOverlap?: boolean;
};

export type ServiceGridInput = {
  timeZone: string;
  fromDate: string;
  days: number;
  weeklyHours: WeeklyHours;
  durationMinutes: number;
  stepMinutes: number;
  bufferMinutes: number;
  minNoticeMinutes: number;
  windowDays: number;
  now: Date;
  staffId: string;
  busy: GridBusy[];
};

/**
 * Slots of `durationMinutes`, stepped in real time by `stepMinutes`.
 * A slot must finish inside one open interval. Buffer (respiro) extends
 * sessions only, after they end. Uses the 015 wall-clock helpers.
 */
export function buildServiceSlots(input: ServiceGridInput): SlotUtc[] {
  const slots: SlotUtc[] = [];
  if (input.durationMinutes <= 0 || input.stepMinutes <= 0) return slots;
  const earliest = input.now.getTime() + input.minNoticeMinutes * 60_000;
  const lengthMs = input.durationMinutes * 60_000;
  const stepMs = input.stepMinutes * 60_000;
  const today = dayIsoInTz(input.now, input.timeZone);
  const windowEnd = addDaysISO(today, input.windowDays);

  for (let offset = 0; offset < input.days; offset += 1) {
    const date = addDaysISO(input.fromDate, offset);
    if (date < today || date >= windowEnd) continue;
    const weekday = weekdayKeyOf(date, input.timeZone);
    if (!weekday) continue;
    const intervals = input.weeklyHours[weekday] ?? [];
    for (const interval of intervals) {
      const open = zonedWallClockToUtc(date, interval.start, input.timeZone);
      const close = zonedWallClockToUtc(date, interval.end, input.timeZone);
      if (!open || !close || close <= open) continue;
      for (
        let t = open.getTime(), guard = 0;
        t + lengthMs <= close.getTime() && guard < 500;
        t += stepMs, guard += 1
      ) {
        if (t < earliest) continue;
        const end = t + lengthMs;
        const startUtc = new Date(t).toISOString();
        const endUtc = new Date(end).toISOString();
        const blocked = input.busy.some((item) => {
          if (!occupies(item, input.staffId)) return false;
          const extra = item.kind === "session" ? input.bufferMinutes : 0;
          const busyEnd = new Date(
            new Date(item.endUtc).getTime() + extra * 60_000
          ).toISOString();
          return overlaps(startUtc, endUtc, new Date(item.startUtc).toISOString(), busyEnd);
        });
        if (blocked) continue;
        slots.push({ startUtc, endUtc });
      }
    }
  }
  return slots;
}

function occupies(item: GridBusy, staffId: string): boolean {
  if (item.kind === "block") return item.staffId === null || item.staffId === staffId;
  if (item.staffId !== staffId) return false;
  if (item.isTest || item.legacyOverlap) return false;
  if (item.status === "cancelled" || item.status === "cancelada") return false;
  return true;
}
