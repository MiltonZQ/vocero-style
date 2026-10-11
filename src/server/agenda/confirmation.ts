/**
 * 019 — Textos deterministas del bot (WhatsApp, español neutro de México).
 * Los genera el código, no el modelo: la confirmación siempre dice lo mismo.
 */

export type ConfirmationInput = {
  serviceName: string;
  staffName: string | null;
  startUtc: string;
  durationMinutes: number;
  priceCents: number;
  currency: string;
  timezone: string;
  locationAddress: string | null;
  locationMapsUrl: string | null;
  arrivalLeadMinutes: number;
  locale: "es-MX";
};

export type CatalogItem = {
  name: string;
  durationMinutes: number;
  priceCents: number;
  currency: string;
};

/** "$150 MXN" o "$150.50 MXN"; null si el servicio no tiene precio. */
function formatPrice(priceCents: number, currency: string): string | null {
  if (priceCents <= 0) return null;
  const amount = priceCents / 100;
  const text = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return `$${text} ${currency}`;
}

/** "Lunes 12 de octubre, 16:00" en la zona del negocio. */
export function formatWhen(startUtc: string, timezone: string, locale: string): string {
  const parts = new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(startUtc));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday");
  const cap = weekday.charAt(0).toUpperCase() + weekday.slice(1);
  // Algunos motores devuelven "24" a medianoche con hour12:false.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${cap} ${get("day")} de ${get("month")}, ${hour}:${get("minute")}`;
}

export function buildConfirmation(input: ConfirmationInput): string {
  const lines = ["✅ Cita confirmada"];
  lines.push(
    input.staffName
      ? `✂️ ${input.serviceName} · con ${input.staffName}`
      : `✂️ ${input.serviceName}`
  );
  lines.push(
    `📅 ${formatWhen(input.startUtc, input.timezone, input.locale)} (${input.durationMinutes} min)`
  );
  const price = formatPrice(input.priceCents, input.currency);
  if (price) lines.push(`💵 ${price}`);
  const place = [input.locationAddress, input.locationMapsUrl].filter(Boolean).join(" — ");
  if (place) lines.push(`📍 ${place}`);
  if (input.arrivalLeadMinutes > 0) {
    const n = input.arrivalLeadMinutes;
    lines.push("", `Te recomendamos llegar ${n} ${n === 1 ? "minuto" : "minutos"} antes.`);
  }
  return lines.join("\n");
}

/** Paso `need_service`: el catálogo con duración y precio. */
export function buildCatalogMessage(services: readonly CatalogItem[]): string {
  if (services.length === 0) {
    return "Por ahora no tenemos servicios disponibles para agendar. Un asesor te ayudará pronto.";
  }
  const rows = services.map((s) => {
    const price = formatPrice(s.priceCents, s.currency);
    return `• ${s.name} — ${s.durationMinutes} min${price ? ` · ${price}` : ""}`;
  });
  return ["¿Qué servicio te gustaría?", "", ...rows].join("\n");
}

/** Paso `need_staff`: quién lo hace, más la opción de dejarlo a criterio del negocio. */
export function buildStaffChoiceMessage(
  serviceName: string,
  staff: readonly { name: string }[]
): string {
  const rows = [
    ...staff.map((s) => `• ${s.name}`),
    "• Cualquiera (el primero disponible)",
  ];
  return [`Para ${serviceName}, ¿con quién te gustaría agendar?`, "", ...rows].join("\n");
}
