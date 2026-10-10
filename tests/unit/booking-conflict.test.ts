import { describe, expect, it } from "vitest";
import { BookingError, isSlotConflict } from "@/server/agenda/service";

/**
 * 018 — Un choque de hueco puede venir de dos garantías de la BASE: el índice
 * único de la 015 (`23505`) o el `EXCLUDE` por profesional (`23P01`). Las dos
 * significan lo mismo para el usuario: `slot_taken`.
 */
describe("isSlotConflict", () => {
  it("reconoce unique_violation (23505) y exclusion_violation (23P01)", () => {
    expect(isSlotConflict({ code: "23505" })).toBe(true);
    expect(isSlotConflict({ code: "23P01" })).toBe(true);
  });

  it("también cuando el driver lo envuelve en `cause`", () => {
    expect(isSlotConflict({ cause: { code: "23505" } })).toBe(true);
    expect(isSlotConflict({ cause: { code: "23P01" } })).toBe(true);
  });

  it("es falso para otros códigos y para lo que no es un error", () => {
    expect(isSlotConflict({ code: "23503" })).toBe(false);
    expect(isSlotConflict({ code: "23514" })).toBe(false);
    expect(isSlotConflict({ cause: { code: "40001" } })).toBe(false);
    expect(isSlotConflict(null)).toBe(false);
    expect(isSlotConflict(undefined)).toBe(false);
    expect(isSlotConflict("23P01")).toBe(false);
    expect(isSlotConflict(42)).toBe(false);
  });

  it("lo que se propaga es BookingError('slot_taken')", () => {
    const err = new BookingError("slot_taken", "Ese horario acaba de ocuparse");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("slot_taken");
  });
});
