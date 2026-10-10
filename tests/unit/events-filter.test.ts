import { describe, expect, it } from "vitest";
import type { Actor } from "@/lib/auth/actor";
import { eventVisibleTo, type SseEvent } from "@/server/events/bus";

const base = { userId: "u_1", organizationId: "org_1", memberId: "mem_1" };
const owner: Actor = { ...base, role: "owner", staffId: null };
const reception: Actor = { ...base, role: "reception", staffId: null };
const staffA: Actor = { ...base, role: "staff", staffId: "st_A" };
const staffNoProfile: Actor = { ...base, role: "staff", staffId: null };

const own: SseEvent = {
  type: "booking.updated",
  data: { bookingId: "bk_1", staffId: "st_A", scope: "staff" },
};
const foreign: SseEvent = {
  type: "booking.updated",
  data: { bookingId: "bk_2", staffId: "st_B", scope: "staff" },
};
const shop: SseEvent = {
  type: "booking.updated",
  data: { bookingId: "bk_3", staffId: null, scope: "shop" },
};
const inbox: SseEvent = {
  type: "message.new",
  data: { conversationId: "cv_1", message: {} },
};
const lab: SseEvent = {
  type: "lab.run",
  data: { runId: "r", status: "running", progress: { done: 0, total: 1 } },
};

describe("eventVisibleTo", () => {
  it("owner y reception reciben todo", () => {
    for (const a of [owner, reception]) {
      for (const e of [own, foreign, shop, inbox, lab]) {
        expect(eventVisibleTo(a, e)).toBe(true);
      }
    }
  });

  it("staff recibe solo booking.updated propio o del local", () => {
    expect(eventVisibleTo(staffA, own)).toBe(true);
    expect(eventVisibleTo(staffA, shop)).toBe(true);
    expect(eventVisibleTo(staffA, foreign)).toBe(false);
  });

  it("staff nunca recibe eventos de bandeja ni del Laboratorio", () => {
    expect(eventVisibleTo(staffA, inbox)).toBe(false);
    expect(eventVisibleTo(staffA, lab)).toBe(false);
    expect(
      eventVisibleTo(staffA, {
        type: "conversation.updated",
        data: { conversation: {} },
      })
    ).toBe(false);
  });

  it("staff sin perfil no recibe nada", () => {
    for (const e of [own, foreign, shop, inbox, lab]) {
      expect(eventVisibleTo(staffNoProfile, e)).toBe(false);
    }
  });

  it("el payload de booking.updated no lleva datos del cliente", () => {
    expect(Object.keys((own as { data: object }).data).sort()).toEqual([
      "bookingId",
      "scope",
      "staffId",
    ]);
  });
});
