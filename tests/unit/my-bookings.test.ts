import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";
import {
  buildMyBookingsMessage,
  existingBookingNotice,
  listUpcomingBookings,
  type UpcomingBooking,
} from "@/server/agenda/my-bookings";
import { describeDb, openEphemeralDb, type EphemeralDb } from "./helpers/ephemeral-db";

const NOW = new Date("2026-10-11T16:00:00Z");

const upcoming: UpcomingBooking = {
  id: "bk1",
  serviceName: "Fade",
  staffName: "Charly",
  startUtc: "2026-10-12T23:00:00.000Z", // Monday 17:00 local
  durationMinutes: 45,
};

describe("buildMyBookingsMessage", () => {
  it("lists service, staff, local date and time, duration and address", () => {
    const text = buildMyBookingsMessage([upcoming], {
      timezone: "America/Mexico_City",
      locationAddress: "Av. Juárez 123",
      locationMapsUrl: "https://maps.example/x",
    });
    expect(text).toContain("Fade");
    expect(text).toContain("Charly");
    expect(text).toContain("Lunes 12 de octubre, 17:00");
    expect(text).toContain("45 min");
    expect(text).toContain("Av. Juárez 123");
  });

  it("says so when there is nothing upcoming", () => {
    const text = buildMyBookingsMessage([], {
      timezone: "America/Mexico_City",
      locationAddress: null,
      locationMapsUrl: null,
    });
    expect(text).toMatch(/no tienes/i);
  });
});

describe("existingBookingNotice", () => {
  it("is null without bookings", () => {
    expect(existingBookingNotice([], "America/Mexico_City")).toBeNull();
  });

  it("mentions the booking and asks whether to add another", () => {
    const text = existingBookingNotice([upcoming], "America/Mexico_City");
    expect(text).toContain("Ya tienes");
    expect(text).toContain("Lunes 12 de octubre, 17:00");
    expect(text).toContain("otra adicional");
  });
});

describeDb("listUpcomingBookings (real DB)", () => {
  let eph: EphemeralDb;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    eph = await openEphemeralDb();
    await eph.applyMigrations();
    db = drizzle(eph.sql, { schema });
    await eph.run(`
      INSERT INTO organization (id, name, slug) VALUES ('org1','A','a'), ('org2','B','b');
      INSERT INTO contact (id, organization_id, name, wa_identity) VALUES
        ('ct1','org1','Uno','5215500000001'),
        ('ct2','org1','Dos','5215500000002'),
        ('ct3','org2','Tres','5215500000003');
      INSERT INTO service (id, organization_id, name, duration_minutes) VALUES
        ('sv1','org1','Fade',45), ('sv3','org2','Otro',30);
      INSERT INTO staff (id, organization_id, display_name) VALUES
        ('st1','org1','Charly'), ('st3','org2','Zed');
      INSERT INTO booking (id, organization_id, kind, status, source, contact_id, scheduled_at,
                           duration_minutes, is_test, staff_id, service_id) VALUES
        ('b_ok','org1','session','agendada','ai','ct1','2026-10-12 23:00',45,false,'st1','sv1'),
        ('b_later','org1','session','agendada','ai','ct1','2026-10-14 23:00',45,false,'st1','sv1'),
        ('b_past','org1','session','agendada','ai','ct1','2026-10-01 23:00',45,false,'st1','sv1'),
        ('b_cancel','org1','session','cancelada','ai','ct1','2026-10-13 23:00',45,false,'st1','sv1'),
        ('b_test','org1','session','agendada','ai','ct1','2026-10-15 23:00',45,true,'st1','sv1'),
        ('b_other_contact','org1','session','agendada','ai','ct2','2026-10-12 21:00',45,false,'st1','sv1'),
        ('b_other_org','org2','session','agendada','ai','ct3','2026-10-12 22:00',30,false,'st3','sv3');
    `);
  });

  afterAll(async () => {
    await eph.dropAll();
  });

  it("returns only this contact's upcoming scheduled sessions, soonest first", async () => {
    const rows = await listUpcomingBookings("org1", "ct1", { now: NOW, isTest: false }, db);
    expect(rows.map((r) => r.id)).toEqual(["b_ok", "b_later"]);
    expect(rows[0]).toMatchObject({
      serviceName: "Fade",
      staffName: "Charly",
      durationMinutes: 45,
      startUtc: "2026-10-12T23:00:00.000Z",
    });
  });

  it("shows test bookings only to test conversations", async () => {
    const rows = await listUpcomingBookings("org1", "ct1", { now: NOW, isTest: true }, db);
    expect(rows.map((r) => r.id)).toEqual(["b_test"]);
  });

  it("never leaks another contact or another organization", async () => {
    expect(
      (await listUpcomingBookings("org1", "ct3", { now: NOW, isTest: false }, db)).map((r) => r.id)
    ).toEqual([]);
    expect(
      (await listUpcomingBookings("org2", "ct1", { now: NOW, isTest: false }, db)).map((r) => r.id)
    ).toEqual([]);
    expect(
      (await listUpcomingBookings("org1", "ct2", { now: NOW, isTest: false }, db)).map((r) => r.id)
    ).toEqual(["b_other_contact"]);
  });
});
