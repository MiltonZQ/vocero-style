import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 018 — El primer registro siembra, además del pipeline y el agente, el
 * profesional por defecto y el servicio «Cita» (convergente con el backfill de
 * la migración 0014): una instancia nueva nace lista para agendar.
 */

type Insert = { table: string; values: unknown };
const inserts: Insert[] = [];

function tableName(t: unknown): string {
  return (t as { __name: string }).__name;
}

vi.mock("@/lib/db", () => {
  const tx = {
    execute: async () => {},
    select: () => ({ from: async () => [{ n: 0 }] }),
    insert: (t: unknown) => ({
      values: async (values: unknown) => {
        inserts.push({ table: tableName(t), values });
      },
    }),
  };
  const mk = (n: string) => ({ __name: n });
  return {
    getDb: () => ({ transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) }),
    schema: {
      organization: mk("organization"),
      member: mk("member"),
      pipelineStage: mk("pipelineStage"),
      agentProfile: mk("agentProfile"),
      staff: mk("staff"),
      service: mk("service"),
      staffService: mk("staffService"),
    },
  };
});

import { onUserCreated } from "@/server/auth/on-signup";

describe("onUserCreated — semilla de agenda", () => {
  beforeEach(() => {
    inserts.length = 0;
  });

  it("siembra el profesional por defecto, el servicio «Cita» y su vínculo", async () => {
    await onUserCreated("u1", "Ana");

    const byTable = (t: string) => inserts.filter((i) => i.table === t);
    const [staff] = byTable("staff").map((i) => i.values as Record<string, unknown>);
    const [service] = byTable("service").map((i) => i.values as Record<string, unknown>);
    const [link] = byTable("staffService").map((i) => i.values as Record<string, unknown>);

    expect(staff).toMatchObject({
      displayName: "Ana",
      active: true,
      position: 0,
    });
    expect(String(staff!.id)).toMatch(/^st_/);
    expect(service).toMatchObject({
      name: "Cita",
      durationMinutes: 30,
      priceCents: 0,
      currency: "MXN",
    });
    expect(String(service!.id)).toMatch(/^sv_/);
    expect(link).toMatchObject({ staffId: staff!.id, serviceId: service!.id });
    // Todo lleva la misma organización (Constitución III).
    const orgs = new Set(
      [staff, service, link].map((r) => r!.organizationId as string)
    );
    expect(orgs.size).toBe(1);
  });
});
