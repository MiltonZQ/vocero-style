import { describe, expect, it } from "vitest";
import {
  effectiveDuration,
  parseServiceInput,
  serviceInputSchema,
} from "@/server/agenda/catalog";

/**
 * 018 US1 — duración efectiva y el contrato Zod del catálogo.
 * El precio es único y vive en el servicio; un campo desconocido no se
 * descarta en silencio: el cuerpo es `.strict()` y sale como `invalid_body`.
 */
describe("effectiveDuration", () => {
  it("usa la duración propia del profesional cuando existe", () => {
    expect(
      effectiveDuration(
        { durationMinutes: 45 },
        { durationMinutes: 30 }
      )
    ).toBe(45);
  });

  it("cae a la duración del catálogo cuando la propia es null", () => {
    expect(
      effectiveDuration(
        { durationMinutes: null },
        { durationMinutes: 30 }
      )
    ).toBe(30);
  });
});

describe("serviceInputSchema", () => {
  it("acepta el mínimo y rellena la moneda MXN", () => {
    const parsed = serviceInputSchema.parse({
      name: "Corte",
      durationMinutes: 30,
      priceCents: 0,
    });
    expect(parsed).toMatchObject({
      name: "Corte",
      durationMinutes: 30,
      priceCents: 0,
      currency: "MXN",
    });
  });

  it("normaliza el oficio a minúsculas y la moneda a mayúsculas", () => {
    const parsed = serviceInputSchema.parse({
      name: "  Tinte  ",
      durationMinutes: 90,
      priceCents: 15000,
      currency: "mxn",
      jobTitle: "Colorista",
    });
    expect(parsed.name).toBe("Tinte");
    expect(parsed.jobTitle).toBe("colorista");
    expect(parsed.currency).toBe("MXN");
  });

  it("acepta los bordes de duración 5 y 600 y un precio de 0", () => {
    expect(
      serviceInputSchema.parse({
        name: "Rapido",
        durationMinutes: 5,
        priceCents: 0,
      }).durationMinutes
    ).toBe(5);
    expect(
      serviceInputSchema.parse({
        name: "Largo",
        durationMinutes: 600,
        priceCents: 1,
      }).durationMinutes
    ).toBe(600);
  });

  it("rechaza duración fuera de 5–600 y precio negativo", () => {
    expect(
      serviceInputSchema.safeParse({
        name: "Corte",
        durationMinutes: 4,
        priceCents: 0,
      }).success
    ).toBe(false);
    expect(
      serviceInputSchema.safeParse({
        name: "Corte",
        durationMinutes: 601,
        priceCents: 0,
      }).success
    ).toBe(false);
    expect(
      serviceInputSchema.safeParse({
        name: "Corte",
        durationMinutes: 30,
        priceCents: -1,
      }).success
    ).toBe(false);
  });

  it("un campo desconocido es invalid_body (strict), no se ignora", () => {
    const parsed = parseServiceInput({
      name: "Corte",
      durationMinutes: 30,
      priceCents: 100,
      price: 1,
    });
    expect(parsed).toEqual({ ok: false, code: "invalid_body" });
  });
});
