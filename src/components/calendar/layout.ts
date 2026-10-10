import { dayIsoInTz, zonedWallClockToUtc } from "@/lib/time/slots";

/** Closed columns still paint a day instead of collapsing the grid. */
export const CLOSED_DAY_START = 9 * 60;
export const CLOSED_DAY_END = 18 * 60;

export const HOUR_HEIGHT_PX = 52;

export function parseHHMM(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || minute < 0 || minute > 59 || hour > 24) return null;
  if (hour === 24 && minute !== 0) return null;
  return hour * 60 + minute;
}

export function formatMinute(minute: number): string {
  const clamped = Math.max(0, Math.min(minute, 24 * 60));
  const hour = Math.floor(clamped / 60);
  const mins = clamped % 60;
  return `${String(hour).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

/**
 * Wall-clock minutes of `iso` on `day` in `timeZone`.
 * An instant before that day is 0; an instant after it is 24:00.
 */
export function minutesOnDay(iso: string, day: string, timeZone: string): number | null {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return null;
  let zonedDay: string;
  try {
    zonedDay = dayIsoInTz(instant, timeZone);
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    const mins = (hour === 24 ? 0 : hour) * 60 + minute;
    if (zonedDay === day) return mins;
    if (zonedDay > day) return 24 * 60;
    return 0;
  } catch {
    return null;
  }
}

export function wallMinuteToUtc(day: string, minute: number, timeZone: string): string | null {
  if (minute < 0 || minute >= 24 * 60) return null;
  const hhmm = formatMinute(minute);
  try {
    const instant = zonedWallClockToUtc(day, hhmm, timeZone);
    return instant ? instant.toISOString() : null;
  } catch {
    return null;
  }
}

export type MinuteSpan = { start: number; end: number };

export function gridWindow(
  intervals: Array<{ start: string; end: string }>,
  occupied: MinuteSpan[] = []
): { start: number; end: number; closed: boolean } {
  const open: MinuteSpan[] = [];
  for (const interval of intervals) {
    const start = parseHHMM(interval.start);
    const end = parseHHMM(interval.end);
    if (start == null || end == null || end <= start) continue;
    open.push({ start, end });
  }
  const closed = open.length === 0;
  let start = closed ? CLOSED_DAY_START : Math.min(...open.map((interval) => interval.start));
  let end = closed ? CLOSED_DAY_END : Math.max(...open.map((interval) => interval.end));
  for (const item of occupied) {
    if (!Number.isFinite(item.start) || !Number.isFinite(item.end) || item.end <= item.start) {
      continue;
    }
    start = Math.min(start, item.start);
    end = Math.max(end, item.end);
  }
  if (end <= start) return { start: CLOSED_DAY_START, end: CLOSED_DAY_END, closed: true };
  return { start, end, closed };
}

export function clipToWindow(
  start: number,
  end: number,
  windowStart: number,
  windowEnd: number
): MinuteSpan | null {
  const visibleStart = Math.max(start, windowStart);
  const visibleEnd = Math.min(end, windowEnd);
  if (visibleEnd <= visibleStart) return null;
  return { start: visibleStart, end: visibleEnd };
}

/** Gaps inside the window that are outside every open interval. */
export function closedGaps(
  open: MinuteSpan[],
  windowStart: number,
  windowEnd: number
): MinuteSpan[] {
  const sorted = open
    .map((interval) => ({
      start: Math.max(interval.start, windowStart),
      end: Math.min(interval.end, windowEnd),
    }))
    .filter((interval) => interval.end > interval.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const gaps: MinuteSpan[] = [];
  let cursor = windowStart;
  for (const interval of sorted) {
    if (interval.start > cursor) gaps.push({ start: cursor, end: interval.start });
    cursor = Math.max(cursor, interval.end);
  }
  if (cursor < windowEnd) gaps.push({ start: cursor, end: windowEnd });
  return gaps;
}

export type PlacedBlock = {
  id: string;
  lane: number;
  laneCount: number;
};

/**
 * Side-by-side lanes. Touching at an endpoint does not overlap:
 * [10:00, 11:00) sits next to a later block, not on top of it.
 */
export function placeSideBySide<T extends { id: string; start: number; end: number }>(
  items: T[]
): Array<T & PlacedBlock> {
  const sorted = items
    .filter((item) => item.end > item.start)
    .sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
  const laneEnds: number[] = [];
  const assigned: Array<T & { lane: number }> = [];
  for (const item of sorted) {
    let lane = laneEnds.findIndex((end) => end <= item.start);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(item.end);
    } else {
      laneEnds[lane] = item.end;
    }
    assigned.push({ ...item, lane });
  }

  const laneCount = new Map<string, number>();
  let cluster: Array<T & { lane: number }> = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    if (cluster.length === 0) return;
    const count = cluster.reduce((max, item) => Math.max(max, item.lane + 1), 1);
    for (const item of cluster) laneCount.set(item.id, count);
    cluster = [];
  };
  for (const item of assigned) {
    if (cluster.length > 0 && item.start >= clusterEnd) flush();
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  flush();

  return assigned.map((item) => ({
    ...item,
    laneCount: laneCount.get(item.id) ?? 1,
  }));
}

export function snapMinutes(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.floor(value / step) * step;
}

export function containsMinute(intervals: MinuteSpan[], minute: number): boolean {
  return intervals.some((interval) => minute >= interval.start && minute < interval.end);
}

export function offsetPx(minute: number, windowStart: number): number {
  return ((minute - windowStart) / 60) * HOUR_HEIGHT_PX;
}
