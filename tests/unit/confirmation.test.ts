import { describe, expect, it } from "vitest";
import {
  buildCatalogMessage,
  buildConfirmation,
  buildGreetingMessage,
  buildStaffChoiceMessage,
  formatClock12,
  formatWhen,
  joinNatural,
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

describe("joinNatural", () => {
  it("renders A, A y B, A, B y C", () => {
    expect(joinNatural([])).toBe("");
    expect(joinNatural(["Corte"])).toBe("Corte");
    expect(joinNatural(["Corte", "Corte y barba"])).toBe("Corte y Corte y barba");
    expect(joinNatural(["A", "B", "C"])).toBe("A, B y C");
    expect(joinNatural(["A", "B"], "o")).toBe("A o B");
  });
});

describe("formatClock12", () => {
  it("writes the 12-hour clock the way a receptionist would", () => {
    expect(formatClock12("09:00")).toBe("9:00 a. m.");
    expect(formatClock12("12:00")).toBe("12:00 p. m.");
    expect(formatClock12("12:30")).toBe("12:30 p. m.");
    expect(formatClock12("13:05")).toBe("1:05 p. m.");
    expect(formatClock12("00:15")).toBe("12:15 a. m.");
    expect(formatClock12("23:30")).toBe("11:30 p. m.");
  });
});

describe("buildConfirmation", () => {
  it("builds the full, warm message", () => {
    expect(buildConfirmation(base)).toBe(
      [
        "¡Listo, tu cita quedó agendada!",
        "",
        "✂️ Corte · con Carlos",
        "📅 Lunes 12 de octubre, 4:00 p. m. (30 min)",
        "💵 $150 MXN",
        "📍 Av. Juárez 123, Centro — https://maps.app.goo.gl/abc",
        "",
        "Te recomendamos llegar 5 minutos antes. ¡Te esperamos!",
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
      [
        "¡Listo, tu cita quedó agendada!",
        "",
        "✂️ Corte",
        "📅 Lunes 12 de octubre, 4:00 p. m. (30 min)",
        "",
        "¡Te esperamos!",
      ].join("\n")
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

  it("formats money for the currency and uses the shop timezone", () => {
    expect(buildConfirmation({ ...base, priceCents: 15050 })).toContain("💵 $150.50 MXN");
    expect(buildConfirmation({ ...base, priceCents: 2_500_000, currency: "COP" })).toContain(
      "💵 $25.000 COP"
    );
    // 2026-10-13T05:30Z is Mon 23:30 in Mexico City, not Tuesday.
    expect(buildConfirmation({ ...base, startUtc: "2026-10-13T05:30:00.000Z" })).toContain(
      "Lunes 12 de octubre, 11:30 p. m."
    );
  });

  it("uses singular for 1 minute of lead time", () => {
    expect(buildConfirmation({ ...base, arrivalLeadMinutes: 1 })).toContain(
      "llegar 1 minuto antes."
    );
  });
});

describe("formatWhen", () => {
  it("capitalizes the weekday and writes 12-hour time", () => {
    expect(formatWhen("2026-10-12T15:00:00.000Z", "America/Mexico_City", "es-MX")).toBe(
      "Lunes 12 de octubre, 9:00 a. m."
    );
  });
});

describe("buildGreetingMessage", () => {
  it("welcomes by business name and lists the services naturally", () => {
    expect(
      buildGreetingMessage({
        businessName: "Style",
        services: [{ name: "Corte" }, { name: "Corte y barba" }],
      })
    ).toBe(
      "¡Hola! ¿Cómo estás? Te damos la bienvenida a Style. ¿En cuál de nuestros servicios estás interesado? Contamos con Corte y Corte y barba."
    );
  });

  it("joins three or more with commas and survives a missing business name", () => {
    const text = buildGreetingMessage({
      businessName: null,
      services: [{ name: "Corte" }, { name: "Barba" }, { name: "Cejas" }],
    });
    expect(text).toContain("Te damos la bienvenida.");
    expect(text).toContain("Contamos con Corte, Barba y Cejas.");
  });

  it("with an empty catalog does not promise services", () => {
    expect(buildGreetingMessage({ businessName: "Style", services: [] })).toMatch(/por ahora/i);
  });
});

describe("buildCatalogMessage", () => {
  it("lists services with their price in a sentence", () => {
    const text = buildCatalogMessage([
      { name: "Corte", durationMinutes: 30, priceCents: 15000, currency: "MXN" },
      { name: "Barba", durationMinutes: 20, priceCents: 0, currency: "MXN" },
    ]);
    expect(text).toBe(
      "¿En cuál de nuestros servicios estás interesado? Contamos con Corte ($150 MXN) y Barba."
    );
    expect(text).not.toContain("$0");
  });

  it("handles an empty catalog", () => {
    expect(buildCatalogMessage([])).toMatch(/por ahora/i);
  });
});

describe("buildStaffChoiceMessage", () => {
  it("names the professionals and offers the first available", () => {
    expect(buildStaffChoiceMessage("Corte", [{ name: "Style" }, { name: "Luis Angel" }])).toBe(
      "Perfecto. Para Corte contamos con Style y Luis Angel. ¿Con cuál de nuestros profesionales deseas ser atendido? Si prefieres, también puedo agendarte con el primero disponible."
    );
  });

  it("can drop the opening when it follows another sentence", () => {
    const text = buildStaffChoiceMessage("Corte", [{ name: "Ana" }, { name: "Luis" }], {
      intro: false,
    });
    expect(text.startsWith("Para Corte contamos con Ana y Luis.")).toBe(true);
  });

  it("with no staff still offers the first available", () => {
    expect(buildStaffChoiceMessage("Corte", [])).toContain("primero disponible");
  });
});
