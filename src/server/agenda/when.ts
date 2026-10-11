import {
  addDaysISO,
  todayInTz,
  weekdayKeyOf,
  zonedWallClockToUtc,
  type WeekdayKey,
} from "@/lib/time/slots";
import { normalizeText } from "./match";

/**
 * 019 — Resuelve la preferencia de horario del cliente a una ventana UTC.
 *
 * El modelo NUNCA calcula fechas: emite un `day` relativo ("mañana", "lunes")
 * y este módulo lo convierte usando la zona del negocio. Puro: sin BD.
 */

export type WhenInput = { day?: string; from?: string; to?: string };

export type WhenSettings = {
  timezone: string;
  minNoticeHours: number;
  maxDaysAhead: number;
};

export type WhenResult =
  | { ok: true; startUtc: string; endUtc: string; label: string }
  | { ok: false; reason: "past" | "too_far" | "invalid" };

const WEEKDAY_BY_NAME: Record<string, WeekdayKey> = {
  lunes: "mon",
  martes: "tue",
  miercoles: "wed",
  jueves: "thu",
  viernes: "fri",
  sabado: "sat",
  domingo: "sun",
};

const WEEKDAY_ES: Record<WeekdayKey, string> = {
  mon: "lunes",
  tue: "martes",
  wed: "miércoles",
  thu: "jueves",
  fri: "viernes",
  sat: "sábado",
  sun: "domingo",
};

const MONTHS_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const INVALID = { ok: false, reason: "invalid" } as const;

function isRealIsoDay(iso: string): boolean {
  if (!ISO_DAY.test(iso)) return false;
  const ts = Date.parse(`${iso}T00:00:00Z`);
  // Round-trip rejects overflow such as 2026-02-30 or month 13.
  return !Number.isNaN(ts) && new Date(ts).toISOString().slice(0, 10) === iso;
}

/** Inicio del día local (o del siguiente) como instante UTC. */
function startOfDay(iso: string, tz: string): Date {
  // 00:00 siempre existe en HHMM; la conversión solo falla con ISO inválido.
  return zonedWallClockToUtc(iso, "00:00", tz) ?? new Date(Number.NaN);
}

type DayPick =
  | { kind: "none" }
  | { kind: "day"; iso: string; spoken?: "hoy" | "mañana" | "pasado mañana" | "weekday" }
  | { kind: "invalid" };

function pickDay(
  raw: string,
  today: string,
  tz: string,
): DayPick {
  const text = normalizeText(raw);
  if (!text) return { kind: "none" };
  if (text === "hoy") return { kind: "day", iso: today, spoken: "hoy" };
  if (text === "manana") return { kind: "day", iso: addDaysISO(today, 1), spoken: "mañana" };
  if (text === "pasado manana") {
    return { kind: "day", iso: addDaysISO(today, 2), spoken: "pasado mañana" };
  }
  const weekday = WEEKDAY_BY_NAME[text];
  if (weekday) {
    // Primera ocurrencia desde hoy: el día de hoy SIEMPRE es hoy, nunca la
    // semana próxima. Si hoy ya no tiene lugar, el fallback ofrece lo más cercano.
    for (let offset = 0; offset < 8; offset++) {
      const iso = addDaysISO(today, offset);
      if (weekdayKeyOf(iso, tz) !== weekday) continue;
      return { kind: "day", iso, spoken: "weekday" };
    }
    return { kind: "invalid" };
  }
  const explicit = raw.trim();
  if (isRealIsoDay(explicit)) return { kind: "day", iso: explicit };
  return { kind: "invalid" };
}

function dayLabel(pick: Extract<DayPick, { kind: "day" }>, tz: string): string {
  if (pick.spoken === "hoy" || pick.spoken === "mañana" || pick.spoken === "pasado mañana") {
    return pick.spoken;
  }
  const weekday = weekdayKeyOf(pick.iso, tz);
  const [, month, day] = pick.iso.split("-").map(Number) as [number, number, number];
  const name = weekday ? `${WEEKDAY_ES[weekday]} ` : "";
  return `el ${name}${day} de ${MONTHS_ES[month - 1]}`;
}

function timeLabel(from?: string, to?: string): string {
  if (from && to) return ` de ${from} a ${to}`;
  if (from) return ` después de las ${from}`;
  if (to) return ` antes de las ${to}`;
  return "";
}

export function resolveWhen(input: WhenInput, now: Date, settings: WhenSettings): WhenResult {
  const { timezone: tz, minNoticeHours, maxDaysAhead } = settings;
  const from = input.from?.trim() || undefined;
  const to = input.to?.trim() || undefined;
  if ((from && !HHMM.test(from)) || (to && !HHMM.test(to))) return INVALID;
  if (from && to && to <= from) return INVALID;

  const today = todayInTz(now, tz);
  const earliest = new Date(now.getTime() + minNoticeHours * 3_600_000);
  const lastDay = addDaysISO(today, maxDaysAhead);
  const horizonEnd = startOfDay(addDaysISO(lastDay, 1), tz);

  // Ventana de un día: [from ?? 00:00, to ?? 24:00).
  const windowOf = (iso: string) => ({
    start: zonedWallClockToUtc(iso, from ?? "00:00", tz) ?? new Date(Number.NaN),
    end: to
      ? (zonedWallClockToUtc(iso, to, tz) ?? new Date(Number.NaN))
      : startOfDay(addDaysISO(iso, 1), tz),
  });

  const pick = pickDay(input.day ?? "", today, tz);
  if (pick.kind === "invalid") return INVALID;

  if (pick.kind === "none") {
    // Sin día no hay una ventana horaria coherente: se ignora from/to.
    if (earliest >= horizonEnd) return { ok: false, reason: "past" };
    return {
      ok: true,
      startUtc: earliest.toISOString(),
      endUtc: horizonEnd.toISOString(),
      label: "los próximos días",
    };
  }

  if (pick.iso < today) return { ok: false, reason: "past" };
  if (pick.iso > lastDay) return { ok: false, reason: "too_far" };

  const win = windowOf(pick.iso);
  const start = win.start > earliest ? win.start : earliest;
  if (start >= win.end) return { ok: false, reason: "past" };
  return {
    ok: true,
    startUtc: start.toISOString(),
    endUtc: win.end.toISOString(),
    label: `${dayLabel(pick, tz)}${timeLabel(from, to)}`,
  };
}
