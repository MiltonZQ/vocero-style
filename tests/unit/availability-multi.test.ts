import { describe, expect, it } from "vitest";
import { buildServiceSlots } from "../../src/server/agenda/grid";

/**
 * T047 — service-duration grid.
 * Duration comes from the caller (staff override already resolved).
 * Slots step by stepMinutes, must finish inside one open interval,
 * and yield to sessions (plus buffer), personal blocks, and shop blocks.
 */

const MONDAY = {
  mon: [{ start: "09:00", end: "13:00" }],
};

const base = {
  timeZone: "Europe/Madrid",
  fromDate: "2026-01-05",
  days: 1,
  weeklyHours: MONDAY,
  durationMinutes: 60,
  stepMinutes: 60,
  bufferMinutes: 0,
  minNoticeMinutes: 0,
  windowDays: 14,
  now: new Date("2026-01-05T06:00:00.000Z"),
  staffId: "st_a",
  busy: [] as Array<{
    staffId: string | null;
    startUtc: string;
    endUtc: string;
    kind: "session" | "block";
    status?: string;
    isTest?: boolean;
    legacyOverlap?: boolean;
  }>,
};

function starts(slots: { startUtc: string }[]) {
  return slots.map((slot) => slot.startUtc);
}

describe("buildServiceSlots", () => {
  it("emits slots that finish at or before close", () => {
    const slots = buildServiceSlots(base);
    expect(starts(slots)).toEqual([
      "2026-01-05T08:00:00.000Z",
      "2026-01-05T09:00:00.000Z",
      "2026-01-05T10:00:00.000Z",
      "2026-01-05T11:00:00.000Z",
    ]);
    expect(slots[3]?.endUtc).toBe("2026-01-05T12:00:00.000Z");
  });

  it("rejects a 90 minute dye that would end after close", () => {
    const slots = buildServiceSlots({
      ...base,
      weeklyHours: { mon: [{ start: "09:00", end: "20:00" }] },
      durationMinutes: 90,
      stepMinutes: 30,
    });
    const localStarts = starts(slots);
    expect(localStarts).toContain("2026-01-05T17:30:00.000Z");
    expect(localStarts).not.toContain("2026-01-05T18:00:00.000Z");
    const last = slots.at(-1);
    expect(last?.startUtc).toBe("2026-01-05T17:30:00.000Z");
    expect(last?.endUtc).toBe("2026-01-05T19:00:00.000Z");
  });

  it("keeps split intervals split and does not bridge the gap", () => {
    const slots = buildServiceSlots({
      ...base,
      weeklyHours: {
        mon: [
          { start: "09:00", end: "13:00" },
          { start: "16:00", end: "20:00" },
        ],
      },
      durationMinutes: 90,
      stepMinutes: 30,
    });
    const got = starts(slots);
    expect(got).toContain("2026-01-05T10:30:00.000Z");
    expect(got).not.toContain("2026-01-05T11:00:00.000Z");
    expect(got).toContain("2026-01-05T15:00:00.000Z");
    expect(got).toContain("2026-01-05T17:30:00.000Z");
    expect(got).not.toContain("2026-01-05T18:00:00.000Z");
    expect(got).toHaveLength(12);
  });

  it("blocks a partial overlap and allows the adjacent next slot", () => {
    const blocked = buildServiceSlots({
      ...base,
      busy: [
        {
          staffId: "st_a",
          startUtc: "2026-01-05T08:30:00.000Z",
          endUtc: "2026-01-05T09:30:00.000Z",
          kind: "session",
          status: "confirmed",
        },
      ],
    });
    expect(starts(blocked)).toEqual([
      "2026-01-05T10:00:00.000Z",
      "2026-01-05T11:00:00.000Z",
    ]);

    const adjacent = buildServiceSlots({
      ...base,
      busy: [
        {
          staffId: "st_a",
          startUtc: "2026-01-05T08:00:00.000Z",
          endUtc: "2026-01-05T09:00:00.000Z",
          kind: "session",
          status: "confirmed",
        },
      ],
    });
    expect(starts(adjacent)).toEqual([
      "2026-01-05T09:00:00.000Z",
      "2026-01-05T10:00:00.000Z",
      "2026-01-05T11:00:00.000Z",
    ]);
  });

  it("applies buffer after a session and not after a block", () => {
    const withBuffer = buildServiceSlots({
      ...base,
      bufferMinutes: 15,
      busy: [
        {
          staffId: "st_a",
          startUtc: "2026-01-05T08:00:00.000Z",
          endUtc: "2026-01-05T09:00:00.000Z",
          kind: "session",
          status: "confirmed",
        },
      ],
    });
    expect(starts(withBuffer)).toEqual([
      "2026-01-05T10:00:00.000Z",
      "2026-01-05T11:00:00.000Z",
    ]);

    const blockNoBuffer = buildServiceSlots({
      ...base,
      bufferMinutes: 15,
      busy: [
        {
          staffId: "st_a",
          startUtc: "2026-01-05T08:00:00.000Z",
          endUtc: "2026-01-05T09:00:00.000Z",
          kind: "block",
        },
      ],
    });
    expect(starts(blockNoBuffer)).toEqual([
      "2026-01-05T09:00:00.000Z",
      "2026-01-05T10:00:00.000Z",
      "2026-01-05T11:00:00.000Z",
    ]);
  });

  it("honors a personal block and a shop block, and ignores another professional", () => {
    const slots = buildServiceSlots({
      ...base,
      busy: [
        {
          staffId: "st_a",
          startUtc: "2026-01-05T10:00:00.000Z",
          endUtc: "2026-01-05T11:00:00.000Z",
          kind: "block",
        },
        {
          staffId: null,
          startUtc: "2026-01-05T11:00:00.000Z",
          endUtc: "2026-01-05T12:00:00.000Z",
          kind: "block",
        },
        {
          staffId: "st_b",
          startUtc: "2026-01-05T08:00:00.000Z",
          endUtc: "2026-01-05T12:00:00.000Z",
          kind: "session",
          status: "confirmed",
        },
      ],
    });
    expect(starts(slots)).toEqual([
      "2026-01-05T08:00:00.000Z",
      "2026-01-05T09:00:00.000Z",
    ]);
  });

  it("ignores cancelled, test, and legacy-overlap sessions", () => {
    const slots = buildServiceSlots({
      ...base,
      busy: [
        {
          staffId: "st_a",
          startUtc: "2026-01-05T08:00:00.000Z",
          endUtc: "2026-01-05T09:00:00.000Z",
          kind: "session",
          status: "cancelled",
        },
        {
          staffId: "st_a",
          startUtc: "2026-01-05T09:00:00.000Z",
          endUtc: "2026-01-05T10:00:00.000Z",
          kind: "session",
          status: "confirmed",
          isTest: true,
        },
        {
          staffId: "st_a",
          startUtc: "2026-01-05T10:00:00.000Z",
          endUtc: "2026-01-05T11:00:00.000Z",
          kind: "session",
          status: "confirmed",
          legacyOverlap: true,
        },
      ],
    });
    expect(starts(slots)).toEqual([
      "2026-01-05T08:00:00.000Z",
      "2026-01-05T09:00:00.000Z",
      "2026-01-05T10:00:00.000Z",
      "2026-01-05T11:00:00.000Z",
    ]);
  });

  it("skips the missing hour on a New York spring-forward morning", () => {
    const slots = buildServiceSlots({
      ...base,
      timeZone: "America/New_York",
      fromDate: "2026-03-08",
      weeklyHours: { sun: [{ start: "01:00", end: "04:00" }] },
      now: new Date("2026-03-01T12:00:00.000Z"),
    });
    expect(slots).toEqual([
      {
        startUtc: "2026-03-08T06:00:00.000Z",
        endUtc: "2026-03-08T07:00:00.000Z",
      },
      {
        startUtc: "2026-03-08T07:00:00.000Z",
        endUtc: "2026-03-08T08:00:00.000Z",
      },
    ]);
  });

  it("skips the missing hour on a Madrid spring-forward morning", () => {
    const slots = buildServiceSlots({
      ...base,
      timeZone: "Europe/Madrid",
      fromDate: "2026-03-29",
      weeklyHours: { sun: [{ start: "01:00", end: "04:00" }] },
      now: new Date("2026-03-01T12:00:00.000Z"),
      windowDays: 40,
    });
    expect(slots).toEqual([
      {
        startUtc: "2026-03-29T00:00:00.000Z",
        endUtc: "2026-03-29T01:00:00.000Z",
      },
      {
        startUtc: "2026-03-29T01:00:00.000Z",
        endUtc: "2026-03-29T02:00:00.000Z",
      },
    ]);
  });

  it("drops slots inside the minimum notice window", () => {
    const slots = buildServiceSlots({
      ...base,
      now: new Date("2026-01-05T08:30:00.000Z"),
      minNoticeMinutes: 60,
    });
    expect(starts(slots)).toEqual([
      "2026-01-05T10:00:00.000Z",
      "2026-01-05T11:00:00.000Z",
    ]);
  });
});
