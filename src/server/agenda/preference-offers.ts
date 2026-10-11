import { computeAvailability, type AvailableSlot } from "@/server/agenda/availability";
import { AgendaHttpError } from "@/server/agenda/http";
import type { DraftWhen } from "@/server/agenda/draft";
import { replaceOffers } from "@/server/agenda/offers";
import { getSettings } from "@/server/agenda/settings";
import { spreadByDay, type SpreadSlot } from "@/server/agenda/spread";
import { resolveWhen, type WhenSettings } from "@/server/agenda/when";
import { timeInTz } from "@/lib/time/slots";

/**
 * 019 — Offers by preferred day and hours.
 *
 * The engine (`computeAvailability`) is not forked: it returns every free slot
 * of the horizon for the chosen staff (or "any") and this module only FILTERS
 * that output by the client's window. `selectPreferenceSlots` and
 * `buildOffersMessage` are pure; `offerByPreference` is the IO shell.
 *
 * Window semantics (a slot is inside when its START is inside):
 * - `day` given   → that local day, `from`/`to` bound it (`to` exclusive).
 * - no `day`      → `from`/`to` are a DAILY filter across the whole horizon.
 * - nothing given → nearest slots.
 */

/** How many slots are shown / stored (the catalog is wider than the menu). */
export const SHOWN_OPTIONS = 3;
const STORED_OPTIONS = 12;

export type FallbackReason = "empty" | "past" | "too_far" | "invalid";

export type PreferencePlan = {
  /**
   * match: the preference was honoured (or none was given);
   * fallback_nearest: nothing in the window, nearest slots outside it;
   * fallback_other_staff: the chosen staff has nothing at all, others do;
   * none: nothing anywhere.
   */
  kind: "match" | "fallback_nearest" | "fallback_other_staff" | "none";
  slots: SpreadSlot[];
  /** Human description of the requested window; null without a preference. */
  windowLabel: string | null;
  fallback?: { reason: FallbackReason; label: string | null };
  /** fallback_nearest only: other staff who ARE free inside the window. */
  alternativeStaffNames?: string[];
};

export type PreferenceInput = {
  when: DraftWhen | null;
  now: Date;
  settings: WhenSettings;
  /** Free slots for the chosen staff (or "any"), chronological. */
  slots: AvailableSlot[];
  /** Specific staff only: free slots of the OTHER staff who do the service. */
  otherStaffSlots?: AvailableSlot[];
};

function describeHours(from?: string, to?: string): string {
  if (from && to) return `de ${from} a ${to}`;
  if (from) return `después de las ${from}`;
  if (to) return `antes de las ${to}`;
  return "";
}

function spread(slots: AvailableSlot[], input: PreferenceInput): SpreadSlot[] {
  return spreadByDay(slots, {
    timezone: input.settings.timezone,
    limit: STORED_OPTIONS,
    perDay: SHOWN_OPTIONS,
    now: input.now,
  });
}

function byStart(a: AvailableSlot, b: AvailableSlot): number {
  return Date.parse(a.startUtc) - Date.parse(b.startUtc);
}

/** One slot per instant: `getOffers` orders by start, so ties would shuffle options. */
function dedupeByStart(slots: AvailableSlot[]): AvailableSlot[] {
  const seen = new Set<string>();
  return [...slots].sort(byStart).filter((s) => {
    if (seen.has(s.startUtc)) return false;
    seen.add(s.startUtc);
    return true;
  });
}

type Matcher = { label: string | null; fallbackReason?: FallbackReason; test: (s: AvailableSlot) => boolean };

