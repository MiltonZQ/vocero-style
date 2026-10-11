import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AvailableSlot } from "@/server/agenda/availability";

/**
 * 019 — Offers by preferred day and hours.
 *
 * The pure planner is tested directly; the IO wrapper runs with the
 * availability engine, settings and offer store replaced by fakes.
 */

const settings = {
  timezone: "America/Mexico_City",
  minNoticeHours: 2,
  maxDaysAhead: 7,
};
// Sunday 2026-10-11, 10:00 local (UTC-6, no DST).
const NOW = new Date("2026-10-11T16:00:00Z");

/** A slot at local `HH:mm` of local `day`, owned by `staff`. */
function slot(day: string, hhmm: string, staff = "st_charly", name = "Charly"): AvailableSlot {
  const start = new Date(`${day}T${hhmm}:00-06:00`);
  return {
    startUtc: start.toISOString(),
    endUtc: new Date(start.getTime() + 30 * 60_000).toISOString(),
    label: `${day} ${hhmm}`,
    staffId: staff,
    staffName: name,
    serviceId: "sv_fade",
    durationMinutes: 30,
  };
}

function dayOf(day: string, hours: string[], staff?: string, name?: string): AvailableSlot[] {
  return hours.map((h) => slot(day, h, staff, name));
}

const MON = "2026-10-12";
const TUE = "2026-10-13";
const WED = "2026-10-14";

const { selectPreferenceSlots, buildOffersMessage } = await import(
  "@/server/agenda/preference-offers"
);

const MORNING_AND_EVENING = [
  ...dayOf(MON, ["10:00", "11:00", "17:00", "18:00", "19:00"]),
  ...dayOf(TUE, ["10:30", "16:00", "17:30"]),
];

describe("selectPreferenceSlots - window by day", () => {
  it("keeps only the requested day", () => {
    const plan = selectPreferenceSlots({
      when: { day: "martes" },
      now: NOW,
      settings,
      slots: MORNING_AND_EVENING,
    });
    expect(plan.kind).toBe("match");
    expect(plan.slots.map((s) => s.time)).toEqual(["10:30", "16:00", "17:30"]);
    expect(plan.windowLabel).toBe("el martes 13 de octubre");
  });

  it("applies from/to inside that day", () => {
    const plan = selectPreferenceSlots({
      when: { day: "lunes", from: "17:00", to: "19:00" },
      now: NOW,
      settings,
      slots: MORNING_AND_EVENING,
    });
    expect(plan.kind).toBe("match");
    // `to` is exclusive: the 19:00 start falls outside.
    expect(plan.slots.map((s) => s.time)).toEqual(["17:00", "18:00"]);
  });
});

describe("selectPreferenceSlots - daily hours without a day", () => {
  it("filters every day of the horizon by from/to", () => {
    const plan = selectPreferenceSlots({
      when: { from: "14:00", to: "19:00" },
      now: NOW,
      settings,
      slots: MORNING_AND_EVENING,
    });
    expect(plan.kind).toBe("match");
    expect(plan.slots.map((s) => `${s.dayIso}@${s.time}`)).toEqual([
      "2026-10-12@17:00",
      "2026-10-12@18:00",
      "2026-10-13@16:00",
      "2026-10-13@17:30",
    ]);
    expect(plan.windowLabel).toBe("los próximos días de 14:00 a 19:00");
  });

  it("supports a lower bound only", () => {
    const plan = selectPreferenceSlots({
      when: { from: "18:00" },
      now: NOW,
      settings,
      slots: MORNING_AND_EVENING,
    });
    expect(plan.slots.map((s) => s.time)).toEqual(["18:00", "19:00"]);
  });
});

describe("selectPreferenceSlots - no preference", () => {
  it("returns the nearest slots, as before", () => {
    for (const when of [null, {}, { day: "  " }]) {
      const plan = selectPreferenceSlots({ when, now: NOW, settings, slots: MORNING_AND_EVENING });
      expect(plan.kind).toBe("match");
      expect(plan.windowLabel).toBeNull();
      expect(plan.slots[0]?.time).toBe("10:00");
    }
  });
});

