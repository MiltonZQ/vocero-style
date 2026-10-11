import { describe, expect, it } from "vitest";
import { guardAction, type BotAction, type GuardContext } from "@/server/ai/guards";

const ctx = (over: Partial<GuardContext> = {}): GuardContext => ({
  draft: { serviceId: "sv_1", staffChoice: "st_1" },
  offerCount: 0,
  ...over,
});

describe("guardAction - book_slot", () => {
  it("runs with a valid option when offers exist", () => {
    const a: BotAction = { action: "book_slot", option: 2 };
    expect(guardAction(a, "ready", ctx({ offerCount: 3 }))).toEqual({ kind: "run", action: a });
  });

  it("without offers, redirects to the step that is missing", () => {
    const a: BotAction = { action: "book_slot", option: 1 };
    expect(guardAction(a, "need_slot", ctx())).toMatchObject({
      kind: "redirect",
      directive: { type: "offer_slots" },
    });
    expect(guardAction(a, "need_service", ctx({ draft: { serviceId: null, staffChoice: null } }))).toMatchObject(
      { kind: "redirect", directive: { type: "ask_service" } }
    );
    expect(guardAction(a, "need_staff", ctx({ draft: { serviceId: "sv_1", staffChoice: null } }))).toMatchObject(
      { kind: "redirect", directive: { type: "ask_staff" } }
    );
  });

  it("an option outside the offered range asks which one", () => {
    for (const option of [0, 4, 1.5, Number.NaN]) {
      expect(
        guardAction({ action: "book_slot", option }, "ready", ctx({ offerCount: 3 }))
      ).toMatchObject({ kind: "redirect", directive: { type: "ask_option" } });
    }
  });
});

describe("guardAction - book_slot by time", () => {
  it("runs with a time or a day and no ordinal", () => {
    const byTime: BotAction = { action: "book_slot", time: "09:30" };
    expect(guardAction(byTime, "ready", ctx({ offerCount: 3 }))).toEqual({ kind: "run", action: byTime });
    const byDay: BotAction = { action: "book_slot", day: "martes" };
    expect(guardAction(byDay, "ready", ctx({ offerCount: 3 }))).toEqual({ kind: "run", action: byDay });
  });

  it("a stray ordinal does not block a time the client did say", () => {
    const a: BotAction = { action: "book_slot", time: "10:00", option: 9 };
    expect(guardAction(a, "ready", ctx({ offerCount: 3 }))).toEqual({ kind: "run", action: a });
  });

  it("with nothing to go on, asks which time", () => {
    expect(guardAction({ action: "book_slot" }, "ready", ctx({ offerCount: 3 }))).toMatchObject({
      kind: "redirect",
      directive: { type: "ask_option" },
    });
  });

  it("without offers a time still redirects to the missing step", () => {
    expect(guardAction({ action: "book_slot", time: "09:30" }, "need_slot", ctx())).toMatchObject({
      kind: "redirect",
      directive: { type: "offer_slots" },
    });
  });
});

describe("guardAction - update_draft", () => {
  it("staff without any service known asks for the service", () => {
    const empty = ctx({ draft: { serviceId: null, staffChoice: null } });
    expect(
      guardAction({ action: "update_draft", staff: "Carlos" }, "need_service", empty)
    ).toMatchObject({ kind: "redirect", directive: { type: "ask_service" } });
  });

  it("staff plus a service in the same action is fine", () => {
    const empty = ctx({ draft: { serviceId: null, staffChoice: null } });
    const a: BotAction = { action: "update_draft", service: "corte", staff: "Carlos" };
    expect(guardAction(a, "need_service", empty)).toEqual({ kind: "run", action: a });
  });

  it("staff with a service already in the draft is fine", () => {
    const a: BotAction = { action: "update_draft", staff: "any" };
    expect(guardAction(a, "need_staff", ctx())).toEqual({ kind: "run", action: a });
  });

  it("a when-only update is always allowed", () => {
    const a: BotAction = { action: "update_draft", when: { day: "mañana" } };
    expect(guardAction(a, "need_service", ctx({ draft: { serviceId: null, staffChoice: null } }))).toEqual({
      kind: "run",
      action: a,
    });
  });
});

describe("guardAction - passthrough", () => {
  it.each<BotAction>([
    { action: "reply", text: "hola" },
    { action: "my_bookings" },
    { action: "greeting" },
    { action: "handoff", reason: "cliente" },
    { action: "update_lead", name: "Ana" },
    { action: "move_stage", stage: "x" },
  ])("never blocks %j", (a) => {
    expect(guardAction(a, "need_service", ctx())).toEqual({ kind: "run", action: a });
  });
});