function buildMatcher(input: PreferenceInput): Matcher {
  const all: Matcher = { label: null, test: () => true };
  const when = input.when;
  const day = when?.day?.trim() || undefined;
  const from = when?.from?.trim() || undefined;
  const to = when?.to?.trim() || undefined;
  if (!day && !from && !to) return all;

  const resolved = resolveWhen({ day, from, to }, input.now, input.settings);
  if (!resolved.ok) {
    return { label: null, fallbackReason: resolved.reason, test: () => true };
  }
  if (day) {
    const start = Date.parse(resolved.startUtc);
    const end = Date.parse(resolved.endUtc);
    return {
      label: resolved.label,
      test: (s) => {
        const t = Date.parse(s.startUtc);
        return t >= start && t < end;
      },
    };
  }
  const tz = input.settings.timezone;
  return {
    label: `los próximos días ${describeHours(from, to)}`.trim(),
    test: (s) => {
      const hhmm = timeInTz(s.startUtc, tz);
      return (!from || hhmm >= from) && (!to || hhmm < to);
    },
  };
}

export function selectPreferenceSlots(input: PreferenceInput): PreferencePlan {
  const matcher = buildMatcher(input);

  if (matcher.fallbackReason) {
    const nearest = spread(input.slots, input);
    return {
      kind: nearest.length > 0 ? "fallback_nearest" : "none",
      slots: nearest,
      windowLabel: null,
      fallback: { reason: matcher.fallbackReason, label: null },
    };
  }

  const inside = input.slots.filter(matcher.test);
  if (inside.length > 0 || matcher.label === null) {
    const slots = spread(inside, input);
    return {
      kind: slots.length > 0 ? "match" : "none",
      slots,
      windowLabel: matcher.label,
    };
  }

  // Empty window. (1) nearest outside it, same staff choice.
  const fallback = { reason: "empty" as const, label: matcher.label };
  const otherInWindow = dedupeByStart((input.otherStaffSlots ?? []).filter(matcher.test));
  const nearest = spread(input.slots, input);
  if (nearest.length > 0) {
    const names = [...new Set(otherInWindow.map((s) => s.staffName).filter(Boolean))] as string[];
    return {
      kind: "fallback_nearest",
      slots: nearest,
      windowLabel: matcher.label,
      fallback,
      ...(names.length > 0 ? { alternativeStaffNames: names } : {}),
    };
  }
  // (2) The chosen staff has nothing at all: other staff inside the window.
  const others = spread(otherInWindow, input);
  if (others.length > 0) {
    return { kind: "fallback_other_staff", slots: others, windowLabel: matcher.label, fallback };
  }
  return { kind: "none", slots: [], windowLabel: matcher.label, fallback };
}

export type OffersMessageOptions = WhenSettings & {
  /** Chosen staff's name; null for "any". */
  staffName: string | null;
  /** Existing-booking notice, placed first. */
  notice?: string | null;
};

