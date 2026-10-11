import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";
import { describeDb, openEphemeralDb, type EphemeralDb } from "./helpers/ephemeral-db";

/**
 * 019 — After a booking the bot sends the confirmation text and then the shop
 * location as a WhatsApp pin. Real database; the model and the WhatsApp
 * sender are replaced (the sender's own sandbox/window guards are covered by
 * send-location.test.ts).
 */

const h = vi.hoisted(() => ({
  db: null as unknown,
  queue: [] as unknown[],
  sendText: vi.fn(),
  sendStructured: vi.fn(),
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  return { ...original, getDb: () => h.db };
});
vi.mock("@/lib/ai", () => ({
  chatJson: async (
    schemaArg: { safeParse: (v: unknown) => { success: boolean; data?: unknown } }
  ) => {
    const next = h.queue.shift();
    const parsed = schemaArg.safeParse(next);
    if (!parsed.success) return { ok: false, error: "invalid_output", detail: "schema" };
    return { ok: true, data: parsed.data, raw: "" };
  },
}));
vi.mock("@/server/agenda/connectors", () => ({
  bindConnector: vi.fn(),
  markConnectorAuthError: async () => {},
}));
vi.mock("@/server/events/bus", () => ({ publish: () => {} }));
vi.mock("@/server/inbox/send", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/inbox/send")>();
  return { ...original, sendText: h.sendText, sendStructured: h.sendStructured };
});

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
      ('ct_real', 'org1', 'Real', '5215500000001', '5215500000001'),
      ('ct_test', 'org1', 'Prueba', '5215500000002', '5215500000002');
    INSERT INTO conversation (id, organization_id, contact_id, is_test, last_inbound_at) VALUES
      ('cv_real', 'org1', 'ct_real', false, now()),
      ('cv_test', 'org1', 'ct_test', true, now());
    INSERT INTO agent_profile (id, organization_id, enabled, name) VALUES ('ap1', 'org1', true, 'Style Bot');
    INSERT INTO calendar_settings (id, organization_id, weekly_hours, slot_minutes, buffer_minutes,
        min_notice_hours, max_days_ahead, timezone, location_address, location_maps_url,
        arrival_lead_minutes, latitude, longitude)
      VALUES ('cs1', 'org1',
        '{"mon":${HOURS},"tue":${HOURS}}',
        30, 0, 2, 7, 'America/Mexico_City', 'Av. Juárez 123, Col. Centro', 'https://maps.example/style', 5,
        4.598865027392155, -74.1632885539481);
    INSERT INTO service (id, organization_id, name, duration_minutes, price_cents, position)
      VALUES ('sv_fade', 'org1', 'Fade', 45, 25000, 1);
    INSERT INTO staff (id, organization_id, display_name, position) VALUES ('st_charly', 'org1', 'Charly', 1);
    INSERT INTO staff_service (staff_id, service_id, organization_id) VALUES ('st_charly', 'sv_fade', 'org1');
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
  h.sendText.mockReset();
  h.sendStructured.mockReset();
  h.sendText.mockResolvedValue({ messageId: "m1" });
  h.sendStructured.mockResolvedValue({ messageId: "m2" });
  await eph.run(`
    DELETE FROM booking; DELETE FROM booking_draft; DELETE FROM offered_slot; DELETE FROM message;
    UPDATE calendar_settings SET latitude = 4.598865027392155, longitude = -74.1632885539481;
  `);
});

async function say(conversationId: string, text: string, action: unknown) {
  seq += 1;
  await eph.run(`
    INSERT INTO message (id, organization_id, conversation_id, direction, type, text, status, wa_message_id, created_at)
    VALUES ('in_${seq}', 'org1', '${conversationId}', 'in', 'text', '${text}', 'delivered', 'wamid.IN${seq}',
            now() + interval '${seq} seconds')
  `);
  h.queue.push(action);
  await runAgentTurn(conversationId);
}

/** Drives a real conversation up to the booking turn. */
async function book(conversationId: string) {
  await say(conversationId, "fade con charly mañana", {
    action: "update_draft",
    service: "Fade",
    staff: "Charly",
    when: { day: "mañana", from: "14:00", to: "19:00" },
  });
  await say(conversationId, "el primero", { action: "book_slot", option: 1 });
}

