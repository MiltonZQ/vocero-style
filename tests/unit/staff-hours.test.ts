import { describe, expect, it } from "vitest";
import { effectiveHours } from "@/server/agenda/hours";
import type { WeeklyHours } from "@/server/agenda/settings";

const shop: WeeklyHours = {
  mon: [
    { start: "09:00", end: "13:00" },
    { start: "15:00", end: "18:00" },
  ],
  tue: [{ start: "10:00", end: "14:00" }],
  wed: [{ start: "09:00", end: "18:00" }],
};

describe("effectiveHours", () => {
  it("sin horario propio devuelve el objeto del local y hereda", () => {
    const result = effectiveHours(null, shop);
    expect(result.inherits).toBe(true);
    expect(result.weeklyHours).toBe(shop);
  });

  it("recorta cada franja a la intersección y omite el día sin solape", () => {
    const staff: WeeklyHours = {
      mon: [{ start: "12:00", end: "17:00" }],
      tue: [{ start: "14:00", end: "16:00" }],
      wed: [{ start: "08:00", end: "20:00" }],
      thu: [{ start: "09:00", end: "12:00" }],
    };
    const result = effectiveHours(staff, shop);
    expect(result.inherits).toBe(false);
    expect(result.weeklyHours).toEqual({
      mon: [
        { start: "12:00", end: "13:00" },
        { start: "15:00", end: "17:00" },
      ],
      wed: [{ start: "09:00", end: "18:00" }],
    });
    expect(result.weeklyHours).not.toBe(shop);
    expect(shop.mon).toEqual([
      { start: "09:00", end: "13:00" },
      { start: "15:00", end: "18:00" },
    ]);
  });

  it("conserva una franja que ya cabe en el local", () => {
    const result = effectiveHours(
      { wed: [{ start: "11:00", end: "12:30" }] },
      shop
    );
    expect(result.inherits).toBe(false);
    expect(result.weeklyHours).toEqual({
      wed: [{ start: "11:00", end: "12:30" }],
    });
  });

  it("un horario propio vacío no hereda el del local", () => {
    const result = effectiveHours({}, shop);
    expect(result.inherits).toBe(false);
    expect(result.weeklyHours).toEqual({});
    expect(result.weeklyHours).not.toBe(shop);
  });

  it("el contacto exacto de dos franjas no es solape", () => {
    const result = effectiveHours(
      { mon: [{ start: "13:00", end: "15:00" }] },
      shop
    );
    expect(result.inherits).toBe(false);
    expect(result.weeklyHours).toEqual({});
  });
});
