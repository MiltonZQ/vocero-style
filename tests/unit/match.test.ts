import { describe, expect, it } from "vitest";
import { isAnyStaff, matchByName } from "@/server/agenda/match";

const services = [
  { id: "sv_corte", name: "Corte" },
  { id: "sv_barba", name: "Barba" },
  { id: "sv_combo", name: "Corte + barba" },
  { id: "sv_tinta", name: "Tinta" },
];

describe("matchByName", () => {
  it("matches case- and accent-insensitively", () => {
    const r = matchByName("  BARBA ", services);
    expect(r).toEqual({ kind: "one", item: services[1] });
    const acc = matchByName("peinado clásico", [{ id: "a", name: "Peinado clasico" }]);
    expect(acc.kind).toBe("one");
  });

  it("prefers an exact match over longer names that start with it", () => {
    expect(matchByName("corte", services)).toEqual({ kind: "one", item: services[0] });
  });

  it("matches 'corte y barba' to 'Corte + barba'", () => {
    expect(matchByName("corte y barba", services)).toEqual({ kind: "one", item: services[2] });
    expect(matchByName("barba y corte", services)).toEqual({ kind: "one", item: services[2] });
  });

  it("matches when the customer wraps the name in a sentence", () => {
    expect(matchByName("quiero una tinta por favor", services)).toEqual({
      kind: "one",
      item: services[3],
    });
  });

  it("matches by prefix and by contained word", () => {
    expect(matchByName("tin", services).kind).toBe("one");
    const staff = [
      { id: "st_1", name: "Carlos Ruiz" },
      { id: "st_2", name: "Ana López" },
    ];
    expect(matchByName("lopez", staff)).toEqual({ kind: "one", item: staff[1] });
  });

  it("returns many for an ambiguous name (two Carlos)", () => {
    const staff = [
      { id: "st_1", name: "Carlos Ruiz" },
      { id: "st_2", name: "Carlos Pérez" },
      { id: "st_3", name: "Ana" },
    ];
    const r = matchByName("Carlos", staff);
    expect(r.kind).toBe("many");
    if (r.kind === "many") expect(r.items.map((i) => i.id)).toEqual(["st_1", "st_2"]);
    expect(matchByName("carlos perez", staff)).toEqual({ kind: "one", item: staff[1] });
  });

  it("an exact name beats a longer sibling", () => {
    const staff = [
      { id: "st_1", name: "Carlos" },
      { id: "st_2", name: "Carlos Ruiz" },
    ];
    expect(matchByName("carlos", staff)).toEqual({ kind: "one", item: staff[0] });
  });

  it("returns none with a closest suggestion for a near miss", () => {
    const r = matchByName("tinte", services);
    expect(r).toEqual({ kind: "none", closest: services[3] });
  });

  it("returns none without a suggestion when nothing is close", () => {
    expect(matchByName("afeitado con navaja", services)).toEqual({ kind: "none" });
  });

  it("handles empty input and empty catalogs", () => {
    expect(matchByName("   ", services)).toEqual({ kind: "none" });
    expect(matchByName("corte", [])).toEqual({ kind: "none" });
  });
});

describe("isAnyStaff", () => {
  it.each(["cualquiera", "Cualquiera!", "me da igual", "El que sea", "any", "con quien sea", "el que esté disponible"])(
    "accepts %s",
    (text) => expect(isAnyStaff(text)).toBe(true)
  );

  it.each(["Carlos", "", "cualquiera no, quiero a Ana", "company"])("rejects %s", (text) =>
    expect(isAnyStaff(text)).toBe(false)
  );
});