describeDb("location pin after a booking (real DB)", () => {
  it("sends the confirmation text first and then the pin", async () => {
    await book("cv_real");
    expect(h.sendText).toHaveBeenCalledTimes(2); // the offers, then the confirmation
    expect(h.sendStructured).toHaveBeenCalledTimes(1);
    expect(h.sendStructured).toHaveBeenCalledWith({
      conversationId: "cv_real",
      organizationId: "org1",
      kind: "location",
      aiGenerated: true,
      location: {
        latitude: 4.598865027392155,
        longitude: -74.1632885539481,
        name: "Style",
        address: "Av. Juárez 123, Col. Centro",
      },
    });
    const confirmationOrder = h.sendText.mock.invocationCallOrder[1]!;
    expect(confirmationOrder).toBeLessThan(h.sendStructured.mock.invocationCallOrder[0]!);
  });

  it("drops the Maps link from the text when the pin goes out, keeps the address", async () => {
    await book("cv_real");
    const text = String(h.sendText.mock.calls[1]?.[0]?.text);
    expect(text).toContain("¡Listo, tu cita quedó agendada!");
    expect(text).toContain("📍 Av. Juárez 123, Col. Centro");
    expect(text).not.toContain("maps.example");
  });

  it("without coordinates there is no pin and the Maps link stays in the text", async () => {
    await eph.run(`UPDATE calendar_settings SET latitude = NULL, longitude = NULL`);
    await book("cv_real");
    expect(h.sendStructured).not.toHaveBeenCalled();
    expect(String(h.sendText.mock.calls[1]?.[0]?.text)).toContain("https://maps.example/style");
  });

  it("without stored coordinates, falls back to parsing the maps URL at booking time", async () => {
    await eph.run(
      `UPDATE calendar_settings SET latitude = NULL, longitude = NULL,
         location_maps_url = 'https://www.google.com/maps/@4.5988,-74.1632,17z'`
    );
    await book("cv_real");
    expect(h.sendStructured).toHaveBeenCalledTimes(1);
    expect(h.sendStructured.mock.calls[0]?.[0]?.location).toMatchObject({
      latitude: 4.5988,
      longitude: -74.1632,
      name: "Style",
    });
    await eph.run(`UPDATE calendar_settings SET location_maps_url = 'https://maps.example/style'`);
  });

  it("warns (no PII) when a booking is confirmed and there are no coordinates at all", async () => {
    await eph.run(`UPDATE calendar_settings SET latitude = NULL, longitude = NULL`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await book("cv_real");
    expect(warn).toHaveBeenCalledWith(
      "[agenda] cita confirmada sin coordenadas: no se envía el pin (org=org1)"
    );
    warn.mockRestore();
  });

  it("logs the error message of a failing pin, never the token", async () => {
    const { SendError } = await import("@/server/inbox/send");
    h.sendStructured.mockRejectedValue(new SendError("meta_error", "Meta rechazó la ubicación"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await book("cv_real");
    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes("pin"));
    expect(line).toContain("Meta rechazó la ubicación");
    warn.mockRestore();
  });

  it("a failing pin never fails the booking or the confirmation", async () => {
    const { SendError } = await import("@/server/inbox/send");
    h.sendStructured.mockRejectedValue(new SendError("meta_error", "Meta rechazó la ubicación"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await book("cv_real");
    expect(await eph.run(`SELECT 1 FROM booking WHERE contact_id = 'ct_real'`)).toHaveLength(1);
    expect(h.sendText).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    // The text keeps the address; the booking is in place.
    const [d] = await eph.run(`SELECT 1 FROM booking_draft WHERE conversation_id = 'cv_real'`);
    expect(d).toBeUndefined();
  });

  it("a Laboratorio conversation never calls the sender; the pin is only stored", async () => {
    await book("cv_test");
    expect(h.sendText).not.toHaveBeenCalled();
    expect(h.sendStructured).not.toHaveBeenCalled();
    const rows = await eph.run(
      `SELECT type, direction, origin, text FROM message WHERE conversation_id = 'cv_test' AND direction = 'out' ORDER BY created_at, id`
    );
    expect(rows.map((r) => r.type)).toEqual(["text", "text", "location"]);
    expect(rows[2]).toMatchObject({ origin: "ai", text: null });
  });
});
