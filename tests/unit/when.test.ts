import { describe, expect, it } from "vitest";
import { resolveWhen } from "@/server/agenda/when";

const settings = { timezone: "America/Mexico_City", minNoticeHours: 2, maxDaysAhead: 7 };
// Mexico City is UTC-6 all year since 2022 (no DST).
const at = (iso: string) => new Date(iso);

// Sunday 2026-10-11, 10:00 local.
const SUNDAY_MORNING = at("2026-10-11T16:00:00Z");

function ok(r: ReturnType<typeof resolveWhen>) {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r;
}

describe("resolveWhen - days", () => {
  it("'hoy' covers from now + notice to the end of the shop day", () => {
    const r = ok(resolveWhen({ day: "hoy" }, SUNDAY_MORNING, settings));
    expect(r.startUtc).toBe("2026-10-11T18:00:00.000Z"); // 12:00 local
    expect(r.endUtc).toBe("2026-10-12T06:00:00.000Z"); // local midnight
    expect(r.label).toBe("hoy");
  });

  it("'mañana' and 'manana' resolve to the next local day", () => {
    for (const day of ["mañana", "manana", "Mañana "]) {
      const r = ok(resolveWhen({ day }, SUNDAY_MORNING, settings));
      expect(r.startUtc).toBe("2026-10-12T06:00:00.000Z");
      expect(r.endUtc).toBe("2026-10-13T06:00:00.000Z");
      expect(r.label).toBe("mañana");
    }
  });

  it("'pasado mañana' is two days ahead", () => {
    const r = ok(resolveWhen({ day: "pasado mañana" }, SUNDAY_MORNING, settings));
    expect(r.startUtc).toBe("2026-10-13T06:00:00.000Z");
    expect(resolveWhen({ day: "pasado manana" }, SUNDAY_MORNING, settings).ok).toBe(true);
  });

  it("an explicit date resolves in the shop zone", () => {
    const r = ok(resolveWhen({ day: "2026-10-14" }, SUNDAY_MORNING, settings));
    expect(r.startUtc).toBe("2026-10-14T06:00:00.000Z");
    expect(r.label).toBe("el miércoles 14 de octubre");
  });

  it("weekday names roll to the NEXT occurrence: Sunday -> 'lunes'", () => {
    const r = ok(resolveWhen({ day: "lunes" }, SUNDAY_MORNING, settings));
    expect(r.startUtc).toBe("2026-10-12T06:00:00.000Z");
    expect(r.label).toBe("el lunes 12 de octubre");
  });

  it("accepts accents or none ('miércoles'/'miercoles', 'sábado'/'sabado')", () => {
    for (const day of ["miércoles", "miercoles"]) {
      expect(ok(resolveWhen({ day }, SUNDAY_MORNING, settings)).startUtc).toBe(
        "2026-10-14T06:00:00.000Z"
      );
    }
    for (const day of ["sábado", "sabado"]) {
      expect(ok(resolveWhen({ day }, SUNDAY_MORNING, settings)).startUtc).toBe(
        "2026-10-17T06:00:00.000Z"
      );
    }
  });

  it("today counts for a weekday while it is still possible", () => {
    const r = ok(resolveWhen({ day: "domingo" }, SUNDAY_MORNING, settings));
    expect(r.startUtc).toBe("2026-10-11T18:00:00.000Z");
  });

  it("a weekday equal to today ALWAYS means today, never next week", () => {
    const r = ok(resolveWhen({ day: "domingo" }, SUNDAY_MORNING, settings));
    expect(r.label).toBe("el domingo 11 de octubre");
    // Even when the window is over, it never silently rolls to next Sunday.
    const lateSunday = at("2026-10-12T04:30:00Z"); // Sun 22:30 local: notice runs past midnight
    expect(resolveWhen({ day: "domingo" }, lateSunday, settings)).toEqual({
      ok: false,
      reason: "past",
    });
  });

  it("uses the SHOP zone around midnight, not UTC", () => {
    // 22:30 Sunday local = 04:30 Monday UTC.
    const now = at("2026-10-12T04:30:00Z");
    const m = ok(resolveWhen({ day: "mañana" }, now, settings));
    // Monday local (not Tuesday), clamped to now + 2 h = 06:30Z.
    expect(m.startUtc).toBe("2026-10-12T06:30:00.000Z");
    expect(m.label).toBe("mañana");
    expect(resolveWhen({ day: "hoy" }, now, settings)).toEqual({ ok: false, reason: "past" });
  });
});

