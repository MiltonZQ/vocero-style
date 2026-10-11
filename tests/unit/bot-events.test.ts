import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";
import { describeDb, openEphemeralDb, type EphemeralDb } from "./helpers/ephemeral-db";

/**
 * 020 — The bot event recorder against a real database: scoping, best-effort
 * writes, truncation, the `is_test` copy and per-turn ordering.
 */

const h = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  return { ...original, getDb: () => h.db };
});

let eph: EphemeralDb;
let events: typeof import("@/server/events/bot-events");

const CTX = { organizationId: "org1", conversationId: "cv1", contactId: "ct1", isTest: false };

describeDb("bot event recorder", () => {
  beforeAll(async () => {
    eph = await openEphemeralDb();
    await eph.applyMigrations();
    h.db = drizzle(eph.sql, { schema });
    await eph.run(`
      INSERT INTO organization (id, name, slug) VALUES ('org1', 'Uno', 'uno'), ('org2', 'Dos', 'dos');
      INSERT INTO contact (id, organization_id, name, wa_identity) VALUES
        ('ct1', 'org1', 'A', '5215500000001'), ('ct2', 'org2', 'B', '5215500000002');
      INSERT INTO conversation (id, organization_id, contact_id, is_test) VALUES
        ('cv1', 'org1', 'ct1', false), ('cv2', 'org2', 'ct2', true);
    `);
    events = await import("@/server/events/bot-events");
  });

  afterAll(async () => {
    await eph.dropAll();
  });

  beforeEach(async () => {
    await eph.run(`DELETE FROM bot_event`);
    vi.restoreAllMocks();
  });

  it("stores the event with a be_ id, the org, the type and the payload", async () => {
    await events.recordBotEvent(CTX, { type: "service_selected", payload: { serviceId: "sv1" } });
    const rows = await eph.run(`SELECT * FROM bot_event`);
    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.id)).toMatch(/^be_/);
    expect(rows[0]).toMatchObject({
      organization_id: "org1",
      conversation_id: "cv1",
      contact_id: "ct1",
      type: "service_selected",
      payload: { serviceId: "sv1" },
      is_test: false,
    });
  });

  it("copies is_test from the conversation", async () => {
    const [conv] = await eph.run(`SELECT * FROM conversation WHERE id = 'cv2'`);
    const ctx = events.botEventContext({
      id: conv!.id,
      organizationId: conv!.organization_id,
      contactId: conv!.contact_id,
      isTest: conv!.is_test,
    });
    expect(ctx).toEqual({
      organizationId: "org2",
      conversationId: "cv2",
      contactId: "ct2",
      isTest: true,
    });
    await events.recordBotEvent(ctx, { type: "greeted", payload: {} });
    const rows = await eph.run(`SELECT is_test FROM bot_event`);
    expect(rows[0]?.is_test).toBe(true);
  });

  it("scoping: an org only reads its own events", async () => {
    await events.recordBotEvent(CTX, { type: "greeted", payload: {} });
    await events.recordBotEvent(
      { organizationId: "org2", conversationId: "cv2", contactId: "ct2", isTest: true },
      { type: "my_bookings", payload: {} }
    );
    const mine = await events.listBotEvents("org1");
    const theirs = await events.listBotEvents("org2");
    expect(mine.map((e) => e.type)).toEqual(["greeted"]);
    expect(theirs.map((e) => e.type)).toEqual(["my_bookings"]);
    expect(await events.listBotEvents("org1", { conversationId: "cv2" })).toEqual([]);
  });

  it("a context pairing an org with another org's conversation writes nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await events.recordBotEvent(
      { organizationId: "org1", conversationId: "cv2", contactId: "ct2", isTest: true },
      { type: "greeted", payload: {} }
    );
    expect(await eph.run(`SELECT 1 FROM bot_event`)).toHaveLength(0);
  });

  it("never throws when the insert fails and warns without the payload", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // conversation does not exist -> FK violation
    await expect(
      events.recordBotEvent(
        { ...CTX, conversationId: "missing" },
        { type: "service_not_found", payload: { text: "secret words" } }
      )
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0]!.map(String).join(" ");
    expect(line).toContain("[bot-event]");
    expect(line).toContain("service_not_found");
    expect(line).not.toContain("secret words");
    expect(await eph.run(`SELECT 1 FROM bot_event`)).toHaveLength(0);
  });

  it("truncates service_not_found.text to 60 characters", async () => {
    await events.recordBotEvent(CTX, {
      type: "service_not_found",
      payload: { text: "x".repeat(200) },
    });
    const rows = await eph.run(`SELECT payload FROM bot_event`);
    expect((rows[0]?.payload as { text: string }).text).toHaveLength(60);
  });

  it("a turn recorder writes the batch in order, turn_completed last", async () => {
    const rec = events.createTurnRecorder();
    rec.bind(CTX);
    rec.add({ type: "greeted", payload: {} });
    rec.add({ type: "services_listed", payload: {} });
    rec.add({ type: "handoff", payload: { reason: "cliente" } });
    rec.complete({ action: "greeting", model: "m/x", costUsd: 0.002, promptTokens: 10, completionTokens: 4 });
    await rec.flush(1234);
    const rows = await events.listBotEvents("org1", { conversationId: "cv1" });
    expect(rows.map((e) => e.type)).toEqual(["greeted", "services_listed", "handoff", "turn_completed"]);
    expect(rows[3]?.payload).toMatchObject({
      action: "greeting",
      latencyMs: 1234,
      model: "m/x",
      costUsd: 0.002,
      promptTokens: 10,
      completionTokens: 4,
    });
  });

  it("a turn recorder that never bound a conversation writes nothing and does not throw", async () => {
    const rec = events.createTurnRecorder();
    rec.add({ type: "greeted", payload: {} });
    await expect(rec.flush(5)).resolves.toBeUndefined();
    expect(await eph.run(`SELECT 1 FROM bot_event`)).toHaveLength(0);
  });
});
