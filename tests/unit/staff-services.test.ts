import { describe, expect, it } from "vitest";
import { ForbiddenError } from "@/lib/auth/actor";
import { effectiveDuration } from "@/server/agenda/catalog";
import {
  PutStaffService,
  nextStaffServiceDuration,
  rejectStaffPriceEdit,
} from "@/server/agenda/catalog";

/**
 * 018 US5 — el staff marca servicios y solo puede tocar la duración.
 * Un precio en el cuerpo es 403 (ForbiddenError), no un 422 de Zod.
 */
describe("PutStaffService", () => {
  it("acepta duración, null y el cuerpo vacío", () => {
    expect(PutStaffService.parse({ durationMinutes: 45 })).toEqual({
      durationMinutes: 45,
    });
    expect(PutStaffService.parse({ durationMinutes: null })).toEqual({
      durationMinutes: null,
    });
    expect(PutStaffService.parse({})).toEqual({});
  });

  it("rechaza una duración fuera de 5–600", () => {
    expect(PutStaffService.safeParse({ durationMinutes: 4 }).success).toBe(
      false
    );
    expect(PutStaffService.safeParse({ durationMinutes: 601 }).success).toBe(
      false
    );
  });

  it("el esquema strict no acepta precio ni nombre", () => {
    expect(
      PutStaffService.safeParse({ durationMinutes: 30, priceCents: 1 }).success
    ).toBe(false);
    expect(PutStaffService.safeParse({ name: "Corte" }).success).toBe(false);
    expect(PutStaffService.safeParse({ price: 10 }).success).toBe(false);
  });
});

describe("rejectStaffPriceEdit", () => {
  it("un staff con priceCents, price o name recibe ForbiddenError", () => {
    for (const body of [
      { priceCents: 1 },
      { price: 10 },
      { name: "Corte" },
      { durationMinutes: 45, priceCents: 1 },
    ]) {
      const err = rejectStaffPriceEdit("staff", body);
      expect(err).toBeInstanceOf(ForbiddenError);
      expect(err?.name).toBe("ForbiddenError");
    }
  });

  it("un staff que solo manda durationMinutes no es rechazado aquí", () => {
    expect(rejectStaffPriceEdit("staff", { durationMinutes: 45 })).toBeNull();
    expect(rejectStaffPriceEdit("staff", { durationMinutes: null })).toBeNull();
    expect(rejectStaffPriceEdit("staff", {})).toBeNull();
  });

  it("el dueño no recibe ForbiddenError: el strict de Zod responde 422", () => {
    expect(rejectStaffPriceEdit("owner", { priceCents: 1 })).toBeNull();
    expect(rejectStaffPriceEdit("reception", { name: "Corte" })).toBeNull();
  });
});

describe("nextStaffServiceDuration", () => {
  it("marcar dos veces con la misma duración es idempotente", () => {
    const once = nextStaffServiceDuration(null, { durationMinutes: 45 });
    const twice = nextStaffServiceDuration(once, { durationMinutes: 45 });
    expect(once).toBe(45);
    expect(twice).toBe(45);
  });

  it("omitir durationMinutes conserva la que ya tenía", () => {
    expect(nextStaffServiceDuration(45, {})).toBe(45);
    expect(nextStaffServiceDuration(null, {})).toBeNull();
  });

  it("null limpia el override y la efectiva vuelve a la del catálogo", () => {
    const cleared = nextStaffServiceDuration(45, { durationMinutes: null });
    expect(cleared).toBeNull();
    expect(
      effectiveDuration(
        { durationMinutes: cleared },
        { durationMinutes: 30 }
      )
    ).toBe(30);
  });
});
