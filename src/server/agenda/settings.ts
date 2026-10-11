import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import {
  DEFAULT_CONNECTOR,
  isConnectorId,
  type ConnectorId,
} from "@/lib/agenda-connectors";
import {
  isValidInterval,
  isValidTimeZone,
  WEEKDAYS,
  type Interval,
  type WeekdayKey,
} from "@/lib/time/slots";

/**
 * 015 — La configuración de la agenda del negocio (una por organización):
 * lectura con defaults y upsert normalizado.
 */

export type WeeklyHours = Partial<Record<WeekdayKey, Interval[]>>;

export const DEFAULT_TIMEZONE = "America/Mexico_City";

/** L-V 09:00-18:00 — se ajusta en Ajustes → Agenda. */
export const DEFAULT_WEEKLY_HOURS: WeeklyHours = {
  mon: [{ start: "09:00", end: "18:00" }],
  tue: [{ start: "09:00", end: "18:00" }],
  wed: [{ start: "09:00", end: "18:00" }],
  thu: [{ start: "09:00", end: "18:00" }],
  fri: [{ start: "09:00", end: "18:00" }],
};

export type CalendarSettings = {
  weeklyHours: WeeklyHours;
  slotMinutes: number;
  bufferMinutes: number;
  minNoticeHours: number;
  maxDaysAhead: number;
  timezone: string;
  /** Cómo se entrega la reunión. */
  connector: ConnectorId;
  /** Sala fija del conector `enlace-fijo`; null ⇒ citas sin link. */
  meetingLink: string | null;
  /** 019 — dónde queda el local (cita presencial). */
  locationAddress: string | null;
  locationMapsUrl: string | null;
  /** 019 — minutos de anticipación que se le recomiendan al cliente. */
  arrivalLeadMinutes: number;
  /** 019 — coordenadas del local (pin de WhatsApp); ambas o ninguna. */
  latitude: number | null;
  longitude: number | null;
};

/** Lo que ve una instancia recién encendida: útil sin configurar nada. */
export const DEFAULT_CALENDAR_SETTINGS: CalendarSettings = {
  weeklyHours: DEFAULT_WEEKLY_HOURS,
  slotMinutes: 30,
  bufferMinutes: 0,
  minNoticeHours: 2,
  maxDaysAhead: 7,
  timezone: DEFAULT_TIMEZONE,
  connector: DEFAULT_CONNECTOR,
  meetingLink: null,
  locationAddress: null,
  locationMapsUrl: null,
  arrivalLeadMinutes: 5,
  latitude: null,
  longitude: null,
};

export const ADDRESS_MAX_LENGTH = 300;

export const LIMITS = {
  slotMinutes: { min: 10, max: 240 },
  bufferMinutes: { min: 0, max: 120 },
  minNoticeHours: { min: 0, max: 72 },
  maxDaysAhead: { min: 1, max: 60 },
  arrivalLeadMinutes: { min: 0, max: 120 },
} as const;

export async function getSettings(
  organizationId: string
): Promise<CalendarSettings> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.calendarSettings)
    .where(scoped(schema.calendarSettings.organizationId, organizationId))
    .limit(1);

  const row = rows[0];
  // Sin fila: la instancia recién encendida ya es usable.
  if (!row) return DEFAULT_CALENDAR_SETTINGS;

  return {
    weeklyHours: normalizeWeeklyHours(row.weeklyHours as WeeklyHours),
    slotMinutes: row.slotMinutes,
    bufferMinutes: row.bufferMinutes,
    minNoticeHours: row.minNoticeHours,
    maxDaysAhead: row.maxDaysAhead,
    timezone: row.timezone,
    // Un conector que ya no existe en el código (p. ej. venías de un fork) no
    // puede dejar la agenda inservible: se degrada al soberano.
    connector: isConnectorId(row.connector) ? row.connector : DEFAULT_CONNECTOR,
    meetingLink: row.meetingLink,
    locationAddress: row.locationAddress,
    locationMapsUrl: row.locationMapsUrl,
    arrivalLeadMinutes: row.arrivalLeadMinutes,
    latitude: row.latitude,
    longitude: row.longitude,
  };
}

export class CalendarSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarSettingsError";
  }
}

/**
 * Lo que llega de fuera, antes de normalizar: el horario y el conector vienen
 * sueltos porque su validación vive AQUÍ. Si el tipo estricto se exigiera en la
 * ruta, cada llamador tendría que hacer un cast — y un cast es justamente la
 * comprobación que no ocurre.
 */
export type CalendarSettingsInput = Partial<
  Omit<CalendarSettings, "weeklyHours" | "connector">
> & {
  weeklyHours?: unknown;
  connector?: string;
};

