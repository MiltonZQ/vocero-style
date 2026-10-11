import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";
import { describeDb, openEphemeralDb, type EphemeralDb } from "./helpers/ephemeral-db";

/**
 * 020 — What the bot records in each turn, against a real database. Only the
 * model and the connector layer are replaced; the stub validates every
 * scripted answer with the REAL action schema and returns provider metadata
 * (model, usage) like the real adapter.
 */

const h = vi.hoisted(() => ({
  db: null as unknown,
  queue: [] as unknown[],
  bindConnector: vi.fn(),
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  return { ...original, getDb: () => h.db };
});
vi.mock("@/lib/ai", () => ({
  chatJson: async (schemaArg: { safeParse: (v: unknown) => { success: boolean; data?: unknown } }) => {
    const next = h.queue.shift();
    const meta = {
      model: "mock/model",
      latencyMs: 12,
      usage: { costUsd: 0.0025, promptTokens: 300, completionTokens: 40 },
    };
    if (next === "FAIL" || next === undefined) {
      return { ok: false, error: "invalid_output", detail: "scripted failure", ...meta };
    }
    const parsed = schemaArg.safeParse(next);
    if (!parsed.success) return { ok: false, error: "invalid_output", detail: "schema", ...meta };
    return { ok: true, data: parsed.data, raw: "", ...meta };
  },
}));
vi.mock("@/server/agenda/connectors", () => ({
  bindConnector: h.bindConnector,
  markConnectorAuthError: async () => {},
}));
vi.mock("@/server/events/bus", () => ({ publish: () => {} }));

const NOW = new Date("2026-10-11T16:00:00Z"); // Sunday 10:00 in Mexico City
const HOURS = '[{"start":"10:00","end":"20:00"}]';

let eph: EphemeralDb;
let runAgentTurn: (conversationId: string) => Promise<void>;
let seq = 0;

beforeAll(async () => {
  process.env.OPENROUTER_API_TOKEN = "test-token";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  eph = await openEphemeralDb();
  await eph.applyMigrations();
  h.db = drizzle(eph.sql, { schema });
  await eph.run(`
    INSERT INTO organization (id, name, slug) VALUES ('org1', 'Style', 'style');
    INSERT INTO contact (id, organization_id, name, wa_identity, phone) VALUES
      ('ct1', 'org1', 'Uno', '5215500000001', '5215500000001'),
      ('ct2', 'org1', 'Dos', '5215500000002', '5215500000002');
    INSERT INTO conversation (id, organization_id, contact_id, is_test, last_inbound_at)
      VALUES ('cv1', 'org1', 'ct1', true, now());
    INSERT INTO conversation (id, organization_id, contact_id, is_test, last_inbound_at)
      VALUES ('cv_old', 'org1', 'ct2', false, now() - interval '3 days');
    INSERT INTO agent_profile (id, organization_id, enabled, name)
      VALUES ('ap1', 'org1', true, 'Style Bot');
    INSERT INTO calendar_settings (id, organization_id, weekly_hours, slot_minutes, buffer_minutes,
        min_notice_hours, max_days_ahead, timezone, location_address, location_maps_url,
        arrival_lead_minutes)
      VALUES ('cs1', 'org1',
        '{"mon":${HOURS},"tue":${HOURS},"wed":${HOURS},"thu":${HOURS},"fri":${HOURS},"sat":${HOURS}}',
        30, 0, 2, 7, 'America/Mexico_City', 'Av. Juárez 123, Col. Centro', 'https://maps.example/style', 5);
    INSERT INTO service (id, organization_id, name, duration_minutes, price_cents, position) VALUES
      ('sv_fade', 'org1', 'Fade', 45, 25000, 1),
      ('sv_cejas', 'org1', 'Cejas', 15, 8000, 2),
      ('sv_mascarilla', 'org1', 'Mascarilla', 60, 30000, 3);
    INSERT INTO staff (id, organization_id, display_name, position) VALUES
      ('st_charly', 'org1', 'Charly', 1), ('st_luis', 'org1', 'Luis', 2), ('st_ana', 'org1', 'Ana', 3);
    INSERT INTO staff_service (staff_id, service_id, organization_id) VALUES
      ('st_charly', 'sv_fade', 'org1'), ('st_luis', 'sv_fade', 'org1'), ('st_ana', 'sv_cejas', 'org1');
  `);
  ({ runAgentTurn } = await import("@/server/ai/pipeline"));
});

afterAll(async () => {
  vi.useRealTimers();
  await eph.dropAll();
});

beforeEach(async () => {
  process.env.AGENDA = "on";
  h.queue.length = 0;
  await eph.run(`
    DELETE FROM bot_event; DELETE FROM booking; DELETE FROM booking_draft; DELETE FROM offered_slot;
    DELETE FROM message;
    UPDATE conversation SET handoff_at = NULL, handoff_reason = NULL;
    UPDATE calendar_settings SET latitude = NULL, longitude = NULL;
  `);
});

afterEach(() => {
  delete process.env.AGENDA;
  vi.restoreAllMocks();
});

async function turn(text: string, action: unknown, conversationId = "cv1"): Promise<void> {
  seq += 1;
  await eph.run(`
    INSERT INTO message (id, organization_id, conversation_id, direction, type, text, status, created_at)
    VALUES ('in_${seq}', 'org1', '${conversationId}', 'in', 'text', '${text.replaceAll("'", "''")}', 'delivered',
            now() + interval '${seq} seconds')
  `);
  h.queue.push(action);
  await runAgentTurn(conversationId);
}

async function events(conversationId = "cv1") {
  return eph.run(
    `SELECT type, payload, is_test FROM bot_event WHERE conversation_id = '${conversationId}'
     ORDER BY created_at, id`
  );
}
const types = async (conversationId = "cv1") => (await events(conversationId)).map((e) => e.type);

describeDb("bot events recorded per turn (agenda on)", () => {
  it("a full booking produces the funnel in order, one turn_completed per model turn", async () => {
    await turn("hola", { action: "greeting" });
    expect(await types()).toEqual(["greeted", "turn_completed"]);

    await eph.run(`DELETE FROM bot_event`);
    await turn("un fade", { action: "update_draft", service: "Fade" });
    expect(await types()).toEqual(["service_selected", "turn_completed"]);

    await eph.run(`DELETE FROM bot_event`);
    await turn("con charly", { action: "update_draft", staff: "Charly" });
    expect(await types()).toEqual(["staff_selected", "slots_offered", "turn_completed"]);

    await eph.run(`DELETE FROM bot_event`);
    await turn("la primera", { action: "book_slot", option: 1 });
    expect(await types()).toEqual(["booked", "turn_completed"]);

    const [booked] = (await events()).filter((e) => e.type === "booked");
    const [booking] = await eph.run(`SELECT id FROM booking`);
    expect(booked?.payload).toEqual({
      bookingId: booking?.id,
      serviceId: "sv_fade",
      staffId: "st_charly",
      priceCents: 25000,
      currency: "MXN",
    });
  });

  it("records the payloads of the funnel steps", async () => {
    await turn("fade con charly", {
      action: "update_draft",
      service: "Fade",
      staff: "Charly",
      when: { day: "mañana", from: "14:00", to: "19:00" },
    });
    const all = await events();
    expect(all.map((e) => e.type)).toEqual([
      "service_selected",
      "staff_selected",
      "slots_offered",
      "turn_completed",
    ]);
    expect(all[0]?.payload).toEqual({ serviceId: "sv_fade" });
    expect(all[1]?.payload).toEqual({ staffId: "st_charly", auto: false });
    expect(all[2]?.payload).toMatchObject({
      serviceId: "sv_fade",
      staffChoice: "st_charly",
      day: "mañana",
      from: "14:00",
      to: "19:00",
      fallback: "none",
    });
    expect((all[2]?.payload as { count: number }).count).toBeGreaterThan(0);
    expect(all[3]?.payload).toMatchObject({
      action: "update_draft",
      model: "mock/model",
      costUsd: 0.0025,
      promptTokens: 300,
      completionTokens: 40,
    });
    expect(typeof (all[3]?.payload as { latencyMs: number }).latencyMs).toBe("number");
  });

  it("any staff is recorded as 'any'; a lone barber is auto-selected", async () => {
    await turn("fade", { action: "update_draft", service: "Fade", staff: "any" });
    expect((await events()).find((e) => e.type === "staff_selected")?.payload).toEqual({
      staffId: "any",
      auto: false,
    });
    await eph.run(`DELETE FROM bot_event; DELETE FROM booking_draft`);
    await turn("cejas", { action: "update_draft", service: "Cejas" });
    expect((await events()).find((e) => e.type === "staff_selected")?.payload).toEqual({
      staffId: "st_ana",
      auto: true,
    });
  });

  it("unknown and unassigned services", async () => {
    await turn("tinte", { action: "update_draft", service: "tinte" });
    expect((await events()).find((e) => e.type === "service_not_found")?.payload).toEqual({
      text: "tinte",
    });
    await eph.run(`DELETE FROM bot_event`);
    await turn("mascarilla", { action: "update_draft", service: "Mascarilla" });
    expect((await events()).find((e) => e.type === "service_unavailable")?.payload).toEqual({
      serviceId: "sv_mascarilla",
    });
  });

  it("service_not_found text is cut to 60 characters", async () => {
    await turn("x", { action: "update_draft", service: "z".repeat(120) });
    const row = (await events()).find((e) => e.type === "service_not_found");
    expect((row?.payload as { text: string }).text).toHaveLength(60);
  });

  it("an empty day records no_availability before the nearest fallback", async () => {
    await turn("fade con luis el domingo", {
      action: "update_draft",
      service: "Fade",
      staff: "Luis",
      when: { day: "2026-10-18" },
    });
    expect(await types()).toEqual([
      "service_selected",
      "staff_selected",
      "no_availability",
      "slots_offered",
      "turn_completed",
    ]);
    const all = await events();
    expect(all.find((e) => e.type === "no_availability")?.payload).toMatchObject({
      serviceId: "sv_fade",
      staffChoice: "st_luis",
      day: "2026-10-18",
    });
    expect(all.find((e) => e.type === "slots_offered")?.payload).toMatchObject({ fallback: "nearest" });
  });

  it("'hoy' with nothing today is flagged today_empty", async () => {
    await turn("algo para hoy", {
      action: "update_draft",
      service: "Fade",
      staff: "any",
      when: { day: "hoy" },
    });
    expect(await types()).toContain("no_availability");
    expect((await events()).find((e) => e.type === "slots_offered")?.payload).toMatchObject({
      fallback: "today_empty",
    });
  });

  it("services_listed, my_bookings and location_sent", async () => {
    await turn("qué hacen", { action: "list_services" });
    expect(await types()).toEqual(["services_listed", "turn_completed"]);
    await eph.run(`DELETE FROM bot_event`);
    await turn("mis citas", { action: "my_bookings" });
    expect(await types()).toEqual(["my_bookings", "turn_completed"]);
    await eph.run(`DELETE FROM bot_event`);
    await turn("dónde están", { action: "send_location" });
    expect((await events()).find((e) => e.type === "location_sent")?.payload).toEqual({ pin: false });
    await eph.run(`
      DELETE FROM bot_event;
      UPDATE calendar_settings SET latitude = 19.43, longitude = -99.13
    `);
    await turn("dónde están", { action: "send_location" });
    expect((await events()).find((e) => e.type === "location_sent")?.payload).toEqual({ pin: true });
  });

  it("is_test is copied from the conversation", async () => {
    await turn("hola", { action: "greeting" });
    expect((await events()).every((e) => e.is_test === true)).toBe(true);
  });

  it("payloads carry no message text, names or phones", async () => {
    await turn("quiero un fade con charly por favor", {
      action: "update_draft",
      service: "Fade",
      staff: "Charly",
    });
    await turn("la primera opción, gracias", { action: "book_slot", option: 1 });
    const dump = JSON.stringify((await events()).map((e) => e.payload));
    expect(dump).not.toContain("por favor");
    expect(dump).not.toContain("gracias");
    expect(dump).not.toContain("Charly");
    expect(dump).not.toContain("5215500000001");
  });

  it("a failing event insert changes nothing about the reply or the booking", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await eph.run(`ALTER TABLE bot_event RENAME TO bot_event_off`);
    try {
      await turn("fade con charly", { action: "update_draft", service: "Fade", staff: "Charly" });
      await turn("la primera", { action: "book_slot", option: 1 });
      expect(await eph.run(`SELECT 1 FROM booking`)).toHaveLength(1);
      const out = await eph.run(`SELECT text FROM message WHERE direction = 'out'`);
      expect(out).toHaveLength(2);
    } finally {
      await eph.run(`ALTER TABLE bot_event_off RENAME TO bot_event`);
    }
  });
});

