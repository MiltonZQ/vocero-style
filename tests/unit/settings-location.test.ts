import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";
import { describeDb, openEphemeralDb, type EphemeralDb } from "./helpers/ephemeral-db";

/**
 * 019 — Shop address, Google Maps link and arrival lead in the agenda
 * settings: validation at the route, normalization and per-tenant persistence
 * in the service. `requireActor` is mocked: the route's own decisions are
 * under test, not actor resolution.
 */

const h = vi.hoisted(() => ({
  db: null as unknown,
  actor: { userId: "u1", organizationId: "org1", memberId: "m1", role: "owner", staffId: null } as {
    userId: string;
    organizationId: string;
    memberId: string;
    role: string;
    staffId: string | null;
  },
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  return { ...original, getDb: () => h.db };
});
vi.mock("@/lib/auth/session", () => {
  class UnauthorizedError extends Error {}
  return { UnauthorizedError };
});
vi.mock("@/lib/auth/actor", () => {
  class ForbiddenError extends Error {}
  class AccountDisabledError extends Error {}
  return { requireActor: async () => h.actor, ForbiddenError, AccountDisabledError };
});

let eph: EphemeralDb;
let PUT: (req: Request) => Promise<Response>;
let GET: () => Promise<Response>;

const put = (body: unknown) =>
  PUT(
    new Request("http://x/api/calendar/settings", {
      method: "PUT",
      body: JSON.stringify(body),
    })
  );

async function row(orgId = "org1") {
  const rows = await eph.run(
    `SELECT location_address, location_maps_url, arrival_lead_minutes, latitude, longitude FROM calendar_settings WHERE organization_id = '${orgId}'`
  );
  return rows[0];
}

beforeAll(async () => {
  process.env.AGENDA = "on";
  eph = await openEphemeralDb();
  await eph.applyMigrations();
  h.db = drizzle(eph.sql, { schema });
  await eph.run(`
    INSERT INTO organization (id, name, slug) VALUES ('org1', 'Style', 'style'), ('org2', 'Otra', 'otra');
  `);
  ({ PUT, GET } = (await import("@/app/api/calendar/settings/route")) as unknown as {
    PUT: typeof PUT;
    GET: typeof GET;
  });
});

afterAll(async () => {
  delete process.env.AGENDA;
  await eph.dropAll();
});

beforeEach(async () => {
  h.actor.role = "owner";
  h.actor.organizationId = "org1";
  await eph.run(`DELETE FROM calendar_settings`);
});

describeDb("agenda settings: shop location (real DB)", () => {
  it("defaults to no address, no link and 5 minutes", async () => {
    const res = await GET();
    const { settings } = await res.json();
    expect(settings).toMatchObject({
      locationAddress: null,
      locationMapsUrl: null,
      arrivalLeadMinutes: 5,
    });
  });

  it("saves address, maps link and arrival minutes, and reads them back", async () => {
    const res = await put({
      locationAddress: "  Av. Juárez 123, Col. Centro  ",
      locationMapsUrl: "https://maps.app.goo.gl/abc",
      arrivalLeadMinutes: 10,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).settings).toMatchObject({
      locationAddress: "Av. Juárez 123, Col. Centro",
      locationMapsUrl: "https://maps.app.goo.gl/abc",
      arrivalLeadMinutes: 10,
    });
    expect(await row()).toMatchObject({
      location_address: "Av. Juárez 123, Col. Centro",
      location_maps_url: "https://maps.app.goo.gl/abc",
      arrival_lead_minutes: 10,
    });
  });

  it("empty strings clear the address and the link", async () => {
    await put({ locationAddress: "Calle 1", locationMapsUrl: "https://maps.example/a" });
    const res = await put({ locationAddress: "   ", locationMapsUrl: "" });
    expect(res.status).toBe(200);
    expect(await row()).toMatchObject({ location_address: null, location_maps_url: null });
  });

  it("a partial update leaves the location untouched", async () => {
    await put({ locationAddress: "Calle 1", arrivalLeadMinutes: 15 });
    await put({ slotMinutes: 45 });
    expect(await row()).toMatchObject({ location_address: "Calle 1", arrival_lead_minutes: 15 });
  });

  it("rejects an address over 300 characters", async () => {
    const res = await put({ locationAddress: "x".repeat(301) });
    expect(res.status).toBe(422);
    expect(await row()).toBeUndefined();
  });

  it("accepts an address of exactly 300 characters", async () => {
    expect((await put({ locationAddress: "x".repeat(300) })).status).toBe(200);
  });

  it.each(["http://maps.example/a", "ftp://maps.example", "javascript:alert(1)", "no es url"])(
    "rejects a maps link that is not https: %s",
    async (bad) => {
      const res = await put({ locationMapsUrl: bad });
      expect(res.status).toBe(422);
      expect(await row()).toBeUndefined();
    }
  );

  it.each([-1, 121, 2.5])("rejects arrival minutes outside 0-120 or fractional: %s", async (n) => {
    expect((await put({ arrivalLeadMinutes: n })).status).toBe(422);
  });

  it("accepts the bounds 0 and 120", async () => {
    expect((await put({ arrivalLeadMinutes: 0 })).status).toBe(200);
    expect((await row())?.arrival_lead_minutes).toBe(0);
    expect((await put({ arrivalLeadMinutes: 120 })).status).toBe(200);
    expect((await row())?.arrival_lead_minutes).toBe(120);
  });

  it("only the owner can change it", async () => {
    h.actor.role = "reception";
    const res = await put({ locationAddress: "Calle 1" });
    expect(res.status).toBe(403);
    expect(await row()).toBeUndefined();
  });

  it("is scoped to the caller's organization", async () => {
    await put({ locationAddress: "Calle de org1" });
    h.actor.organizationId = "org2";
    await put({ locationAddress: "Calle de org2", arrivalLeadMinutes: 20 });
    expect(await row("org1")).toMatchObject({
      location_address: "Calle de org1",
      arrival_lead_minutes: 5,
    });
    expect(await row("org2")).toMatchObject({
      location_address: "Calle de org2",
      arrival_lead_minutes: 20,
    });
  });
});

describeDb("agenda settings: shop coordinates for the location pin (real DB)", () => {
  it("defaults to no coordinates", async () => {
    const { settings } = await (await GET()).json();
    expect(settings).toMatchObject({ latitude: null, longitude: null });
  });

  it("saves latitude and longitude and reads them back", async () => {
    const res = await put({ latitude: 4.598865027392155, longitude: -74.1632885539481 });
    expect(res.status).toBe(200);
    expect((await res.json()).settings).toMatchObject({
      latitude: 4.598865027392155,
      longitude: -74.1632885539481,
    });
    expect(await row()).toMatchObject({ latitude: 4.598865027392155, longitude: -74.1632885539481 });
    const { settings } = await (await GET()).json();
    expect(settings).toMatchObject({ latitude: 4.598865027392155, longitude: -74.1632885539481 });
  });

  it("null clears both", async () => {
    await put({ latitude: 19.4, longitude: -99.1 });
    const res = await put({ latitude: null, longitude: null });
    expect(res.status).toBe(200);
    expect(await row()).toMatchObject({ latitude: null, longitude: null });
  });

  it("a partial update leaves the coordinates untouched", async () => {
    await put({ latitude: 19.4, longitude: -99.1 });
    await put({ slotMinutes: 45 });
    expect(await row()).toMatchObject({ latitude: 19.4, longitude: -99.1 });
  });

  it.each([
    { latitude: 91, longitude: 0 },
    { latitude: -91, longitude: 0 },
    { latitude: 0, longitude: 181 },
    { latitude: 0, longitude: -181 },
    { latitude: "4.5", longitude: "-74" },
  ])("rejects coordinates out of range or not numbers: %j", async (body) => {
    expect((await put(body)).status).toBe(422);
    expect(await row()).toBeUndefined();
  });

  it("rejects latitude without longitude and the other way round", async () => {
    for (const body of [{ latitude: 4.5 }, { longitude: -74.1 }, { latitude: 4.5, longitude: null }]) {
      const res = await put(body);
      expect(res.status).toBe(422);
      expect((await res.json()).error?.message ?? "").toMatch(/latitud y longitud/i);
    }
    expect(await row()).toBeUndefined();
  });

  it("only the owner can change them, and each organization keeps its own", async () => {
    h.actor.role = "reception";
    expect((await put({ latitude: 1, longitude: 2 })).status).toBe(403);
    h.actor.role = "owner";
    await put({ latitude: 1, longitude: 2 });
    h.actor.organizationId = "org2";
    await put({ latitude: 3, longitude: 4 });
    expect(await row("org1")).toMatchObject({ latitude: 1, longitude: 2 });
    expect(await row("org2")).toMatchObject({ latitude: 3, longitude: 4 });
  });

  it("migration 0016 is re-runnable and the database also enforces the ranges", async () => {
    await eph.applyOne("0016_barber_bot_location_pin");
    const cols = await eph.run(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'calendar_settings'
          AND column_name IN ('latitude', 'longitude')`
    );
    expect(cols).toHaveLength(2);
    await expect(
      eph.run(
        `INSERT INTO calendar_settings (id, organization_id, weekly_hours, latitude, longitude)
           VALUES ('calx', 'org1', '{}'::jsonb, 91, 0)`
      )
    ).rejects.toThrow();
    await expect(
      eph.run(
        `INSERT INTO calendar_settings (id, organization_id, weekly_hours, latitude, longitude)
           VALUES ('caly', 'org1', '{}'::jsonb, 0, -181)`
      )
    ).rejects.toThrow();
  });
});
