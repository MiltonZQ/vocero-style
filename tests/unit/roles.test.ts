import { describe, expect, it } from "vitest";
import {
  can,
  isOrgMutationBlocked,
  normalizeRole,
  type Capability,
  type Role,
} from "@/lib/auth/roles";

/**
 * 018 (D5) — el rol de acceso vive en `member.role` como texto. El valor
 * legado `member` se lee como `reception`; lo desconocido NO tiene acceso
 * (nunca owner por defecto).
 */
describe("normalizeRole", () => {
  it("lee el valor legado `member` como reception", () => {
    expect(normalizeRole("member")).toBe("reception");
  });

  it("deja pasar owner | reception | staff", () => {
    expect(normalizeRole("owner")).toBe("owner");
    expect(normalizeRole("reception")).toBe("reception");
    expect(normalizeRole("staff")).toBe("staff");
  });

  it("null, undefined y valores desconocidos -> null (sin acceso)", () => {
    expect(normalizeRole(null)).toBeNull();
    expect(normalizeRole(undefined)).toBeNull();
    expect(normalizeRole("admin")).toBeNull();
    expect(normalizeRole("")).toBeNull();
    expect(normalizeRole("OWNER")).toBeNull();
  });
});

describe("can(role, capability) — matriz del data-model", () => {
  const matrix: Record<Capability, Record<Role, boolean>> = {
    "calendar.global": { owner: true, reception: true, staff: false },
    "booking.manage_any": { owner: true, reception: true, staff: false },
    "catalog.read": { owner: true, reception: true, staff: true },
    "catalog.write": { owner: true, reception: false, staff: false },
    "staff_services.manage_any": { owner: true, reception: false, staff: false },
    "team.manage": { owner: true, reception: false, staff: false },
    "hours.manage_all": { owner: true, reception: false, staff: false },
    "blocks.shop": { owner: true, reception: true, staff: false },
    inbox: { owner: true, reception: true, staff: false },
    "sse.all": { owner: true, reception: true, staff: false },
  };

  for (const [cap, byRole] of Object.entries(matrix)) {
    for (const [role, expected] of Object.entries(byRole)) {
      it(`${role} ${expected ? "puede" : "no puede"} ${cap}`, () => {
        expect(can(role as Role, cap as Capability)).toBe(expected);
      });
    }
  }

  it("un rol nulo no puede nada", () => {
    expect(can(null, "inbox")).toBe(false);
    expect(can(null, "catalog.read")).toBe(false);
  });
});

describe("isOrgMutationBlocked (hook de /organization/*)", () => {
  it("bloquea a staff las mutaciones del plugin", () => {
    expect(isOrgMutationBlocked("/organization/update-member-role", "POST", "staff")).toBe(true);
    expect(isOrgMutationBlocked("/organization/invite-member", "POST", "staff")).toBe(true);
    expect(isOrgMutationBlocked("/organization/remove-member", "DELETE", "staff")).toBe(true);
  });

  it("no bloquea lecturas ni a otros roles ni otras rutas", () => {
    expect(isOrgMutationBlocked("/organization/get-full-organization", "GET", "staff")).toBe(false);
    expect(isOrgMutationBlocked("/organization/update-member-role", "POST", "owner")).toBe(false);
    expect(isOrgMutationBlocked("/organization/update-member-role", "POST", "reception")).toBe(false);
    expect(isOrgMutationBlocked("/sign-in/email", "POST", "staff")).toBe(false);
  });

  it("un rol desconocido (null) tampoco muta", () => {
    expect(isOrgMutationBlocked("/organization/update-member-role", "POST", null)).toBe(true);
  });
});