describeDb("handoff and model failure events", () => {
  it("records the model's reason, or 'modelo' for an unknown one", async () => {
    await turn("cancelar", { action: "handoff", reason: "cancelacion", farewell: "Te paso." });
    const all = await events();
    expect(all.map((e) => e.type)).toEqual(["handoff", "turn_completed"]);
    expect(all[0]?.payload).toEqual({ reason: "cancelacion" });

    await eph.run(`DELETE FROM bot_event; UPDATE conversation SET handoff_at = NULL`);
    await turn("ayuda", { action: "handoff", reason: "porque sí" });
    expect((await events())[0]?.payload).toEqual({ reason: "modelo" });
  });

  it("the regex backup records 'cliente' without calling the model", async () => {
    await turn("quiero hablar con un humano", { action: "none" });
    expect(await types()).toEqual(["handoff"]);
    expect((await events())[0]?.payload).toEqual({ reason: "cliente" });
  });

  it("a closed 24h window records 'ventana'", async () => {
    await turn("hola", { action: "none" }, "cv_old");
    expect(await types("cv_old")).toEqual(["handoff"]);
    expect((await events("cv_old"))[0]).toMatchObject({ payload: { reason: "ventana" }, is_test: false });
  });

  it("stuck turns record 'atascado'", async () => {
    for (let i = 0; i < 3; i++) await turn("la primera", { action: "book_slot", option: 1 });
    const handoffs = (await events()).filter((e) => e.type === "handoff");
    expect(handoffs.map((e) => e.payload)).toEqual([{ reason: "atascado" }]);
  });

  it("a model failure records llm_failed with the consecutive count, then handoff 'error'", async () => {
    await turn("hola", "FAIL");
    expect(await types()).toEqual(["llm_failed"]);
    expect((await events())[0]?.payload).toEqual({ consecutive: 1 });
    await eph.run(`DELETE FROM bot_event`);
    await turn("hola?", "FAIL");
    const all = await events();
    expect(all.map((e) => e.type)).toEqual(["llm_failed", "handoff"]);
    expect(all[0]?.payload).toEqual({ consecutive: 2 });
    expect(all[1]?.payload).toEqual({ reason: "error" });
  });
});

describeDb("flag off: only the generic events", () => {
  it("a plain reply records turn_completed only", async () => {
    delete process.env.AGENDA;
    await turn("hola", { action: "reply", text: "Hola" });
    expect(await types()).toEqual(["turn_completed"]);
    expect((await events())[0]?.payload).toMatchObject({ action: "reply", model: "mock/model" });
  });

  it("an agenda-looking action is degraded and emits no agenda event", async () => {
    delete process.env.AGENDA;
    await turn("fade", { action: "update_draft", service: "Fade" });
    expect((await types()).filter((t) => !["llm_failed", "handoff", "turn_completed"].includes(t))).toEqual([]);
  });

  it("model handoff and failure keep the generic events", async () => {
    delete process.env.AGENDA;
    await turn("ayuda", { action: "handoff", reason: "cancelacion" });
    expect(await types()).toEqual(["handoff", "turn_completed"]);
    expect((await events())[0]?.payload).toEqual({ reason: "modelo" });
    await eph.run(`DELETE FROM bot_event; UPDATE conversation SET handoff_at = NULL`);
    await turn("hola", "FAIL");
    expect(await types()).toEqual(["llm_failed", "handoff"]);
    expect((await events())[0]?.payload).toEqual({ consecutive: 1 });
  });
});
