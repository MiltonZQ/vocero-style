import { timeInTz } from "@/lib/time/slots";
import type { OfferedSlot } from "@/server/agenda/offers";
import { resolveWhen, type WhenSettings } from "@/server/agenda/when";

/**
 * 019 — Which of the offered slots did the client pick?
 *
 * The client answers in plain words ("a las 9:30", "el primero", "el martes a
 * las 10"). The model passes along what it heard (`time`, `day`, `option`) and
 * THIS decides, against the slots the conversation was really offered: time
 * (and day) first, the ordinal as the fallback. Pure; never touches the DB.
 */

export type OfferPick = { time?: string; day?: string; option?: number };

export type OfferMatch =
  | { kind: "one"; index: number }
  | { kind: "none" }
  /** More than one distinct instant fits: the client must say which. */
  | { kind: "many" };

export type OfferMatchContext = WhenSettings & { now: Date };

/** Indexes whose instant is distinct: two staff free at one instant are one choice. */
function distinct(offers: readonly OfferedSlot[], indexes: number[]): number[] {
  const seen = new Set<string>();
  return indexes.filter((i) => {
    const start = offers[i]?.startUtc;
    if (!start || seen.has(start)) return false;
    seen.add(start);
    return true;
  });
}

function verdict(offers: readonly OfferedSlot[], indexes: number[]): OfferMatch {
  const unique = distinct(offers, indexes);
  const [only] = unique;
  if (unique.length === 0 || only === undefined) return { kind: "none" };
  return unique.length === 1 ? { kind: "one", index: only } : { kind: "many" };
}

export function matchOffer(
  offers: readonly OfferedSlot[],
  pick: OfferPick,
  ctx: OfferMatchContext
): OfferMatch {
  const time = pick.time?.trim() || undefined;
  const day = pick.day?.trim() || undefined;
  const all = offers.map((_, i) => i);

  if (time || day) {
    let candidates = all;
    if (time) {
      candidates = candidates.filter((i) => timeInTz(offers[i]!.startUtc, ctx.timezone) === time);
    }
    if (day) {
      const window = resolveWhen({ day }, ctx.now, ctx);
      // A day we cannot read never vetoes a time the client did say.
      if (window.ok) {
        const start = Date.parse(window.startUtc);
        const end = Date.parse(window.endUtc);
        const inDay = candidates.filter((i) => {
          const t = Date.parse(offers[i]!.startUtc);
          return t >= start && t < end;
        });
        if (inDay.length > 0 || !time) candidates = inDay;
        else candidates = [];
      } else if (!time) {
        candidates = [];
      }
    }
    const byTime = verdict(offers, candidates);
    if (byTime.kind === "one") return byTime;
    if (byTime.kind === "many" || pick.option === undefined) return byTime;
  }

  const n = pick.option;
  if (n !== undefined && Number.isInteger(n) && n >= 1 && n <= offers.length) {
    return { kind: "one", index: n - 1 };
  }
  return { kind: "none" };
}
