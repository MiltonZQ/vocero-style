import { describe, expect, it } from "vitest";
import { resolveService, resolveStaff } from "@/server/agenda/agent";

const corte = { id: "sv_corte", name: "Corte clásico" };
const barba = { id: "sv_barba", name: "Barba" };
const jose = { id: "st_jose", displayName: "José" };
const ana = { id: "st_ana", displayName: "Ana" };

describe("resolveService", () => {
  it("matches exact, then lowercase, then without accents", () => {
    expect(resolveService("Corte clásico", [corte, barba])?.id).toBe("sv_corte");
    expect(resolveService("corte clásico", [corte])?.id).toBe("sv_corte");
    expect(resolveService("corte clasico", [corte])?.id).toBe("sv_corte");
  });

  it("returns null when nothing matches and never throws", () => {
    expect(resolveService("Tinte", [corte, barba])).toBeNull();
    expect(() => resolveService("Tinte", [corte])).not.toThrow();
  });

  it("assumes the only service and does not ask", () => {
    expect(resolveService(undefined, [corte])?.id).toBe("sv_corte");
    expect(resolveService("  ", [corte])?.id).toBe("sv_corte");
    expect(resolveService(undefined, [corte, barba])).toBeNull();
  });

  it("does not invent a service when the fold is ambiguous", () => {
    expect(
      resolveService("corte", [
        { id: "sv_a", name: "Corte" },
        { id: "sv_b", name: "CORTE" },
      ])
    ).toBeNull();
  });
});

describe("resolveStaff", () => {
  it("matches exact, then lowercase, then without accents", () => {
    expect(resolveStaff("José", [jose, ana])).toEqual(jose);
    expect(resolveStaff("josé", [jose])).toEqual(jose);
    expect(resolveStaff("jose", [jose])).toEqual(jose);
  });

  it("treats any and omitted as any", () => {
    expect(resolveStaff(undefined, [jose, ana])).toBe("any");
    expect(resolveStaff("  ", [jose])).toBe("any");
    expect(resolveStaff("any", [jose])).toBe("any");
    expect(resolveStaff("ANY", [jose, ana])).toBe("any");
  });

  it("returns null when the name is unknown", () => {
    expect(resolveStaff("Pedro", [jose, ana])).toBeNull();
  });

  it("does not ask when there is a single professional", () => {
    expect(resolveStaff(undefined, [jose])).toBe("any");
    expect(resolveStaff("José", [jose])).toEqual(jose);
  });
});
