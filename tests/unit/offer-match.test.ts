import { describe, expect, it } from "vitest";
import { AgentAction } from "@/server/ai/actions";
import { matchOffer } from "@/server/agenda/offer-match";
import type { OfferedSlot } from "@/server/agenda/offers";

// Sunday 2026-10-11 10:00 in Mexico City (UTC-6, no DST).
const NOW = new Date("2026-10-11T16:00:00Z");
const ctx = { timezone: "America/Mexico_City", minNoticeHours: 2, maxDaysAhead: 7, now: NOW };

const at = (day: string, hhmm: string, staffId = "st_1"): OfferedSlot => ({
  startUtc: new Date(`${day}T${hhmm}:00-06:00`).toISOString(),
  label: `${day} ${hhmm}`,
  staffId,
  serviceId: "sv_1",
});

const MON_THREE = [at("2026-10-12", "09:00"), at("2026-10-12", "09:30"), at("2026-10-12", "10:00")];

describe("matchOffer", () => {
  it("matches by the time the client said", () => {
    expect(matchOffer(MON_THREE, { time: "09:30" }, ctx)).toEqual({ kind: "one", index: 1 });
  });

  it("matches by ordinal when there is no time", () => {
    expect(matchOffer(MON_THREE, { option: 3 }, ctx)).toEqual({ kind: "one", index: 2 });
    expect(matchOffer(MON_THREE, { option: 1 }, ctx)).toEqual({ kind: "one", index: 0 });
  });

  it("an ordinal outside the offers matches nothing", () => {
    for (const option of [0, 4, 1.5, Number.NaN]) {
      expect(matchOffer(MON_THREE, { option }, ctx)).toEqual({ kind: "none" });
    }
  });

  it("time wins over the ordinal; the ordinal is the fallback", () => {
    expect(matchOffer(MON_THREE, { time: "10:00", option: 1 }, ctx)).toEqual({ kind: "one", index: 2 });
    expect(matchOffer(MON_THREE, { time: "15:00", option: 2 }, ctx)).toEqual({ kind: "one", index: 1 });
  });

  it("a time that was not offered matches nothing", () => {
    expect(matchOffer(MON_THREE, { time: "15:00" }, ctx)).toEqual({ kind: "none" });
  });

  it("uses the day to tell two days with the same time apart", () => {
    const offers = [at("2026-10-12", "10:00"), at("2026-10-13", "10:00")];
    expect(matchOffer(offers, { time: "10:00" }, ctx)).toEqual({ kind: "many" });
    expect(matchOffer(offers, { time: "10:00", day: "martes" }, ctx)).toEqual({ kind: "one", index: 1 });
    expect(matchOffer(offers, { time: "10:00", day: "mañana" }, ctx)).toEqual({ kind: "one", index: 0 });
  });

  it("a day alone picks the only offer of that day", () => {
    const offers = [at("2026-10-12", "19:00"), at("2026-10-13", "10:30")];
    expect(matchOffer(offers, { day: "martes" }, ctx)).toEqual({ kind: "one", index: 1 });
    expect(matchOffer(MON_THREE, { day: "lunes" }, ctx)).toEqual({ kind: "many" });
    expect(matchOffer(offers, { day: "viernes" }, ctx)).toEqual({ kind: "none" });
  });

  it("an unresolvable day does not veto a time that is unique", () => {
    expect(matchOffer(MON_THREE, { time: "09:30", day: "quincena" }, ctx)).toEqual({
      kind: "one",
      index: 1,
    });
  });

  it("two professionals free at the same instant are one choice", () => {
    const offers = [at("2026-10-12", "09:00", "st_1"), at("2026-10-12", "09:00", "st_2")];
    expect(matchOffer(offers, { time: "09:00" }, ctx)).toEqual({ kind: "one", index: 0 });
  });

  it("nothing said matches nothing", () => {
    expect(matchOffer(MON_THREE, {}, ctx)).toEqual({ kind: "none" });
  });
});

describe("book_slot action schema", () => {
  const parse = (v: unknown) => AgentAction.safeParse(v);

  it("accepts time, day and option in any combination, null meaning absent", () => {
    expect(parse({ action: "book_slot", time: "09:30" })).toMatchObject({
      success: true,
      data: { action: "book_slot", time: "09:30" },
    });
    expect(parse({ action: "book_slot", option: 2, time: null, day: null })).toMatchObject({
      success: true,
      data: { option: 2 },
    });
    expect(parse({ action: "book_slot", day: "martes", time: "10:00" }).success).toBe(true);
  });

  it("normalizes 9:30 to 09:30 and ignores a time it cannot read", () => {
    expect(parse({ action: "book_slot", time: "9:30" })).toMatchObject({ data: { time: "09:30" } });
    const bad = parse({ action: "book_slot", time: "por la tarde", option: 1 });
    expect(bad).toMatchObject({ success: true, data: { option: 1 } });
    expect(bad.success && bad.data.action === "book_slot" ? bad.data.time : "x").toBeUndefined();
  });

  it("a string option is coerced", () => {
    expect(parse({ action: "book_slot", option: "2" })).toMatchObject({ data: { option: 2 } });
  });
});
