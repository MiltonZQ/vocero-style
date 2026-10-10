import { describe, expect, it } from "vitest";
import { validateBookingTarget } from "../../src/server/agenda/booking-target";
import { BookingError } from "../../src/server/agenda/booking-error";
import { AgendaHttpError } from "../../src/server/agenda/http";

/**
 * T049 — target checks and the price/duration snapshot.
 * Inactive or not offered → AgendaHttpError service_not_offered.
 * Outside effective hours or over a block → BookingError slot_taken.
 * The returned snapshot does not follow later catalog edits.
 */

const shop = {
  mon: [
    { start: "09:00", end: "13:00" },
    { start: "16:00", end: "20:00" },
  ],
};

const staff = {
  id: "st_a",
  active: true,
  weeklyHours: null,
};

const service = {
  id: "sv_dye",
  active: true,
  durationMinutes: 60,
  priceCents: 3500,
  currency: "EUR",
};

const offered = { active: true, durationMinutes: null as number | null };

const base = {
  staff,
  service,
  staffService: offered,
  shopHours: shop,
  blocks: [] as Array<{ staffId: string | null; startUtc: Date; endUtc: Date }>,
  startUtc: new Date("2026-01-05T08:00:00.000Z"),
  timeZone: "Europe/Madrid",
};

describe("validateBookingTarget", () => {
  it("copies duration, price, and currency into a snapshot", () => {
    const liveService = { ...service, durationMinutes: 60, priceCents: 3500, currency: "EUR" };
    const link = { active: true, durationMinutes: 45 };
    const snapshot = validateBookingTarget({
      ...base,
      service: liveService,
      staffService: link,
    });
    liveService.durationMinutes = 15;
    liveService.priceCents = 1;
    liveService.currency = "USD";
    link.durationMinutes = 10;
    expect(snapshot).toEqual({
      durationMinutes: 45,
      priceCents: 3500,
      currency: "EUR",
    });
  });

  it("falls back to the catalog duration when the professional has no override", () => {
    const snapshot = validateBookingTarget(base);
    expect(snapshot.durationMinutes).toBe(60);
    expect(snapshot.priceCents).toBe(3500);
    expect(snapshot.currency).toBe("EUR");
  });

  it("rejects an inactive service, an inactive professional, and a service they do not offer", () => {
    expect(() =>
      validateBookingTarget({ ...base, service: { ...service, active: false } }),
    ).toThrow(AgendaHttpError);
    expect(() => validateBookingTarget({ ...base, service: null })).toThrow(AgendaHttpError);
    expect(() =>
      validateBookingTarget({ ...base, staff: { ...staff, active: false } }),
    ).toThrow(AgendaHttpError);
    expect(() => validateBookingTarget({ ...base, staffService: null })).toThrow(AgendaHttpError);
    expect(() =>
      validateBookingTarget({
        ...base,
        staffService: { active: false, durationMinutes: 30 },
      }),
    ).toThrow(AgendaHttpError);

    try {
      validateBookingTarget({ ...base, staffService: null });
      expect.fail("expected service_not_offered");
    } catch (error) {
      expect(error).toBeInstanceOf(AgendaHttpError);
      expect(error).not.toBeInstanceOf(BookingError);
      expect((error as AgendaHttpError).code).toBe("service_not_offered");
    }
  });

  it("rejects a start outside effective hours, including hours wider than the shop", () => {
    expect(() =>
      validateBookingTarget({
        ...base,
        startUtc: new Date("2026-01-05T07:00:00.000Z"),
      }),
    ).toThrow(BookingError);

    expect(() =>
      validateBookingTarget({
        ...base,
        staff: {
          ...staff,
          weeklyHours: { mon: [{ start: "08:00", end: "21:00" }] },
        },
        startUtc: new Date("2026-01-05T07:30:00.000Z"),
      }),
    ).toThrow(BookingError);

    try {
      validateBookingTarget({
        ...base,
        staff: {
          ...staff,
          weeklyHours: { mon: [{ start: "10:00", end: "16:00" }] },
        },
      });
      expect.fail("expected slot_taken");
    } catch (error) {
      expect(error).toBeInstanceOf(BookingError);
      expect((error as BookingError).code).toBe("slot_taken");
    }
  });

  it("rejects a service that crosses a split or runs past close", () => {
    expect(() =>
      validateBookingTarget({
        ...base,
        staffService: { active: true, durationMinutes: 90 },
        startUtc: new Date("2026-01-05T11:00:00.000Z"),
      }),
    ).toThrow(BookingError);

    expect(() =>
      validateBookingTarget({
        ...base,
        staffService: { active: true, durationMinutes: 90 },
        startUtc: new Date("2026-01-05T18:00:00.000Z"),
      }),
    ).toThrow(BookingError);

    const ok = validateBookingTarget({
      ...base,
      staffService: { active: true, durationMinutes: 90 },
      startUtc: new Date("2026-01-05T10:30:00.000Z"),
    });
    expect(ok.durationMinutes).toBe(90);
  });

  it("rejects overlap with a personal or shop block and allows the adjacent slot", () => {
    expect(() =>
      validateBookingTarget({
        ...base,
        blocks: [
          {
            staffId: "st_a",
            startUtc: new Date("2026-01-05T08:30:00.000Z"),
            endUtc: new Date("2026-01-05T09:00:00.000Z"),
          },
        ],
      }),
    ).toThrow(BookingError);

    expect(() =>
      validateBookingTarget({
        ...base,
        blocks: [
          {
            staffId: null,
            startUtc: new Date("2026-01-05T08:00:00.000Z"),
            endUtc: new Date("2026-01-05T08:15:00.000Z"),
          },
        ],
      }),
    ).toThrow(BookingError);

    const adjacent = validateBookingTarget({
      ...base,
      blocks: [
        {
          staffId: "st_b",
          startUtc: new Date("2026-01-05T08:00:00.000Z"),
          endUtc: new Date("2026-01-05T12:00:00.000Z"),
        },
        {
          staffId: "st_a",
          startUtc: new Date("2026-01-05T07:00:00.000Z"),
          endUtc: new Date("2026-01-05T08:00:00.000Z"),
        },
      ],
    });
    expect(adjacent.durationMinutes).toBe(60);
  });
});
