import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";
import {
  clearDraft,
  DRAFT_TTL_MS,
  deriveStep,
  getDraft,
  upsertDraft,
  type DraftDb,
} from "@/server/agenda/draft";
import {
  describeDb,
  openEphemeralDb,
  type EphemeralDb,
} from "./helpers/ephemeral-db";

const base = { serviceId: null, staffChoice: null };

describe("deriveStep", () => {
  it("asks for the service first, whatever else is set", () => {
    expect(deriveStep(base)).toBe("need_service");
    expect(deriveStep({ serviceId: null, staffChoice: "any" })).toBe("need_service");
  });

  it("asks for the staff once there is a service", () => {
    expect(deriveStep({ serviceId: "sv_1", staffChoice: null })).toBe("need_staff");
  });

  it("needs a slot once service and staff are set (staff id or any)", () => {
    expect(deriveStep({ serviceId: "sv_1", staffChoice: "any" })).toBe("need_slot");
    expect(deriveStep({ serviceId: "sv_1", staffChoice: "st_1" })).toBe("need_slot");
  });

  it("is ready only when offers exist for a complete draft", () => {
    const full = { serviceId: "sv_1", staffChoice: "st_1" };
    expect(deriveStep(full, { hasOffers: true })).toBe("ready");
    // Offers never skip a missing earlier step.
    expect(deriveStep({ serviceId: null, staffChoice: "st_1" }, { hasOffers: true })).toBe(
      "need_service"
    );
  });
});

describe("DRAFT_TTL_MS", () => {
  it("is 24 hours", () => {
    expect(DRAFT_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describeDb("booking draft (BD real)", () => {
  let eph: EphemeralDb;
  let db: DraftDb;

  beforeAll(async () => {
    eph = await openEphemeralDb();
    await eph.applyMigrations();
    db = drizzle(eph.sql, { schema }) as unknown as DraftDb;
    await eph.run(`
      INSERT INTO organization (id, name, slug) VALUES
        ('org1', 'A', 'a'), ('org2', 'B', 'b');
      INSERT INTO contact (id, organization_id, name, wa_identity) VALUES
        ('ct1', 'org1', 'Uno', '5215500000001'), ('ct2', 'org2', 'Dos', '5215500000002');
      INSERT INTO conversation (id, organization_id, contact_id) VALUES
        ('cv1', 'org1', 'ct1'), ('cv2', 'org2', 'ct2');
      INSERT INTO service (id, organization_id, name, duration_minutes)
        VALUES ('sv1', 'org1', 'Corte', 30);
    `);
  });

  afterAll(async () => {
    await eph.dropAll();
  });

  it("returns null when there is no draft", async () => {
    expect(await getDraft("org1", "cv1", db)).toBeNull();
  });

  it("creates on first upsert and merges partial updates afterwards", async () => {
    await upsertDraft("org1", "cv1", { serviceId: "sv1" }, db);
    await upsertDraft("org1", "cv1", { staffChoice: "any" }, db);
    await upsertDraft("org1", "cv1", { when: { day: "mañana", from: "16:00" } }, db);
    const d = await getDraft("org1", "cv1", db);
    expect(d).toMatchObject({
      serviceId: "sv1",
      staffChoice: "any",
      when: { day: "mañana", from: "16:00" },
      stuckTurns: 0,
      failedTurns: 0,
    });
  });

  it("clears a field when the patch sets it to null", async () => {
    await upsertDraft("org1", "cv1", { staffChoice: null, when: null }, db);
    const d = await getDraft("org1", "cv1", db);
    expect(d?.serviceId).toBe("sv1");
    expect(d?.staffChoice).toBeNull();
    expect(d?.when).toBeNull();
  });

  it("is scoped by organization", async () => {
    expect(await getDraft("org2", "cv1", db)).toBeNull();
    await clearDraft("org2", "cv1", db);
    expect(await getDraft("org1", "cv1", db)).not.toBeNull();
  });

  it("ignores and deletes a draft idle for more than 24 h", async () => {
    await eph.run(
      `UPDATE booking_draft SET updated_at = now() - interval '25 hours' WHERE conversation_id = 'cv1'`
    );
    expect(await getDraft("org1", "cv1", db)).toBeNull();
    const rows = await eph.run(`SELECT 1 FROM booking_draft WHERE conversation_id = 'cv1'`);
    expect(rows.length).toBe(0);
  });

  it("starts from scratch when upserting over an expired draft", async () => {
    await upsertDraft("org1", "cv1", { serviceId: "sv1", stuckTurns: 2 }, db);
    await eph.run(
      `UPDATE booking_draft SET updated_at = now() - interval '25 hours' WHERE conversation_id = 'cv1'`
    );
    await upsertDraft("org1", "cv1", { staffChoice: "any" }, db);
    const d = await getDraft("org1", "cv1", db);
    expect(d?.serviceId).toBeNull();
    expect(d?.stuckTurns).toBe(0);
    expect(d?.staffChoice).toBe("any");
  });

  it("clearDraft removes it", async () => {
    await clearDraft("org1", "cv1", db);
    expect(await getDraft("org1", "cv1", db)).toBeNull();
  });

  it("migration 0015 is re-runnable", async () => {
    await eph.applyOne("0015_barber_bot_draft");
    const cols = await eph.run(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'calendar_settings' AND column_name LIKE 'location_%'
           OR column_name = 'arrival_lead_minutes'`
    );
    expect(cols.length).toBe(3);
  });

  it("rejects arrival_lead_minutes outside 0..120", async () => {
    await expect(
      eph.run(
        `INSERT INTO calendar_settings (id, organization_id, weekly_hours, arrival_lead_minutes)
           VALUES ('cal1', 'org1', '{}'::jsonb, 121)`
      )
    ).rejects.toThrow();
  });
});
