/**
 * 019 — Resolución de nombres que escribe el cliente (servicio o profesional)
 * contra un catálogo. Puro: sin BD ni red.
 */

export type Named = { id: string; name: string };

export type MatchResult<T extends Named> =
  | { kind: "one"; item: T }
  | { kind: "many"; items: T[] }
  | { kind: "none"; closest?: T };

/** Palabras de relleno que no distinguen un nombre de otro. */
const STOPWORDS = new Set([
  "y", "e", "de", "del", "el", "la", "los", "las", "con", "un", "una",
  "para", "por", "favor", "quiero", "quisiera", "me", "mi", "al",
]);

/** Minúsculas, sin acentos ni signos; los espacios colapsados. */
export function normalizeText(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function significantTokens(normalized: string): string[] {
  return normalized.split(" ").filter((t) => t && !STOPWORDS.has(t));
}

function containsWord(haystack: string, needle: string): boolean {
  return ` ${haystack} `.includes(` ${needle} `);
}

function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j] ?? 0;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(up + 1, (prev[j - 1] ?? 0) + 1, diag + cost);
      diag = up;
    }
  }
  return prev[b.length] ?? 0;
}

/** Puntaje por nivel: exacto > mismas palabras > prefijo > contenido > traslape. */
function score(input: string, inputTokens: string[], name: string): number {
  const nameTokens = significantTokens(name);
  if (input === name) return 100;
  if (
    inputTokens.length > 0 &&
    inputTokens.length === nameTokens.length &&
    [...inputTokens].sort().join(" ") === [...nameTokens].sort().join(" ")
  ) {
    return 95;
  }
  if (name.startsWith(input)) return 80;
  if (input.startsWith(`${name} `)) return 75;
  if (containsWord(name, input)) return 70;
  if (containsWord(input, name)) return 65;
  const shared = inputTokens.filter((t) => nameTokens.includes(t)).length;
  if (shared === 0) return 0;
  if (shared === inputTokens.length) return 60;
  const ratio = shared / inputTokens.length;
  return ratio >= 0.5 ? 30 + ratio * 20 : 0;
}

/** El elemento con una palabra casi igual (typo) o con el mismo prefijo de 4+. */
function closestByTypo<T extends Named>(
  inputTokens: string[],
  items: { item: T; name: string }[]
): T | undefined {
  let best: { item: T; distance: number } | undefined;
  for (const { item, name } of items) {
    for (const nt of significantTokens(name)) {
      for (const it of inputTokens) {
        const distance = editDistance(it, nt);
        const close = distance <= 2 && Math.min(it.length, nt.length) >= 3;
        if (close && (!best || distance < best.distance)) best = { item, distance };
      }
    }
  }
  return best?.item;
}

export function matchByName<T extends Named>(
  input: string,
  items: readonly T[]
): MatchResult<T> {
  const normalized = normalizeText(input);
  if (!normalized || items.length === 0) return { kind: "none" };
  const inputTokens = significantTokens(normalized);
  const prepared = items.map((item) => ({ item, name: normalizeText(item.name) }));

  const scored = prepared.map((p) => ({
    ...p,
    score: score(normalized, inputTokens, p.name),
  }));
  const top = Math.max(...scored.map((s) => s.score));
  if (top <= 0) {
    const closest = closestByTypo(inputTokens, prepared);
    return closest ? { kind: "none", closest } : { kind: "none" };
  }
  const winners = scored.filter((s) => s.score === top).map((s) => s.item);
  const [first] = winners;
  return winners.length === 1 && first
    ? { kind: "one", item: first }
    : { kind: "many", items: winners };
}

const ANY_STAFF_PHRASES = [
  "cualquiera",
  "cualquier",
  "me da igual",
  "da igual",
  "el que sea",
  "con quien sea",
  "quien sea",
  "el que este disponible",
  "sin preferencia",
  "no importa",
  "any",
  "anyone",
];

/** "Cualquiera", "me da igual", "any"... ⇒ el literal `any` de `staffChoice`. */
export function isAnyStaff(input: string): boolean {
  const normalized = normalizeText(input);
  if (!normalized) return false;
  // "cualquiera no, quiero a Ana" elige a alguien: una negación anula el "any".
  if (containsWord(normalized, "no") && !containsWord(normalized, "no importa")) {
    return false;
  }
  return ANY_STAFF_PHRASES.some((p) => containsWord(normalized, p));
}