function header(plan: PreferencePlan, opts: OffersMessageOptions): string {
  const label = plan.fallback?.label ?? plan.windowLabel;
  const nothing = opts.staffName
    ? `Con ${opts.staffName} no tengo horarios ${label}.`
    : `No tengo horarios ${label}.`;
  switch (plan.kind) {
    case "match":
      return label ? `Para ${label} tengo:` : "Estos son los horarios más cercanos:";
    case "fallback_other_staff":
      return `${nothing} Estos barberos sí tienen:`;
    case "fallback_nearest":
      switch (plan.fallback?.reason) {
        case "past":
          return opts.minNoticeHours > 0
            ? `Ese día u hora ya no es posible: necesitamos al menos ${opts.minNoticeHours} h de anticipación. Lo más cercano disponible es:`
            : "Ese día u hora ya pasó. Lo más cercano disponible es:";
        case "too_far":
          return `Solo agendamos con hasta ${opts.maxDaysAhead} días de anticipación. Lo más cercano disponible es:`;
        case "invalid":
          return "No logré entender ese día u hora. Estos son los horarios más cercanos:";
        default:
          return `${nothing} Lo más cercano disponible es:`;
      }
    case "none":
      return "Por ahora no me quedan horarios libres. Déjame confirmarlo con el equipo y te aviso.";
  }
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}`;
}

/** The text of the offer. Options are numbered: the client picks by number. */
export function buildOffersMessage(plan: PreferencePlan, opts: OffersMessageOptions): string {
  if (plan.kind === "none") return header(plan, opts);
  const showNames = plan.kind === "fallback_other_staff";
  const lines = plan.slots.slice(0, SHOWN_OPTIONS).map((slot, i) => {
    const who = showNames && slot.staffName ? ` con ${slot.staffName}` : "";
    return `${i + 1}) ${slot.dayLabel} a las ${slot.time}${who}`;
  });
  const parts = [header(plan, opts), ...lines];
  if (plan.alternativeStaffNames?.length) {
    parts.push(
      "",
      `Con ${joinNames(plan.alternativeStaffNames)} sí hay horarios ${plan.fallback?.label ?? ""}; dime si prefieres a alguien más.`
    );
  }
  parts.push("", "Responde con el número de la opción que prefieras, o dime otro día u hora.");
  const body = parts.join("\n");
  return opts.notice ? `${opts.notice}\n\n${body}` : body;
}

export type PreferenceService = {
  id: string;
  name: string;
  staff: Array<{ id: string; displayName: string }>;
};

export type PreferenceTurn = {
  text: string;
  /** false ⇒ nothing could be offered (and no offer was stored). */
  ok: boolean;
  /** How many options were stored as bookable. */
  offered: number;
};

async function freeSlots(
  organizationId: string,
  staffId: string,
  serviceId: string,
  settings: Awaited<ReturnType<typeof getSettings>>,
  now: Date
): Promise<AvailableSlot[]> {
  try {
    return await computeAvailability(organizationId, { settings, now, staffId, serviceId });
  } catch (err) {
    if (err instanceof AgendaHttpError) return [];
    throw err;
  }
}

/**
 * Offers the client's preferred window (or the nearest slots) and stores the
 * result as the conversation's `offered_slot` rows. The model never writes
 * the times: this text is the only thing the client sees.
 */
export async function offerByPreference(input: {
  organizationId: string;
  conversationId: string;
  service: PreferenceService;
  /** A staff id or the literal `any`. */
  staffChoice: string;
  when: DraftWhen | null;
  notice?: string | null;
  now?: Date;
}): Promise<PreferenceTurn> {
  const now = input.now ?? new Date();
  const settings = await getSettings(input.organizationId);
  const any = input.staffChoice === "any";
  const chosen = any ? null : input.service.staff.find((s) => s.id === input.staffChoice);
  if (!any && !chosen) return { ok: false, offered: 0, text: "Ese profesional no ofrece este servicio." };

  const slots = await freeSlots(
    input.organizationId,
    any ? "any" : input.staffChoice,
    input.service.id,
    settings,
    now
  );
  const base = { when: input.when, now, settings, slots };
  let plan = selectPreferenceSlots(base);

  // Only a specific staff with an empty window needs the others' calendars.
  if (chosen && plan.fallback?.reason === "empty") {
    const others = input.service.staff.filter((s) => s.id !== chosen.id);
    const otherStaffSlots = (
      await Promise.all(
        others.map((s) => freeSlots(input.organizationId, s.id, input.service.id, settings, now))
      )
    ).flat();
    plan = selectPreferenceSlots({ ...base, otherStaffSlots });
  }

  const text = buildOffersMessage(plan, {
    timezone: settings.timezone,
    minNoticeHours: settings.minNoticeHours,
    maxDaysAhead: settings.maxDaysAhead,
    staffName: chosen?.displayName ?? null,
    notice: input.notice,
  });
  if (plan.slots.length === 0) return { ok: false, offered: 0, text };

  const specificPerSlot = plan.kind === "fallback_other_staff";
  await replaceOffers(
    input.organizationId,
    input.conversationId,
    plan.slots.map((slot) => ({
      startUtc: slot.startUtc,
      label: slot.label,
      staffId: slot.staffId ?? chosen?.id ?? null,
      serviceId: input.service.id,
      durationMinutes: slot.durationMinutes ?? null,
      anyStaff: any && !specificPerSlot,
      staffName: any ? null : (slot.staffName ?? chosen?.displayName ?? null),
    }))
  );
  return { ok: true, offered: plan.slots.length, text };
}
