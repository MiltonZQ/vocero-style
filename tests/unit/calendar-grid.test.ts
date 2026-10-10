import { describe, expect, it } from "vitest";
import {
  CLOSED_DAY_END,
  CLOSED_DAY_START,
  clipToWindow,
  closedGaps,
  containsMinute,
  gridWindow,
  minutesOnDay,
  placeSideBySide,
  snapMinutes,
  wallMinuteToUtc,
} from "../../src/components/calendar/layout";

describe("calendar grid layout", () => {
  it("uses 09:00–18:00 when the day has no hours", () => {
    expect(gridWindow([])).toEqual({
      start: CLOSED_DAY_START,
      end: CLOSED_DAY_END,
      closed: true,
    });
  });

  it("unions open hours and stretches to fit a booking outside them", () => {
    const window = gridWindow(
      [
        { start: "10:00", end: "14:00" },
        { start: "09:00", end: "12:00" },
      ],
      [{ start: 8 * 60, end: 8 * 60 + 30 }]
    );
    expect(window).toEqual({ start: 8 * 60, end: 14 * 60, closed: false });
  });

  it("places overlapping bookings side by side and leaves a later one full width", () => {
    const placed = placeSideBySide([
      { id: "a", start: 0, end: 60 },
      { id: "b", start: 30, end: 90 },
      { id: "c", start: 90, end: 120 },
    ]);
    const byId = Object.fromEntries(placed.map((item) => [item.id, item]));
    expect(byId.a).toMatchObject({ lane: 0, laneCount: 2 });
    expect(byId.b).toMatchObject({ lane: 1, laneCount: 2 });
    expect(byId.c).toMatchObject({ lane: 0, laneCount: 1 });
  });

  it("does not overlap a block that starts when another ends", () => {
    const placed = placeSideBySide([
      { id: "early", start: 600, end: 660 },
      { id: "next", start: 660, end: 720 },
    ]);
    expect(placed.map((item) => item.laneCount)).toEqual([1, 1]);
  });

  it("clips to the visible window and shades the closed gaps", () => {
    expect(clipToWindow(8 * 60, 11 * 60, 9 * 60, 18 * 60)).toEqual({
      start: 9 * 60,
      end: 11 * 60,
    });
    expect(clipToWindow(7 * 60, 8 * 60, 9 * 60, 18 * 60)).toBeNull();
    expect(closedGaps([{ start: 10 * 60, end: 14 * 60 }], 9 * 60, 18 * 60)).toEqual([
      { start: 9 * 60, end: 10 * 60 },
      { start: 14 * 60, end: 18 * 60 },
    ]);
    expect(containsMinute([{ start: 10 * 60, end: 14 * 60 }], 10 * 60)).toBe(true);
    expect(containsMinute([{ start: 10 * 60, end: 14 * 60 }], 14 * 60)).toBe(false);
    expect(snapMinutes(10 * 60 + 20, 15)).toBe(10 * 60 + 15);
  });

  it("reads wall time in America/Mexico_City, including the next midnight", () => {
    expect(minutesOnDay("2026-10-10T15:00:00.000Z", "2026-10-10", "America/Mexico_City")).toBe(
      9 * 60
    );
    expect(minutesOnDay("2026-10-11T06:00:00.000Z", "2026-10-10", "America/Mexico_City")).toBe(
      24 * 60
    );
    expect(minutesOnDay("2026-10-10T05:30:00.000Z", "2026-10-10", "America/Mexico_City")).toBe(0);
    expect(wallMinuteToUtc("2026-10-10", 9 * 60, "America/Mexico_City")).toBe(
      "2026-10-10T15:00:00.000Z"
    );
  });
});
