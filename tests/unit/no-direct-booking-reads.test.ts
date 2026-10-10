import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 018 (D6) — toda consulta de `booking` pasa por `src/server/agenda/` para
 * poder componerse con `bookingScope(actor)`. Este test falla si algun archivo
 * de fuera importa la tabla `booking` desde el esquema.
 *
 * LISTA DE DEUDA: consumidores existentes de la 015 que todavia leen/escriben
 * `booking` directo. T060/T113 los migran al servicio y vacian la lista; no se
 * agregan nuevos (agregar uno aqui requiere justificarlo en la revision).
 */
const KNOWN_DEBT = new Set<string>([
  // Medicion inicial (018 Slice 2): el arbol ya esta limpio, la lista nace vacia.
]);

const ROOT = join(process.cwd(), "src");
const ALLOWED_PREFIX = ["server", "agenda"].join(sep);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** `schema.booking` o `{ booking }` importado de "@/lib/db/schema". */
function readsBookingTable(src: string): boolean {
  if (/\bschema\.booking\b/.test(src)) return true;
  const imp = /import\s*\{([^}]*)\}\s*from\s*["']@\/lib\/db\/schema["']/g;
  for (const m of src.matchAll(imp)) {
    if (/(^|[,\s])booking(\s+as\s+\w+)?\s*(,|$)/.test(m[1] ?? "")) return true;
  }
  return false;
}

describe("vigilancia: nadie fuera de server/agenda lee `booking` directo", () => {
  const offenders = walk(ROOT)
    .map((f) => relative(ROOT, f))
    .filter((rel) => !rel.startsWith(ALLOWED_PREFIX + sep))
    .filter((rel) => rel !== join("lib", "db", "schema.ts"))
    .filter((rel) => readsBookingTable(readFileSync(join(ROOT, rel), "utf8")))
    .map((rel) => rel.split(sep).join("/"));

  it("no hay consumidores nuevos fuera de la lista de deuda conocida", () => {
    const nuevos = offenders.filter((f) => !KNOWN_DEBT.has(f));
    expect(nuevos).toEqual([]);
  });

  it("la lista de deuda no tiene entradas obsoletas", () => {
    const obsoletas = [...KNOWN_DEBT].filter((f) => !offenders.includes(f));
    expect(obsoletas).toEqual([]);
  });
});