describe("resolveWhen - time of day", () => {
  it("applies from/to as shop wall clock", () => {
    const r = ok(resolveWhen({ day: "mañana", from: "16:00", to: "20:00" }, SUNDAY_MORNING, settings));
    expect(r.startUtc).toBe("2026-10-12T22:00:00.000Z");
    expect(r.endUtc).toBe("2026-10-13T02:00:00.000Z");
    expect(r.label).toBe("mañana de 16:00 a 20:00");
  });

  it("a missing 'to' runs to the end of the day, a missing 'from' starts at midnight", () => {
    const a = ok(resolveWhen({ day: "mañana", from: "16:00" }, SUNDAY_MORNING, settings));
    expect(a.endUtc).toBe("2026-10-13T06:00:00.000Z");
    expect(a.label).toBe("mañana después de las 16:00");
    const b = ok(resolveWhen({ day: "mañana", to: "12:00" }, SUNDAY_MORNING, settings));
    expect(b.startUtc).toBe("2026-10-12T06:00:00.000Z");
    expect(b.label).toBe("mañana antes de las 12:00");
  });

  it("clamps the start to now + minNoticeHours", () => {
    const r = ok(resolveWhen({ day: "hoy", from: "10:30" }, SUNDAY_MORNING, settings));
    expect(r.startUtc).toBe("2026-10-11T18:00:00.000Z"); // 12:00, not 10:30
  });

  it("'hoy' after closing is past when the window ended", () => {
    const r = resolveWhen({ day: "hoy", from: "08:00", to: "11:00" }, SUNDAY_MORNING, settings);
    expect(r).toEqual({ ok: false, reason: "past" });
  });

  it("rejects malformed or inverted times as invalid", () => {
    expect(resolveWhen({ day: "mañana", from: "25:00" }, SUNDAY_MORNING, settings)).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(resolveWhen({ day: "mañana", from: "18:00", to: "10:00" }, SUNDAY_MORNING, settings)).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(resolveWhen({ day: "mañana", from: "tarde" }, SUNDAY_MORNING, settings)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});

describe("resolveWhen - limits", () => {
  it("a missing day spans from the earliest bookable instant to maxDaysAhead", () => {
    const r = ok(resolveWhen({}, SUNDAY_MORNING, settings));
    expect(r.startUtc).toBe("2026-10-11T18:00:00.000Z");
    expect(r.endUtc).toBe("2026-10-19T06:00:00.000Z"); // end of today + 7
    expect(r.label).toBe("los próximos días");
  });

  it("a date past maxDaysAhead is too_far", () => {
    expect(resolveWhen({ day: "2026-10-19" }, SUNDAY_MORNING, settings)).toEqual({
      ok: false,
      reason: "too_far",
    });
    expect(resolveWhen({ day: "2026-10-18" }, SUNDAY_MORNING, settings).ok).toBe(true);
    expect(
      resolveWhen({ day: "viernes" }, SUNDAY_MORNING, { ...settings, maxDaysAhead: 3 })
    ).toEqual({ ok: false, reason: "too_far" });
  });

  it("a date before today is past", () => {
    expect(resolveWhen({ day: "2026-10-10" }, SUNDAY_MORNING, settings)).toEqual({
      ok: false,
      reason: "past",
    });
  });

  it("unknown day text and impossible dates are invalid", () => {
    for (const day of ["algún día", "2026-13-40", "2026-02-30"]) {
      expect(resolveWhen({ day }, SUNDAY_MORNING, settings)).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
  });

  it("minNoticeHours crossing midnight leaves no window for 'hoy' (past)", () => {
    const r = resolveWhen({ day: "hoy" }, at("2026-10-12T05:00:00Z"), settings); // 23:00 local
    expect(r).toEqual({ ok: false, reason: "past" });
  });
});