describe("selectPreferenceSlots - empty window fallback", () => {
  it("falls back to the nearest slots of the same staff outside the window", () => {
    const plan = selectPreferenceSlots({
      when: { day: "miércoles" },
      now: NOW,
      settings,
      slots: MORNING_AND_EVENING,
    });
    expect(plan.kind).toBe("fallback_nearest");
    expect(plan.fallback).toEqual({ reason: "empty", label: "el miércoles 14 de octubre" });
    expect(plan.slots[0]?.time).toBe("10:00");
  });

  it("when the chosen staff has nothing at all, offers other staff inside the window", () => {
    const plan = selectPreferenceSlots({
      when: { day: "martes" },
      now: NOW,
      settings,
      slots: [],
      otherStaffSlots: [
        ...dayOf(TUE, ["12:00", "13:00"], "st_luis", "Luis"),
        ...dayOf(MON, ["12:00"], "st_ana", "Ana"),
      ],
    });
    expect(plan.kind).toBe("fallback_other_staff");
    expect(plan.slots.map((s) => [s.staffName, s.time])).toEqual([
      ["Luis", "12:00"],
      ["Luis", "13:00"],
    ]);
  });

  it("keeps one slot per instant when several other staff are free at once", () => {
    const plan = selectPreferenceSlots({
      when: { day: "martes" },
      now: NOW,
      settings,
      slots: [],
      otherStaffSlots: [
        ...dayOf(TUE, ["12:00"], "st_luis", "Luis"),
        ...dayOf(TUE, ["12:00"], "st_ana", "Ana"),
      ],
    });
    expect(plan.slots).toHaveLength(1);
  });

  it("names the other staff who ARE free in the window when the chosen one is not", () => {
    const plan = selectPreferenceSlots({
      when: { day: "miércoles" },
      now: NOW,
      settings,
      slots: MORNING_AND_EVENING,
      otherStaffSlots: [...dayOf(WED, ["12:00"], "st_luis", "Luis")],
    });
    expect(plan.kind).toBe("fallback_nearest");
    expect(plan.alternativeStaffNames).toEqual(["Luis"]);
  });

  it("reports none when there is nothing anywhere", () => {
    const plan = selectPreferenceSlots({
      when: { day: "martes" },
      now: NOW,
      settings,
      slots: [],
      otherStaffSlots: [],
    });
    expect(plan.kind).toBe("none");
    expect(plan.slots).toEqual([]);
  });
});

describe("selectPreferenceSlots - unresolvable days", () => {
  it("too_far: explains the limit and offers the nearest valid slots", () => {
    const plan = selectPreferenceSlots({
      when: { day: "2026-12-25" },
      now: NOW,
      settings,
      slots: MORNING_AND_EVENING,
    });
    expect(plan.kind).toBe("fallback_nearest");
    expect(plan.fallback?.reason).toBe("too_far");
    expect(plan.slots[0]?.time).toBe("10:00");
  });

  it("past: explains and offers the nearest valid slots", () => {
    const plan = selectPreferenceSlots({
      when: { day: "2026-10-09" },
      now: NOW,
      settings,
      slots: MORNING_AND_EVENING,
    });
    expect(plan.fallback?.reason).toBe("past");
    expect(plan.slots.length).toBeGreaterThan(0);
  });

  it("invalid hours do not crash: nearest slots", () => {
    const plan = selectPreferenceSlots({
      when: { from: "tarde" },
      now: NOW,
      settings,
      slots: MORNING_AND_EVENING,
    });
    expect(plan.fallback?.reason).toBe("invalid");
    expect(plan.slots.length).toBeGreaterThan(0);
  });
});

