import { addDaysISO, weekdayKeyOf, zonedWallClockToUtc } from "@/lib/time/slots";
import { effectiveHours } from "@/server/agenda/hours";
import type { WeeklyHours } from "@/server/agenda/settings";

export type BoardStaff = {
  id: string;
  displayName: string;
  jobTitle: string | null;
  active: boolean;
  color: string | null;
  position: number;
  weeklyHours: WeeklyHours | null;
};

export type BoardRow = {
  id: string;
  kind: "session" | "block";
  staffId: string | null;
  status: string;
  startUtc: Date;
  endUtc: Date;
  notes: string | null;
};

export type BoardInput = {
  timeZone: string;
  from: string;
  days: 1 | 7;
  now: Date;
  shopHours: WeeklyHours;
  staff: BoardStaff[];
  rows: BoardRow[];
  staffId?: string | null;
  jobTitle?: string | null;
};

export type BoardBooking = {
  id: string;
  kind: "session" | "block";
  staffId: string | null;
  status: string;
  startUtc: string;
  endUtc: string;
  notes: string | null;
};

export type BoardDay = {
  date: string;
  startUtc: string;
  endUtc: string;
};

export type BoardColumn = {
  staffId: string;
  displayName: string;
  jobTitle: string | null;
  active: boolean;
  color: string | null;
  needsReassignment: boolean;
  days: Array<{
    date: string;
    hours: Array<{ start: string; end: string }>;
    bookings: BoardBooking[];
  }>;
};

export type CalendarBoard = {
  timeZone: string;
  from: string;
  days: BoardDay[];
  columns: BoardColumn[];
  shopBlocks: BoardBooking[];
};

function toBooking(row: BoardRow): BoardBooking {
  return {
    id: row.id,
    kind: row.kind,
    staffId: row.staffId,
    status: row.status,
    startUtc: row.startUtc.toISOString(),
    endUtc: row.endUtc.toISOString(),
    notes: row.notes,
  };
}

function dayRange(date: string, timeZone: string): { startUtc: Date; endUtc: Date } {
  const startUtc = zonedWallClockToUtc(date, "00:00", timeZone);
  const endUtc = zonedWallClockToUtc(addDaysISO(date, 1), "00:00", timeZone);
  if (!startUtc || !endUtc) {
    throw new Error(`No se pudo resolver el día ${date} en ${timeZone}`);
  }
  return { startUtc, endUtc };
}

function isFutureSession(row: BoardRow, staffId: string, now: Date): boolean {
  return (
    row.kind === "session" &&
    row.staffId === staffId &&
    row.status !== "cancelled" &&
    row.status !== "cancelada" &&
    row.endUtc.getTime() > now.getTime()
  );
}

/**
 * Groups one already-loaded range. Columns are active staff plus inactive
 * staff who still have a future session (`needsReassignment`).
 */
export function buildBoard(input: BoardInput): CalendarBoard {
  const days: Array<BoardDay & { startMs: number; endMs: number; weekday: string }> = [];
  for (let offset = 0; offset < input.days; offset += 1) {
    const date = addDaysISO(input.from, offset);
    const range = dayRange(date, input.timeZone);
    days.push({
      date,
      startUtc: range.startUtc.toISOString(),
      endUtc: range.endUtc.toISOString(),
      startMs: range.startUtc.getTime(),
      endMs: range.endUtc.getTime(),
      weekday: weekdayKeyOf(date, input.timeZone) ?? "",
    });
  }
  const rangeStart = days[0]?.startMs ?? 0;
  const rangeEnd = days[days.length - 1]?.endMs ?? 0;

  const shopBlocks = input.rows
    .filter(
      (row) =>
        row.kind === "block" &&
        row.staffId === null &&
        row.startUtc.getTime() >= rangeStart &&
        row.startUtc.getTime() < rangeEnd
    )
    .map(toBooking);

  const columns = input.staff
    .filter((person) => {
      if (input.staffId && person.id !== input.staffId) return false;
      if (input.jobTitle && person.jobTitle !== input.jobTitle) return false;
      if (person.active) return true;
      return input.rows.some((row) => isFutureSession(row, person.id, input.now));
    })
    .sort((a, b) => a.position - b.position || a.displayName.localeCompare(b.displayName))
    .map((person) => {
      const effective = effectiveHours(person.weeklyHours, input.shopHours);
      return {
        staffId: person.id,
        displayName: person.displayName,
        jobTitle: person.jobTitle,
        active: person.active,
        color: person.color,
        needsReassignment: !person.active,
        days: days.map((day) => ({
          date: day.date,
          hours:
            (day.weekday
              ? effective.weeklyHours[day.weekday as keyof typeof effective.weeklyHours]
              : undefined) ?? [],
          bookings: input.rows
            .filter(
              (row) =>
                row.staffId === person.id &&
                row.startUtc.getTime() >= day.startMs &&
                row.startUtc.getTime() < day.endMs
            )
            .sort((a, b) => a.startUtc.getTime() - b.startUtc.getTime())
            .map(toBooking),
        })),
      };
    });

  return {
    timeZone: input.timeZone,
    from: input.from,
    days: days.map(({ date, startUtc, endUtc }) => ({ date, startUtc, endUtc })),
    columns,
    shopBlocks,
  };
}
