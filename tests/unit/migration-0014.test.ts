import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  describeDb,
  openEphemeralDb,
  type EphemeralDb,
} from "./helpers/ephemeral-db";

/**
 * 018 — La migración 0014: backfill re-ejecutable y la garantía EXCLUDE.
 * Necesita Postgres real (`TEST_DATABASE_URL`); sin ella se omite.
 */

const TAG = "0014_agenda_multi_profesional";
const T = (iso: string) => `'${iso}'::timestamp`;

async function seedLegacy(db: EphemeralDb) {
  await db.run(`
    INSERT INTO "user" (id, name, email) VALUES ('u1', 'Ana Dueña', 'ana@x.test');
    INSERT INTO organization (id, name, slug) VALUES ('org1', 'Negocio', 'principal');
    INSERT INTO member (id, organization_id, user_id, role) VALUES ('mem1', 'org1', 'u1', 'owner');
    INSERT INTO calendar_settings (id, organization_id, weekly_hours, slot_minutes)
      VALUES ('cal1', 'org1', '{}'::jsonb, 45);
  `);
  const ins = (id: string, kind: string, at: string, dur: number, status = "agendada") =>
    `INSERT INTO booking (id, organization_id, kind, status, scheduled_at, duration_minutes)
       VALUES ('${id}', 'org1', '${kind}', '${status}', ${T(at)}, ${dur});`;
  await db.run(
    [
      ins("bk1", "session", "2026-08-05 15:00", 30),
      // Solapa parcialmente con bk1 (15:15–15:45): sobrevivió a la 015 porque
      // el índice único era por instante de INICIO, no por rango.
      ins("bk2", "session", "2026-08-05 15:15", 30),
      ins("bk3", "session", "2026-08-06 15:00", 30),
      ins("bk4", "session", "2026-08-07 15:00", 30, "cancelada"),
      ins("blk1", "block", "2026-08-08 15:00", 60),
    ].join("\n")
  );
}

describeDb("migración 0014 (BD real)", () => {
  let db: EphemeralDb;

  beforeAll(async () => {
    db = await openEphemeralDb();
    await db.applyMigrations({ until: TAG });
    await seedLegacy(db);
    await db.applyOne(TAG);
  });

  afterAll(async () => {
    await db?.dropAll();
  });

  it("(a) migra datos legados: toda sesión con staff y servicio", async () => {
    const orphans = await db.run(
      `SELECT id FROM booking WHERE kind = 'session' AND (staff_id IS NULL OR service_id IS NULL)`
    );
    expect(orphans).toHaveLength(0);

    const [svc] = await db.run(`SELECT name, duration_minutes, price_cents, currency FROM service`);
    expect(svc).toMatchObject({
      name: "Cita",
      duration_minutes: 45, // slot_minutes de la configuración legada
      price_cents: 0,
      currency: "MXN",
    });

    const [staff] = await db.run(`SELECT display_name, active, position FROM staff`);
    expect(staff).toMatchObject({ display_name: "Ana Dueña", active: true, position: 0 });

    const links = await db.run(`SELECT 1 FROM staff_service`);
    expect(links).toHaveLength(1);
  });

  it("(a) el par solapado legado queda con legacy_overlap; el resto no", async () => {
    const rows = await db.run(`SELECT id, legacy_overlap FROM booking ORDER BY id`);
    const flags = Object.fromEntries(rows.map((r) => [r.id, r.legacy_overlap]));
    expect(flags.bk2).toBe(true);
    expect(flags.bk1).toBe(false);
    expect(flags.bk3).toBe(false);
    expect(flags.bk4).toBe(false);
  });

  it("(a) los bloqueos legados quedan sin staff (= del local)", async () => {
    const [blk] = await db.run(
      `SELECT staff_id, service_id, price_cents FROM booking WHERE id = 'blk1'`
    );
    expect(blk).toMatchObject({ staff_id: null, service_id: null, price_cents: null });
  });

  it("(a) las sesiones legadas copian precio y moneda del catálogo", async () => {
    const [row] = await db.run(`SELECT price_cents, currency FROM booking WHERE id = 'bk3'`);
    expect(row).toMatchObject({ price_cents: 0, currency: "MXN" });
  });

  it("(b) aplicarla dos veces no duplica nada", async () => {
    const count = async () => {
      const [r] = await db.run(
        `SELECT (SELECT count(*) FROM staff)::int AS staff,
                (SELECT count(*) FROM service)::int AS service,
                (SELECT count(*) FROM staff_service)::int AS staff_service`
      );
      return r;
    };
    const before = await count();
    await db.applyOne(TAG);
    expect(await count()).toEqual(before);
    expect(before).toEqual({ staff: 1, service: 1, staff_service: 1 });
  });

  describe("(c) el EXCLUDE", () => {
    let staffId: string;
    let serviceId: string;
    let seq = 0;

    beforeAll(async () => {
      const [s] = await db.run(`SELECT id FROM staff LIMIT 1`);
      const [v] = await db.run(`SELECT id FROM service LIMIT 1`);
      staffId = s!.id;
      serviceId = v!.id;
      await db.run(
        `INSERT INTO staff (id, organization_id, display_name) VALUES ('st_otro', 'org1', 'Otro')`
      );
    });

    const insert = (
      at: string,
      dur: number,
      o: { staff?: string; status?: string; isTest?: boolean } = {}
    ) =>
      db.run(
        `INSERT INTO booking (id, organization_id, kind, status, is_test, staff_id, service_id,
                              scheduled_at, duration_minutes)
         VALUES ('bk_x${++seq}', 'org1', 'session', '${o.status ?? "agendada"}',
                 ${o.isTest ?? false}, '${o.staff ?? staffId}', '${serviceId}',
                 ${T(at)}, ${dur})`
      );

    it("dos sesiones solapadas del mismo profesional: 23P01", async () => {
      await insert("2026-09-01 10:00", 30);
      await expect(insert("2026-09-01 10:15", 30)).rejects.toMatchObject({
        code: "23P01",
      });
    });

    it("adyacentes [10:00,10:30) y [10:30,11:00) pasan", async () => {
      await insert("2026-09-02 10:00", 30);
      await expect(insert("2026-09-02 10:30", 30)).resolves.toBeDefined();
    });

    it("dos profesionales distintos al mismo instante pasan", async () => {
      await insert("2026-09-03 10:00", 30);
      await expect(
        insert("2026-09-03 10:00", 30, { staff: "st_otro" })
      ).resolves.toBeDefined();
    });

    it("una cita de prueba o cancelada no ocupa", async () => {
      await insert("2026-09-04 10:00", 30, { isTest: true });
      await insert("2026-09-04 10:00", 30, { status: "cancelada" });
      await expect(insert("2026-09-04 10:00", 30)).resolves.toBeDefined();
    });

    it("una sesión sin profesional o servicio la rechaza el CHECK (23514)", async () => {
      await expect(
        db.run(
          `INSERT INTO booking (id, organization_id, kind, scheduled_at, duration_minutes)
           VALUES ('bk_sinstaff', 'org1', 'session', ${T("2026-09-05 10:00")}, 30)`
        )
      ).rejects.toMatchObject({ code: "23514" });
    });
  });
});
