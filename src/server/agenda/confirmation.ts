import { formatPriceShort } from "@/lib/money";

/**
 * 019 — Textos deterministas del bot (WhatsApp, español neutro, de tú).
 * Los genera el código, no el modelo: lo que el cliente lee de servicios,
 * profesionales, horarios y confirmación siempre suena igual de profesional.
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
  /** null cuando el local tiene pin de ubicación: el enlace sobra. */
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

/** "A", "A y B", "A, B y C" (con `o`: "A o B"). */
export function joinNatural(items: readonly string[], conjunction: "y" | "o" = "y"): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items[items.length - 1]}`;
}

/** "09:00" → "9:00 a. m.", "13:05" → "1:05 p. m.", "00:15" → "12:15 a. m.". */
export function formatClock12(hhmm: string): string {
  const [h, m] = hhmm.split(":");
  const hour24 = Number(h) % 24;
  const suffix = hour24 < 12 ? "a. m." : "p. m.";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${m ?? "00"} ${suffix}`;
}

/** "Lunes 12 de octubre, 4:00 p. m." en la zona del negocio. */
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
  return `${cap} ${get("day")} de ${get("month")}, ${formatClock12(`${hour}:${get("minute")}`)}`;
}

export function buildConfirmation(input: ConfirmationInput): string {
  const lines = ["¡Listo, tu cita quedó agendada!", ""];
  lines.push(
    input.staffName
      ? `✂️ ${input.serviceName} · con ${input.staffName}`
      : `✂️ ${input.serviceName}`
  );
  lines.push(
    `📅 ${formatWhen(input.startUtc, input.timezone, input.locale)} (${input.durationMinutes} min)`
  );
  const price = formatPriceShort(input.priceCents, input.currency);
  if (price) lines.push(`💵 ${price}`);
  const place = [input.locationAddress, input.locationMapsUrl].filter(Boolean).join(" — ");
  if (place) lines.push(`📍 ${place}`);
  lines.push("");
  if (input.arrivalLeadMinutes > 0) {
    const n = input.arrivalLeadMinutes;
    lines.push(
      `Te recomendamos llegar ${n} ${n === 1 ? "minuto" : "minutos"} antes. ¡Te esperamos!`
    );
  } else {
    lines.push("¡Te esperamos!");
  }
  return lines.join("\n");
}

const NO_SERVICES =
  "Por ahora no tenemos servicios disponibles para agendar. Un asesor te ayudará pronto.";

/** Saludo sin intención de reservar: bienvenida y qué servicios hay. */
export function buildGreetingMessage(input: {
  businessName: string | null;
  services: ReadonlyArray<{ name: string }>;
}): string {
  if (input.services.length === 0) return NO_SERVICES;
  const welcome = input.businessName?.trim()
    ? `Te damos la bienvenida a ${input.businessName.trim()}.`
    : "Te damos la bienvenida.";
  return `¡Hola! ¿Cómo estás? ${welcome} ¿En cuál de nuestros servicios estás interesado? Contamos con ${joinNatural(input.services.map((s) => s.name))}.`;
}

/** Paso `need_service`: qué servicios hay (con precio, si lo tienen). */
export function buildCatalogMessage(services: readonly CatalogItem[]): string {
  if (services.length === 0) return NO_SERVICES;
  const names = services.map((s) => {
    const price = formatPriceShort(s.priceCents, s.currency);
    return price ? `${s.name} (${price})` : s.name;
  });
  return `¿En cuál de nuestros servicios estás interesado? Contamos con ${joinNatural(names)}.`;
}

/** Paso `need_staff`: quién lo hace, más la opción de dejarlo a criterio del negocio. */
export function buildStaffChoiceMessage(
  serviceName: string,
  staff: readonly { name: string }[],
  opts: { intro?: boolean } = {}
): string {
  const who =
    staff.length > 0
      ? `Para ${serviceName} contamos con ${joinNatural(staff.map((s) => s.name))}. `
      : `Para ${serviceName} podemos asignarte a alguien del equipo. `;
  const ask =
    "¿Con cuál de nuestros profesionales deseas ser atendido? Si prefieres, también puedo agendarte con el primero disponible.";
  return `${opts.intro === false ? "" : "Perfecto. "}${who}${ask}`;
}
