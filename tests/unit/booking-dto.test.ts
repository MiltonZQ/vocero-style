import { describe, expect, it } from "vitest";
import { toBookingDTO } from "../../src/server/agenda/dto";

/**
 * T062 — booking DTO.
 * Contact is only { name, phone }. A shop block has staff null.
 */

describe("toBookingDTO", () => {
  it("strips contact id and conversationId", () => {
    const dto = toBookingDTO({
      id: "bk_1",
      kind: "session",
      status: "confirmed",
      startUtc: new Date("2026-01-05T08:00:00.000Z"),
      endUtc: new Date("2026-01-05T08:45:00.000Z"),
      durationMinutes: 45,
      priceCents: 9900,
      currency: "EUR",
      notes: null,
      contact: {
        id: "ct_1",
        name: "Ana",
        phone: "+34600111222",
        conversationId: "cv_1",
      },
      staff: { id: "st_a", name: "Nuria" },
      service: { id: "sv_1", name: "Tinte" },
    });

    expect(dto).toMatchObject({
      id: "bk_1",
      kind: "session",
      status: "confirmed",
      startUtc: "2026-01-05T08:00:00.000Z",
      endUtc: "2026-01-05T08:45:00.000Z",
      durationMinutes: 45,
      priceCents: 9900,
      currency: "EUR",
      notes: null,
      contact: { name: "Ana", phone: "+34600111222" },
      staff: { id: "st_a", name: "Nuria" },
      service: { id: "sv_1", name: "Tinte" },
    });
    expect(dto.contact).not.toHaveProperty("id");
    expect(dto.contact).not.toHaveProperty("conversationId");
  });

  it("keeps a missing phone as null", () => {
    const dto = toBookingDTO({
      id: "bk_3",
      kind: "session",
      status: "confirmed",
      startUtc: new Date("2026-01-05T08:00:00.000Z"),
      endUtc: new Date("2026-01-05T09:00:00.000Z"),
      durationMinutes: 60,
      priceCents: 1000,
      currency: "EUR",
      notes: null,
      contact: { id: "ct_9", name: "Sin teléfono", phone: null, conversationId: "cv_9" },
      staff: { id: "st_a", name: "Nuria" },
      service: { id: "sv_1", name: "Corte" },
    });
    expect(dto.contact).toEqual({ name: "Sin teléfono", phone: null });
  });

  it("represents a shop block with staff null and notes", () => {
    const dto = toBookingDTO({
      id: "bk_2",
      kind: "block",
      status: "confirmed",
      startUtc: new Date("2026-01-06T09:00:00.000Z"),
      endUtc: new Date("2026-01-06T12:00:00.000Z"),
      durationMinutes: 180,
      priceCents: null,
      currency: null,
      notes: "Cerrado por inventario",
      contact: null,
      staff: null,
      service: null,
    });
    expect(dto).toMatchObject({
      id: "bk_2",
      kind: "block",
      staff: null,
      notes: "Cerrado por inventario",
      contact: null,
      service: null,
    });
  });

  it("keeps the professional on a personal block", () => {
    const dto = toBookingDTO({
      id: "bk_4",
      kind: "block",
      status: "confirmed",
      startUtc: new Date("2026-01-06T09:00:00.000Z"),
      endUtc: new Date("2026-01-06T10:00:00.000Z"),
      durationMinutes: 60,
      priceCents: null,
      currency: null,
      notes: "Comida",
      contact: null,
      staff: { id: "st_a", name: "Nuria" },
      service: null,
    });
    expect(dto.kind).toBe("block");
    expect(dto.staff).toEqual({ id: "st_a", name: "Nuria" });
    expect(dto.notes).toBe("Comida");
  });
});
