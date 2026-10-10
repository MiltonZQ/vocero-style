import { describe, expect, it } from "vitest";
import { eachDateInRange, addDaysISO } from "../../src/lib/time/slots";
import {
  buildCandidateSlots,
  filterFreeSlots,
} from "../../src/server/agenda/availability";
import { buildServiceSlots } from "../../src/server/agenda/grid";
import { DEFAULT_CALENDAR_SETTINGS } from "../../src/server/agenda/settings";

/**
 * T048 — one professional, one service whose duration equals slotMinutes,
 * shop hours. The new grid matches the 015 candidate + free-slot pipeline
 * on a split day, with minimum notice and a short booking window.
 */

describe("agenda equivalence", () => {
  it("matches 015 slots when duration equals the shop grid", () => {
    const weeklyHours = {
      mon: [
        { start: "09:00", end: "14:00" },
        { start: "16:00", end: "20:00" },
      ],
      tue: [{ start: "09:00", end: "18:00" }],
      thu: [{ start: "09:00", end: "13:00" }],
    };
    const now = new Date("2026-01-05T07:00:00.000Z");
    const settings = {
      ...DEFAULT_CALENDAR_SETTINGS,
      timezone: "Europe/Madrid",
      slotMinutes: 30,
      bufferMinutes: 0,
      minNoticeHours: 2,
      maxDaysAhead: 2,
      weeklyHours,
    };
    const from = "2026-01-05";
    const to = addDaysISO(from, settings.maxDaysAhead);
    const busy = [
      {
        startUtc: "2026-01-05T10:00:00.000Z",
        endUtc: "2026-01-05T11:00:00.000Z",
      },
    ];
    const legacy = filterFreeSlots(buildCandidateSlots(settings, from, to), busy, {
      now,
      minNoticeHours: settings.minNoticeHours,
      timezone: settings.timezone,
    }).map((slot) => ({ startUtc: slot.startUtc, endUtc: slot.endUtc }));

    const dates = eachDateInRange(from, to);
    const next = buildServiceSlots({
      timeZone: settings.timezone,
      fromDate: from,
      days: dates.length,
      weeklyHours,
      durationMinutes: settings.slotMinutes,
      stepMinutes: settings.slotMinutes,
      bufferMinutes: 0,
      minNoticeMinutes: settings.minNoticeHours * 60,
      windowDays: 30,
      now,
      staffId: "st_only",
      busy: busy.map((span) => ({
        staffId: "st_only",
        startUtc: span.startUtc,
        endUtc: span.endUtc,
        kind: "session" as const,
        status: "agendada",
      })),
    });

    expect(next).toEqual(legacy);
    expect(next.length).toBeGreaterThan(0);
    expect(next.some((slot) => slot.startUtc.startsWith("2026-01-08"))).toBe(false);
  });
});