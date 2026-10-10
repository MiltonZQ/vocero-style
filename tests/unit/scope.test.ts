import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type { Actor } from "@/lib/auth/actor";
import {
  assertCanWriteBooking,
  bookingScope,
  denyOutOfScope,
  OutOfScopeError,
} from "@/server/agenda/scope";

const dialect = new PgDialect();
const render = (q: NonNullable<ReturnType<typeof bookingScope>>) =>
  dialect.sqlToQuery(q);

const base = { userId: "u_1", organizationId: "org_1", memberId: "mem_1" };
const owner: Actor = { ...base, role: "owner", staffId: null };
const reception: Actor = { ...base, role: "reception", staffId: null };
const staffA: Actor = { ...base, role: "staff", staffId: "st_A" };
const staffNoProfile: Actor = { ...base, role: "staff", staffId: null };

describe("bookingScope", () => {
  it("owner y reception: sin filtro extra", () => {
    expect(bookingScope(owner)).toBeUndefined();
    expect(bookingScope(reception)).toBeUndefined();
  });

  it("staff: propias OR bloqueos del local", () => {
    const q = render(bookingScope(staffA)!);
    expect(q.sql).toContain('"staff_id" = $1');
    expect(q.sql).toContain('"kind" = $2');
    expect(q.sql).toContain('"staff_id" is null');
    expect(q.sql).toMatch(/ or /i);
    expect(q.params).toEqual(["st_A", "block"]);
  });

  it("staff sin perfil: predicado vacio (no ve nada)", () => {
    const q = render(bookingScope(staffNoProfile)!);
    expect(q.sql.trim()).toBe("false");
  });
});

describe("assertCanWriteBooking", () => {
  const own = { staffId: "st_A", kind: "session" as const };
  const foreign = { staffId: "st_B", kind: "session" as const };
  const shopBlock = { staffId: null, kind: "block" as const };
  const ownBlock = { staffId: "st_A", kind: "block" as const };

  it("owner y reception escriben todo", () => {
    for (const a of [owner, reception]) {
      expect(() => assertCanWriteBooking(a, own)).not.toThrow();
      expect(() => assertCanWriteBooking(a, foreign)).not.toThrow();
      expect(() => assertCanWriteBooking(a, shopBlock)).not.toThrow();
    }
  });

  it("staff escribe lo propio (incluido su bloqueo personal)", () => {
    expect(() => assertCanWriteBooking(staffA, own)).not.toThrow();
    expect(() => assertCanWriteBooking(staffA, ownBlock)).not.toThrow();
  });

  it("staff no escribe lo ajeno ni el bloqueo del local", () => {
    expect(() => assertCanWriteBooking(staffA, foreign)).toThrow(OutOfScopeError);
    expect(() => assertCanWriteBooking(staffA, shopBlock)).toThrow(OutOfScopeError);
  });

  it("staff sin perfil no escribe nada", () => {
    expect(() => assertCanWriteBooking(staffNoProfile, own)).toThrow(OutOfScopeError);
    expect(() => assertCanWriteBooking(staffNoProfile, shopBlock)).toThrow(OutOfScopeError);
  });
});

describe("denyOutOfScope", () => {
  it("404 not_found sin datos de la cita", async () => {
    const res = denyOutOfScope();
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("not_found");
    expect(Object.keys(body)).toEqual(["error"]);
  });
});
