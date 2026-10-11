import { describe, expect, it } from "vitest";
import {
  formatMoneyCents,
  isCurrency,
  parseMoneyToCents,
  sumable,
} from "@/lib/money";

describe("parseMoneyToCents", () => {
  it("acepta lo que la gente teclea de verdad", () => {
    expect(parseMoneyToCents("12500")).toBe(1_250_000);
    expect(parseMoneyToCents("12,500")).toBe(1_250_000);
    expect(parseMoneyToCents("12,500.50")).toBe(1_250_050);
    expect(parseMoneyToCents("$12 500.50")).toBe(1_250_050);
    expect(parseMoneyToCents("  900  ")).toBe(90_000);
  });

  it("un decimal solo no se confunde con millares", () => {
    // "12.5" son doce cincuenta, no doce mil quinientos.
    expect(parseMoneyToCents("12.5")).toBe(1_250);
    expect(parseMoneyToCents("12,5")).toBe(1_250);
  });

  it("trata el punto de millares como millares, no como decimales", () => {
    // "12.500" con tres dígitos detrás es doce mil quinientos.
    expect(parseMoneyToCents("12.500")).toBe(1_250_000);
  });

  it("sin número reconocible devuelve null, no cero", () => {
    // Un 0 se leería como "este trato no vale nada", que es un dato distinto
    // de "nadie capturó el monto".
    expect(parseMoneyToCents("")).toBeNull();
    expect(parseMoneyToCents("   ")).toBeNull();
    expect(parseMoneyToCents("$")).toBeNull();
    expect(parseMoneyToCents("no sé")).toBeNull();
  });

  it("el cero explícito sí es un cero", () => {
    expect(parseMoneyToCents("0")).toBe(0);
  });
});

describe("sumable", () => {
  it("solo suma lo que está en la moneda del negocio", () => {
    expect(sumable({ amountCents: 1000, currency: "MXN" }, "MXN")).toBe(true);
    expect(sumable({ amountCents: 1000, currency: "USD" }, "MXN")).toBe(false);
  });

  it("un monto sin moneda se asume en la del negocio", () => {
    // Es el caso de los leads capturados antes de que existiera la columna.
    expect(sumable({ amountCents: 1000, currency: null }, "MXN")).toBe(true);
  });

  it("sin monto no suma, aunque la moneda coincida", () => {
    expect(sumable({ amountCents: null, currency: "MXN" }, "MXN")).toBe(false);
  });

  it("cambiar la moneda del negocio cambia lo sumable", () => {
    const monto = { amountCents: 1000, currency: "USD" };
    expect(sumable(monto, "MXN")).toBe(false);
    expect(sumable(monto, "USD")).toBe(true);
  });
});

describe("formatMoneyCents", () => {
  it("formatea en la moneda pedida", () => {
    const out = formatMoneyCents(1_250_050, "MXN");
    expect(out).toContain("12,500.50");
  });

  it("null entra, null sale: no inventa un $0.00", () => {
    expect(formatMoneyCents(null, "MXN")).toBeNull();
    expect(formatMoneyCents(undefined, "MXN")).toBeNull();
  });

  it("una moneda que el runtime no conoce degrada sin romper la pantalla", () => {
    const out = formatMoneyCents(1_000, "XXX_INVALIDA");
    expect(out).toBe("10.00 XXX_INVALIDA");
  });
});

describe("catálogo de monedas", () => {
  it("valida entradas basura", () => {
    expect(isCurrency("MXN")).toBe(true);
    expect(isCurrency("mxn")).toBe(false);
    expect(isCurrency("pesos")).toBe(false);
    expect(isCurrency(null)).toBe(false);
  });
});

describe("formatPriceShort (WhatsApp wording)", () => {
  it("groups thousands for the currency's locale and drops zero decimals", async () => {
    const { formatPriceShort } = await import("@/lib/money");
    expect(formatPriceShort(2_500_000, "COP")).toBe("$25.000 COP");
    expect(formatPriceShort(25_000, "MXN")).toBe("$250 MXN");
    expect(formatPriceShort(150_000, "MXN")).toBe("$1,500 MXN");
  });

  it("keeps cents only when the currency has them and the amount needs them", async () => {
    const { formatPriceShort } = await import("@/lib/money");
    expect(formatPriceShort(15_050, "MXN")).toBe("$150.50 MXN");
    // COP has no minor unit: a stray cent never prints decimals.
    expect(formatPriceShort(2_500_050, "COP")).toBe("$25.001 COP");
  });

  it("returns null for a free service", async () => {
    const { formatPriceShort } = await import("@/lib/money");
    expect(formatPriceShort(0, "MXN")).toBeNull();
  });
});
