import { describe, expect, it } from "vitest";
import { effectiveHours } from "../../src/server/agenda/hours";

/**
 * T046 — effective hours.
 * null inherits the shop object (same reference). Own hours are clipped to
 * shop open intervals. A day with no overlap is omitted. Splits stay splits.
 */

type Interval = { start: string; end: string };
type WeeklyHours = Partial<Record<string, Interval[]>>;

const shop: WeeklyHours = {
  mon: [
    { start: "09:00", end: "14:00" },
    { start: "16:00", end: "20:00" },
  ],
  tue: [{ start: "09:00", end: "18:00" }],
  wed: [{ start: "09:00", end: "13:00" }],
  thu: [{ start: "10:00", end: "14:00" }],
  fri: [{ start: "09:00", end: "17:00" }],
};

describe("effectiveHours", () => {
  it("inherits the shop object when staff hours are null", () => {
    const result = effectiveHours(null, shop);
    expect(result.inherits).toBe(true);
    expect(result.weeklyHours).toBe(shop);
  });

  it("does not copy shop hours on inherit, so later shop edits stay visible", () => {
    const live = {
      mon: [{ start: "09:00", end: "12:00" }],
    };
    const result = effectiveHours(null, live);
    live.mon = [{ start: "11:00", end: "15:00" }];
    expect(result.inherits).toBe(true);
    expect(result.weeklyHours).toBe(live);
    expect(result.weeklyHours.mon).toEqual([{ start: "11:00", end: "15:00" }]);
  });

  it("clips staff hours to the shop and reports inherits false", () => {
    const staff: WeeklyHours = {
      mon: [{ start: "08:00", end: "21:00" }],
      tue: [{ start: "10:00", end: "12:00" }],
    };
    const result = effectiveHours(staff, shop);
    expect(result.inherits).toBe(false);
    expect(result.weeklyHours).not.toBe(staff);
    expect(result.weeklyHours).not.toBe(shop);
    expect(result.weeklyHours.mon).toEqual([
      { start: "09:00", end: "14:00" },
      { start: "16:00", end: "20:00" },
    ]);
    expect(result.weeklyHours.tue).toEqual([{ start: "10:00", end: "12:00" }]);
  });

  it("keeps a partial overlap split when the shop day is split", () => {
    const staff: WeeklyHours = {
      mon: [{ start: "12:00", end: "18:00" }],
    };
    const result = effectiveHours(staff, shop);
    expect(result.inherits).toBe(false);
    expect(result.weeklyHours.mon).toEqual([
      { start: "12:00", end: "14:00" },
      { start: "16:00", end: "18:00" },
    ]);
  });

  it("omits a day with no overlap", () => {
    const staff: WeeklyHours = {
      wed: [{ start: "14:00", end: "18:00" }],
      thu: [{ start: "14:00", end: "14:00" }],
      fri: [{ start: "17:00", end: "21:00" }],
    };
    const result = effectiveHours(staff, shop);
    expect(result.inherits).toBe(false);
    expect(result.weeklyHours.wed).toBeUndefined();
    expect(result.weeklyHours.thu).toBeUndefined();
    expect(result.weeklyHours.fri).toBeUndefined();
    expect(Object.keys(result.weeklyHours)).not.toContain("wed");
  });

  it("omits a day the shop does not open", () => {
    const staff: WeeklyHours = {
      sat: [{ start: "10:00", end: "14:00" }],
      sun: [{ start: "10:00", end: "14:00" }],
    };
    const result = effectiveHours(staff, shop);
    expect(result.weeklyHours.sat).toBeUndefined();
    expect(result.weeklyHours.sun).toBeUndefined();
  });

  it("treats adjacent intervals as no overlap", () => {
    const staff: WeeklyHours = {
      tue: [{ start: "18:00", end: "21:00" }],
      fri: [{ start: "08:00", end: "09:00" }],
    };
    const result = effectiveHours(staff, shop);
    expect(result.weeklyHours.tue).toBeUndefined();
    expect(result.weeklyHours.fri).toBeUndefined();
  });

  it("keeps staff splits that fall inside one shop interval", () => {
    const staff: WeeklyHours = {
      tue: [
        { start: "09:00", end: "12:00" },
        { start: "13:00", end: "16:00" },
      ],
    };
    const result = effectiveHours(staff, shop);
    expect(result.weeklyHours.tue).toEqual([
      { start: "09:00", end: "12:00" },
      { start: "13:00", end: "16:00" },
    ]);
  });
});