describe("buildOffersMessage", () => {
  const msgOpts = { ...settings, staffName: null as string | null };

  it("numbers the first three options", () => {
    const plan = selectPreferenceSlots({
      when: { day: "lunes", from: "10:00", to: "12:00" },
      now: NOW,
      settings,
      slots: dayOf(MON, ["10:00", "10:30", "11:00", "11:30"]),
    });
    const text = buildOffersMessage(plan, msgOpts);
    expect(text).toContain("el lunes 12 de octubre de 10:00 a 12:00");
    expect(text).toMatch(/1\) .*10:00/);
    expect(text).toMatch(/2\) .*10:30/);
    expect(text).toMatch(/3\) .*11:00/);
    expect(text).not.toContain("4)");
    expect(text).toContain("número");
  });

  it("states that the window had nothing and what is offered instead", () => {
    const plan = selectPreferenceSlots({
      when: { day: "miércoles" },
      now: NOW,
      settings,
      slots: MORNING_AND_EVENING,
    });
    const text = buildOffersMessage(plan, { ...msgOpts, staffName: "Charly" });
    expect(text).toContain("Con Charly no tengo horarios el miércoles 14 de octubre");
    expect(text).toContain("más cercano");
  });

  it("explains the booking horizon for too_far", () => {
    const plan = selectPreferenceSlots({
      when: { day: "2026-12-25" },
      now: NOW,
      settings,
      slots: MORNING_AND_EVENING,
    });
    expect(buildOffersMessage(plan, msgOpts)).toContain("7 días");
  });

  it("explains the notice for past", () => {
    const plan = selectPreferenceSlots({
      when: { day: "2026-10-09" },
      now: NOW,
      settings,
      slots: MORNING_AND_EVENING,
    });
    expect(buildOffersMessage(plan, msgOpts)).toMatch(/ya pasó|anticipación/);
  });

  it("names the staff on each line when another barber is offered", () => {
    const plan = selectPreferenceSlots({
      when: { day: "martes" },
      now: NOW,
      settings,
      slots: [],
      otherStaffSlots: dayOf(TUE, ["12:00"], "st_luis", "Luis"),
    });
    const text = buildOffersMessage(plan, { ...msgOpts, staffName: "Charly" });
    expect(text).toContain("Con Charly no tengo horarios");
    expect(text).toContain("con Luis");
  });

  it("mentions other free staff without making them bookable options", () => {
    const plan = selectPreferenceSlots({
      when: { day: "miércoles" },
      now: NOW,
      settings,
      slots: MORNING_AND_EVENING,
      otherStaffSlots: dayOf(WED, ["12:00"], "st_luis", "Luis"),
    });
    const text = buildOffersMessage(plan, { ...msgOpts, staffName: "Charly" });
    expect(text).toContain("Luis");
    expect(text.match(/\d\) /g)).toHaveLength(3);
  });

  it("puts the existing-booking notice first", () => {
    const plan = selectPreferenceSlots({ when: null, now: NOW, settings, slots: MORNING_AND_EVENING });
    const text = buildOffersMessage(plan, { ...msgOpts, notice: "Ya tienes una cita." });
    expect(text.startsWith("Ya tienes una cita.")).toBe(true);
  });
});

/* ------------------------------ IO wrapper ------------------------------ */

const replaceOffers = vi.fn(async (..._args: unknown[]) => {});
const computeAvailability = vi.fn(
  async (_org: string, _opts: { staffId: string }): Promise<AvailableSlot[]> => []
);

vi.mock("@/server/agenda/settings", () => ({
  getSettings: async () => ({
    weeklyHours: {},
    slotMinutes: 30,
    bufferMinutes: 0,
    minNoticeHours: 2,
    maxDaysAhead: 7,
    timezone: "America/Mexico_City",
    connector: "enlace-fijo",
    meetingLink: null,
  }),
}));
vi.mock("@/server/agenda/availability", () => ({
  computeAvailability: (org: string, opts: { staffId: string }) => computeAvailability(org, opts),
}));
vi.mock("@/server/agenda/offers", () => ({
  replaceOffers: (...args: unknown[]) => replaceOffers(...args),
  clearOffers: async () => {},
}));

