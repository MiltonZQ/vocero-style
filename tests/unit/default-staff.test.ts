import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 018 — Compatibilidad temporal (US2): con UN profesional activo y UN
 * servicio activo la 015 sigue reservando sin mandarlos; con más de uno no se
 * adivina (el servicio responde `service_required`).
 */

/** Cola de resultados para cada `select(...).limit(n)` en orden de llamada. */
const selectRows: unknown[][] = [];

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy"]) c[m] = () => c;
  c.limit = () => Promise.resolve(rows);
  return c;
}

vi.mock("@/lib/db", () => ({
  getDb: () => ({ select: () => chain(selectRows.shift() ?? []) }),
  schema: {
    staff: { organizationId: "o", active: "a", position: "p", id: "id" },
    service: {
      organizationId: "o",
      active: "a",
      position: "p",
      id: "id",
      durationMinutes: "d",
      priceCents: "pc",
      currency: "c",
    },
    staffService: {
      organizationId: "o",
      staffId: "s",
      serviceId: "v",
      durationMinutes: "d",
    },
  },
}));

import {
  resolveDefaultCatalog,
  resolveSoleStaffId,
} from "@/server/agenda/default-staff";

describe("resolveSoleStaffId", () => {
  beforeEach(() => {
    selectRows.length = 0;
  });

  it("devuelve el id cuando hay exactamente un profesional activo", async () => {
    selectRows.push([{ id: "st_1" }]);
    expect(await resolveSoleStaffId("org_1")).toBe("st_1");
  });

  it("devuelve null con varios o con ninguno (no se adivina)", async () => {
    selectRows.push([{ id: "st_1" }, { id: "st_2" }]);
    expect(await resolveSoleStaffId("org_1")).toBeNull();
    selectRows.push([]);
    expect(await resolveSoleStaffId("org_1")).toBeNull();
  });
});

describe("resolveDefaultCatalog", () => {
  beforeEach(() => {
    selectRows.length = 0;
  });

  const sv = {
    id: "sv_1",
    durationMinutes: 30,
    priceCents: 15000,
    currency: "MXN",
  };

  it("copia duración, precio y moneda del catálogo", async () => {
    selectRows.push([{ id: "st_1" }], [sv], []);
    expect(await resolveDefaultCatalog("org_1")).toEqual({
      staffId: "st_1",
      serviceId: "sv_1",
      durationMinutes: 30,
      priceCents: 15000,
      currency: "MXN",
    });
  });

  it("la duración propia del profesional gana a la del catálogo", async () => {
    selectRows.push([{ id: "st_1" }], [sv], [{ durationMinutes: 45 }]);
    expect((await resolveDefaultCatalog("org_1"))?.durationMinutes).toBe(45);
  });

  it("null si hay más de un servicio activo", async () => {
    selectRows.push([{ id: "st_1" }], [sv, { ...sv, id: "sv_2" }]);
    expect(await resolveDefaultCatalog("org_1")).toBeNull();
  });

  it("null si hay más de un profesional activo", async () => {
    selectRows.push([{ id: "st_1" }, { id: "st_2" }]);
    expect(await resolveDefaultCatalog("org_1")).toBeNull();
  });
});
