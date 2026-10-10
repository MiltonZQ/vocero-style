import { describe, expect, it } from "vitest";
import { buildBoard } from "../../src/server/agenda/board";

/**
 * T076 — pure board grouping.
 * Columns are active staff plus inactive staff with a future session.
 * Shop blocks stay outside the columns. Day bounds follow the business zone.
 */

const shopHours = {
  mon: [{ start: "09:00", end: "14:00" }],
  sun: [{ start: "10:00", end: "14:00" }],
};

const staff = [
  {
    id: "st_active",
    displayName: "Nuria",
    jobTitle: "Color",
    active: true,
    color: "#111111",
    position: 1,
    weeklyHours: null,
  },
  {
    id: "st_gone",
    displayName: "Luis",
    jobTitle: "Corte",
    active: false,
    color: "#222222",
    position: 2,
    weeklyHours: { mon: [{ start: "10:00", end: "13:00" }] },
  },
  {
    id: "st_past",
    displayName: "Marta",
    jobTitle: "Color",
    active: false,
    color: null,
    position: 0,
    weeklyHours: null,
  },
  {
    id: "st_other",
    displayName: "Rosa",
    jobTitle: "Recepción",
    active: true,
    color: "#333333",
    position: 3,
    weeklyHours: { mon: [{ start: "08:00", end: "18:00" }] },
  },
];