const { offerByPreference } = await import("@/server/agenda/preference-offers");

const service = {
  id: "sv_fade",
  name: "Fade",
  staff: [
    { id: "st_charly", displayName: "Charly" },
    { id: "st_luis", displayName: "Luis" },
  ],
};

beforeEach(() => {
  replaceOffers.mockClear();
  computeAvailability.mockReset();
});

describe("offerByPreference", () => {
  it("stores every spread slot as an offer and shows three", async () => {
    computeAvailability.mockResolvedValue(MORNING_AND_EVENING);
    const turn = await offerByPreference({
      organizationId: "org1",
      conversationId: "cv1",
      service,
      staffChoice: "st_charly",
      when: { day: "lunes", from: "17:00" },
      now: NOW,
    });
    expect(turn.ok).toBe(true);
    expect(turn.offered).toBe(3);
    const stored = replaceOffers.mock.calls[0]?.[2] as Array<{
      staffId: string;
      anyStaff: boolean;
      serviceId: string;
    }>;
    expect(stored).toHaveLength(3);
    expect(stored[0]).toMatchObject({ staffId: "st_charly", anyStaff: false, serviceId: "sv_fade" });
  });

  it("asks the engine for 'any' staff and flags the offers as any-staff", async () => {
    computeAvailability.mockResolvedValue(MORNING_AND_EVENING);
    await offerByPreference({
      organizationId: "org1",
      conversationId: "cv1",
      service,
      staffChoice: "any",
      when: null,
      now: NOW,
    });
    expect(computeAvailability.mock.calls[0]?.[1].staffId).toBe("any");
    const stored = replaceOffers.mock.calls[0]?.[2] as Array<{ anyStaff: boolean }>;
    expect(stored.every((s) => s.anyStaff)).toBe(true);
  });

  it("only queries the other staff when the window is empty for the chosen one", async () => {
    computeAvailability.mockImplementation(async (_org, opts) =>
      opts.staffId === "st_charly" ? MORNING_AND_EVENING : []
    );
    await offerByPreference({
      organizationId: "org1",
      conversationId: "cv1",
      service,
      staffChoice: "st_charly",
      when: { day: "lunes" },
      now: NOW,
    });
    expect(computeAvailability).toHaveBeenCalledTimes(1);

    computeAvailability.mockClear();
    await offerByPreference({
      organizationId: "org1",
      conversationId: "cv1",
      service,
      staffChoice: "st_charly",
      when: { day: "miércoles" },
      now: NOW,
    });
    expect(computeAvailability.mock.calls.map((c) => c[1].staffId).sort()).toEqual([
      "st_charly",
      "st_luis",
    ]);
  });

  it("offers the other barber's slots when the chosen one has nothing at all", async () => {
    computeAvailability.mockImplementation(async (_org, opts) =>
      opts.staffId === "st_luis" ? dayOf(TUE, ["12:00"], "st_luis", "Luis") : []
    );
    const turn = await offerByPreference({
      organizationId: "org1",
      conversationId: "cv1",
      service,
      staffChoice: "st_charly",
      when: { day: "martes" },
      now: NOW,
    });
    expect(turn.ok).toBe(true);
    expect(turn.text).toContain("con Luis");
    const stored = replaceOffers.mock.calls[0]?.[2] as Array<{ staffId: string; anyStaff: boolean }>;
    expect(stored).toEqual([expect.objectContaining({ staffId: "st_luis", anyStaff: false })]);
  });

  it("returns a not-ok turn and stores nothing when no slot exists", async () => {
    computeAvailability.mockResolvedValue([]);
    const turn = await offerByPreference({
      organizationId: "org1",
      conversationId: "cv1",
      service,
      staffChoice: "any",
      when: null,
      now: NOW,
    });
    expect(turn.ok).toBe(false);
    expect(turn.offered).toBe(0);
    expect(replaceOffers).not.toHaveBeenCalled();
  });
});