export async function upsertSettings(
  organizationId: string,
  input: CalendarSettingsInput
): Promise<CalendarSettings> {
  const current = await getSettings(organizationId);

  const timezone = input.timezone ?? current.timezone;
  // Una zona desconocida rompería el motor entero: se rechaza al guardar.
  if (!isValidTimeZone(timezone)) {
    throw new CalendarSettingsError(`Zona horaria desconocida: ${timezone}`);
  }

  const connector = input.connector ?? current.connector;
  if (!isConnectorId(connector)) {
    throw new CalendarSettingsError(`Conector desconocido: ${connector}`);
  }

  const coordinates = normalizeCoordinates(
    input.latitude !== undefined ? input.latitude : current.latitude,
    input.longitude !== undefined ? input.longitude : current.longitude
  );

  const next: CalendarSettings = {
    weeklyHours: normalizeWeeklyHours(
      input.weeklyHours !== undefined ? input.weeklyHours : current.weeklyHours
    ),
    slotMinutes: clampInt(
      input.slotMinutes ?? current.slotMinutes,
      LIMITS.slotMinutes.min,
      LIMITS.slotMinutes.max
    ),
    bufferMinutes: clampInt(
      input.bufferMinutes ?? current.bufferMinutes,
      LIMITS.bufferMinutes.min,
      LIMITS.bufferMinutes.max
    ),
    minNoticeHours: clampInt(
      input.minNoticeHours ?? current.minNoticeHours,
      LIMITS.minNoticeHours.min,
      LIMITS.minNoticeHours.max
    ),
    maxDaysAhead: clampInt(
      input.maxDaysAhead ?? current.maxDaysAhead,
      LIMITS.maxDaysAhead.min,
      LIMITS.maxDaysAhead.max
    ),
    timezone,
    connector,
    meetingLink: normalizeLink(
      input.meetingLink !== undefined ? input.meetingLink : current.meetingLink
    ),
    locationAddress: normalizeAddress(
      input.locationAddress !== undefined ? input.locationAddress : current.locationAddress
    ),
    locationMapsUrl: normalizeMapsUrl(
      input.locationMapsUrl !== undefined ? input.locationMapsUrl : current.locationMapsUrl
    ),
    arrivalLeadMinutes: clampInt(
      input.arrivalLeadMinutes ?? current.arrivalLeadMinutes,
      LIMITS.arrivalLeadMinutes.min,
      LIMITS.arrivalLeadMinutes.max
    ),
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
  };

  const db = getDb();
  const values = {
    weeklyHours: next.weeklyHours,
    slotMinutes: next.slotMinutes,
    bufferMinutes: next.bufferMinutes,
    minNoticeHours: next.minNoticeHours,
    maxDaysAhead: next.maxDaysAhead,
    timezone: next.timezone,
    connector: next.connector,
    meetingLink: next.meetingLink,
    locationAddress: next.locationAddress,
    locationMapsUrl: next.locationMapsUrl,
    arrivalLeadMinutes: next.arrivalLeadMinutes,
    latitude: next.latitude,
    longitude: next.longitude,
  };
  await db
    .insert(schema.calendarSettings)
    .values({
      id: newId("calendarSettings"),
      organizationId,
      ...values,
    })
    .onConflictDoUpdate({
      target: schema.calendarSettings.organizationId,
      set: { ...values, updatedAt: new Date() },
    });

  return next;
}

/**
 * Descarta intervalos inválidos y días vacíos (día cerrado) y ordena por hora
 * de inicio. Se prefiere limpiar a rechazar: un día mal escrito no debe tumbar
 * el guardado completo del horario.
 */
export function normalizeWeeklyHours(input: unknown): WeeklyHours {
  const out: WeeklyHours = {};
  if (typeof input !== "object" || input === null) return out;
  const source = input as Record<string, unknown>;
  for (const day of WEEKDAYS) {
    const intervals = source[day];
    if (!Array.isArray(intervals)) continue;
    const valid = intervals
      .filter(isValidInterval)
      .sort((a, b) => a.start.localeCompare(b.start));
    if (valid.length > 0) out[day] = valid;
  }
  return out;
}

/** Cadena vacía o espacios ⇒ null (el campo es opcional de verdad). */
function normalizeLink(link: string | null | undefined): string | null {
  const trimmed = (link ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 019 — Vacío ⇒ null. Más de 300 caracteres se rechaza: no se corta una dirección. */
export function normalizeAddress(address: string | null | undefined): string | null {
  const trimmed = (address ?? "").trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > ADDRESS_MAX_LENGTH) {
    throw new CalendarSettingsError(
      `La dirección no puede pasar de ${ADDRESS_MAX_LENGTH} caracteres`
    );
  }
  return trimmed;
}

/** 019 — Vacío ⇒ null. Solo https: es un enlace que el cliente va a abrir. */
export function normalizeMapsUrl(url: string | null | undefined): string | null {
  const trimmed = (url ?? "").trim();
  if (trimmed.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new CalendarSettingsError("El enlace de Google Maps no es una URL válida");
  }
  if (parsed.protocol !== "https:") {
    throw new CalendarSettingsError("El enlace de Google Maps debe empezar con https://");
  }
  return trimmed;
}

/**
 * 019 — Latitud y longitud van juntas o no van: un pin con una sola mitad
 * caería en el mar. Fuera de rango se rechaza (no se recorta): el cliente
 * recibiría un pin en otro lugar.
 */
export function normalizeCoordinates(
  latitude: number | null | undefined,
  longitude: number | null | undefined
): { latitude: number | null; longitude: number | null } {
  const lat = latitude ?? null;
  const lng = longitude ?? null;
  if (lat === null && lng === null) return { latitude: null, longitude: null };
  if (lat === null || lng === null) {
    throw new CalendarSettingsError("Latitud y longitud van juntas: llena las dos o deja las dos vacías");
  }
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) {
    throw new CalendarSettingsError("La latitud debe estar entre -90 y 90");
  }
  if (!Number.isFinite(lng) || Math.abs(lng) > 180) {
    throw new CalendarSettingsError("La longitud debe estar entre -180 y 180");
  }
  return { latitude: lat, longitude: lng };
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}