describe("buildBoard", () => {
  it("groups one Madrid day and clips staff hours to the shop", () => {
    const board = buildBoard({
      timeZone: "Europe/Madrid",
      from: "2026-01-05",
      days: 1,
      now: new Date("2026-01-05T08:00:00.000Z"),
      shopHours,
      staff,
      rows: [
        {
          id: "bk_session",
          kind: "session",
          staffId: "st_active",
          status: "confirmed",
          startUtc: new Date("2026-01-05T09:00:00.000Z"),
          endUtc: new Date("2026-01-05T10:00:00.000Z"),
          notes: null,
        },
        {
          id: "bk_personal",
          kind: "block",
          staffId: "st_active",
          status: "confirmed",
          startUtc: new Date("2026-01-05T11:00:00.000Z"),
          endUtc: new Date("2026-01-05T12:00:00.000Z"),
          notes: "Comida",
        },
        {
          id: "bk_shop",
          kind: "block",
          staffId: null,
          status: "confirmed",
          startUtc: new Date("2026-01-05T12:00:00.000Z"),
          endUtc: new Date("2026-01-05T13:00:00.000Z"),
          notes: "Inventario",
        },
        {
          id: "bk_old",
          kind: "session",
          staffId: "st_past",
          status: "confirmed",
          startUtc: new Date("2026-01-05T07:00:00.000Z"),
          endUtc: new Date("2026-01-05T07:30:00.000Z"),
          notes: null,
        },
      ],
    });

    expect(board.days).toEqual([
      {
        date: "2026-01-05",
        startUtc: "2026-01-04T23:00:00.000Z",
        endUtc: "2026-01-05T23:00:00.000Z",
      },
    ]);
    expect(board.columns.map((column) => column.staffId)).toEqual([
      "st_active",
      "st_other",
    ]);
    const nuria = board.columns[0];
    expect(nuria?.needsReassignment).toBe(false);
    expect(nuria?.days[0]?.hours).toEqual([{ start: "09:00", end: "14:00" }]);
    expect(nuria?.days[0]?.bookings.map((booking) => booking.id)).toEqual([
      "bk_session",
      "bk_personal",
    ]);
    expect(board.columns[1]?.days[0]?.hours).toEqual([
      { start: "09:00", end: "14:00" },
    ]);
    expect(board.shopBlocks.map((block) => block.id)).toEqual(["bk_shop"]);
    expect(board.shopBlocks[0]).toMatchObject({ staffId: null, notes: "Inventario" });
    expect(JSON.stringify(board.columns)).not.toContain("bk_shop");
  });

  it("keeps an inactive professional who still has a future session", () => {
    const board = buildBoard({
      timeZone: "Europe/Madrid",
      from: "2026-01-05",
      days: 1,
      now: new Date("2026-01-05T08:30:00.000Z"),
      shopHours,
      staff,
      rows: [
        {
          id: "bk_future",
          kind: "session",
          staffId: "st_gone",
          status: "confirmed",
          startUtc: new Date("2026-01-05T10:00:00.000Z"),
          endUtc: new Date("2026-01-05T11:00:00.000Z"),
          notes: null,
        },
        {
          id: "bk_cancel",
          kind: "session",
          staffId: "st_past",
          status: "cancelled",
          startUtc: new Date("2026-01-05T15:00:00.000Z"),
          endUtc: new Date("2026-01-05T16:00:00.000Z"),
          notes: null,
        },
      ],
    });
    const ids = board.columns.map((column) => [column.staffId, column.needsReassignment]);
    expect(ids).toContainEqual(["st_gone", true]);
    expect(ids.map(([id]) => id)).not.toContain("st_past");
    const luis = board.columns.find((column) => column.staffId === "st_gone");
    expect(luis?.days[0]?.hours).toEqual([{ start: "10:00", end: "13:00" }]);
  });

  it("filters by staffId and jobTitle", () => {
    const byTitle = buildBoard({
      timeZone: "Europe/Madrid",
      from: "2026-01-05",
      days: 1,
      now: new Date("2026-01-05T08:00:00.000Z"),
      jobTitle: "Color",
      shopHours,
      staff,
      rows: [],
    });
    expect(byTitle.columns.map((column) => column.staffId)).toEqual(["st_active"]);

    const byId = buildBoard({
      timeZone: "Europe/Madrid",
      from: "2026-01-05",
      days: 1,
      now: new Date("2026-01-05T08:00:00.000Z"),
      staffId: "st_other",
      shopHours,
      staff,
      rows: [],
    });
    expect(byId.columns.map((column) => column.staffId)).toEqual(["st_other"]);
  });

  it("uses a 23 hour New York spring-forward day and seven local dates", () => {
    const one = buildBoard({
      timeZone: "America/New_York",
      from: "2026-03-08",
      days: 1,
      now: new Date("2026-03-08T12:00:00.000Z"),
      shopHours: { sun: [{ start: "10:00", end: "14:00" }] },
      staff: [staff[0]!],
      rows: [],
    });
    expect(one.days).toEqual([
      {
        date: "2026-03-08",
        startUtc: "2026-03-08T05:00:00.000Z",
        endUtc: "2026-03-09T04:00:00.000Z",
      },
    ]);

    const week = buildBoard({
      timeZone: "America/New_York",
      from: "2026-03-08",
      days: 7,
      now: new Date("2026-03-08T12:00:00.000Z"),
      shopHours: {},
      staff: [],
      rows: [],
    });
    expect(week.days.map((day) => day.date)).toEqual([
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
      "2026-03-11",
      "2026-03-12",
      "2026-03-13",
      "2026-03-14",
    ]);
    expect(week.days[0]?.startUtc).toBe("2026-03-08T05:00:00.000Z");
    expect(week.days[6]?.endUtc).toBe("2026-03-15T04:00:00.000Z");
  });

  it("uses a 23 hour Madrid spring-forward day and a 25 hour New York fall-back day", () => {
    const madrid = buildBoard({
      timeZone: "Europe/Madrid",
      from: "2026-03-29",
      days: 1,
      now: new Date("2026-03-29T12:00:00.000Z"),
      shopHours: {},
      staff: [],
      rows: [],
    });
    expect(madrid.days).toEqual([
      {
        date: "2026-03-29",
        startUtc: "2026-03-28T23:00:00.000Z",
        endUtc: "2026-03-29T22:00:00.000Z",
      },
    ]);

    const week = buildBoard({
      timeZone: "Europe/Madrid",
      from: "2026-03-29",
      days: 7,
      now: new Date("2026-03-29T12:00:00.000Z"),
      shopHours: {},
      staff: [],
      rows: [],
    });
    expect(week.days.map((day) => day.date)).toEqual([
      "2026-03-29",
      "2026-03-30",
      "2026-03-31",
      "2026-04-01",
      "2026-04-02",
      "2026-04-03",
      "2026-04-04",
    ]);
    expect(week.days[6]?.endUtc).toBe("2026-04-04T22:00:00.000Z");

    const fallBack = buildBoard({
      timeZone: "America/New_York",
      from: "2026-11-01",
      days: 1,
      now: new Date("2026-11-01T12:00:00.000Z"),
      shopHours: {},
      staff: [],
      rows: [],
    });
    expect(fallBack.days).toEqual([
      {
        date: "2026-11-01",
        startUtc: "2026-11-01T04:00:00.000Z",
        endUtc: "2026-11-02T05:00:00.000Z",
      },
    ]);
  });
});
