import { describe, expect, it } from "vitest";
import {
  buildCatalogMessage,
  buildConfirmation,
  buildStaffChoiceMessage,
} from "@/server/agenda/confirmation";

const base = {
  serviceName: "Corte",
  staffName: "Carlos",
  startUtc: "2026-10-12T22:00:00.000Z", // Mon 16:00 Mexico City
  durationMinutes: 30,
  priceCents: 15000,
  currency: "MXN",
  timezone: "America/Mexico_City",
  locationAddress: "Av. Juárez 123, Centro",
  locationMapsUrl: "https://maps.app.goo.gl/abc",
  arrivalLeadMinutes: 5,
  locale: "es-MX" as const,
};

describe("buildConfirmation", () => {
  it("builds the full message", () => {
    expect(buildConfirmation(base)).toBe(
      [
        "✅ Cita confirmada",
        "✂️ Corte · con Carlos",
        "📅 Lunes 12 de octubre, 16:00 (30 min)",
        "💵 $150 MXN",
        "📍 Av. Juárez 123, Centro — https://maps.app.goo.gl/abc",
        "",
        "Te recomendamos llegar 5 minutos antes.",
      ].join("\n")
    );
  });

  it("omits the staff part, price, location and lead when missing", () => {
    const text = buildConfirmation({
      ...base,
      staffName: null,
      priceCents: 0,
      locationAddress: null,
      locationMapsUrl: null,
      arrivalLeadMinutes: 0,
    });
    expect(text).toBe(
      ["✅ Cita confirmada", "✂️ Corte", "📅 Lunes 12 de octubre, 16:00 (30 min)"].join("\n")
    );
  });

  it("degrades to address-only or link-only", () => {
    expect(buildConfirmation({ ...base, locationMapsUrl: null })).toContain(
      "📍 Av. Juárez 123, Centro\n"
    );
    const linkOnly = buildConfirmation({ ...base, locationAddress: null });
    expect(linkOnly).toContain("📍 https://maps.app.goo.gl/abc");
    expect(linkOnly).not.toContain("—");
  });

  it("formats cents and uses the shop timezone", () => {
    expect(buildConfirmation({ ...base, priceCents: 15050 })).toContain("💵 $150.50 MXN");
    // 2026-10-13T05:30Z is Mon 23:30 in Mexico City, not Tuesday.
    expect(buildConfirmation({ ...base, startUtc: "2026-10-13T05:30:00.000Z" })).toContain(
      "Lunes 12 de octubre, 23:30"
    );
  });

  it("uses singular for 1 minute of lead time", () => {
    expect(buildConfirmation({ ...base, arrivalLeadMinutes: 1 })).toContain(
      "llegar 1 minuto antes."
    );
  });
});

describe("buildCatalogMessage", () => {
  it("lists services with duration and price", () => {
    const text = buildCatalogMessage([
      { name: "Corte", durationMinutes: 30, priceCents: 15000, currency: "MXN" },
      { name: "Barba", durationMinutes: 20, priceCents: 0, currency: "MXN" },
    ]);
    expect(text).toContain("¿Qué servicio te gustaría?");
    expect(text).toContain("• Corte — 30 min · $150 MXN");
    expect(text).toContain("• Barba — 20 min");
    expect(text).not.toContain("$0");
  });

  it("handles an empty catalog", () => {
    expect(buildCatalogMessage([])).toMatch(/por ahora/i);
  });
});

describe("buildStaffChoiceMessage", () => {
  it("lists the barbers and offers 'cualquiera'", () => {
    const text = buildStaffChoiceMessage("Corte", [{ name: "Carlos" }, { name: "Ana" }]);
    expect(text).toContain("Corte");
    expect(text).toContain("• Carlos");
    expect(text).toContain("• Ana");
    expect(text).toContain("• Cualquiera");
  });

  it("with no staff still offers cualquiera", () => {
    expect(buildStaffChoiceMessage("Corte", [])).toContain("Cualquiera");
  });
});
