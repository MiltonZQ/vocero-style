import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";
import { describeDb, openEphemeralDb, type EphemeralDb } from "./helpers/ephemeral-db";

/**
 * 019 — The in-process agent shows "typing…" (and marks the message read)
 * while it works, and understands voice notes. Real database; the model, the
 * WhatsApp sender, Meta's Graph API and Whisper are replaced.
 */

const h = vi.hoisted(() => ({
  db: null as unknown,
  queue: [] as unknown[],
  calls: [] as Array<Array<{ role: string; content: string }>>,
  chat: vi.fn(),
  sendText: vi.fn(),
  graph: vi.fn(),
  creds: vi.fn(),
  transcribe: vi.fn(),
  readMedia: vi.fn(),
}));

vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  return { ...original, getDb: () => h.db };
});
vi.mock("@/lib/ai", () => ({
  chatJson: async (
    schemaArg: { safeParse: (v: unknown) => { success: boolean; data?: unknown } },
    messages: Array<{ role: string; content: string }>
  ) => {
    h.chat();
    h.calls.push(messages);
    const parsed = schemaArg.safeParse(h.queue.shift());
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
  return { ...original, sendText: h.sendText, sendStructured: vi.fn() };
});
vi.mock("@/lib/meta/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/meta/client")>();
  return { ...original, graphRequest: h.graph };
});
vi.mock("@/server/whatsapp/credentials", () => ({ getCredentialsByOrg: h.creds }));
vi.mock("@/server/ai/transcribe", () => ({ transcribeAudio: h.transcribe }));
vi.mock("@/server/whatsapp/media", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/whatsapp/media")>();
  return { ...original, readMediaFile: h.readMedia };
});

const NOW = new Date("2026-10-11T16:00:00Z"); // Sunday 10:00 in Mexico City
const HOURS = '[{"start":"10:00","end":"20:00"}]';
const TYPING = {
  messaging_product: "whatsapp",
  status: "read",
  typing_indicator: { type: "text" },
};

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
        min_notice_hours, max_days_ahead, timezone)
      VALUES ('cs1', 'org1', '{"mon":${HOURS},"tue":${HOURS}}', 30, 0, 2, 7, 'America/Mexico_City');
    INSERT INTO service (id, organization_id, name, duration_minutes, price_cents, position)
      VALUES ('sv_fade', 'org1', 'Fade', 45, 25000, 1);
    INSERT INTO staff (id, organization_id, display_name, position) VALUES ('st_charly', 'org1', 'Charly', 1);
    INSERT INTO staff_service (staff_id, service_id, organization_id) VALUES ('st_charly', 'sv_fade', 'org1');
    INSERT INTO media_asset (id, organization_id, kind, mime_type, storage_path, fetch_status)
      VALUES ('ma_voice', 'org1', 'audio', 'audio/ogg', 'org1/ma_voice', 'available');
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
  h.calls.length = 0;
  for (const fn of [h.chat, h.sendText, h.graph, h.creds, h.transcribe, h.readMedia]) fn.mockReset();
  h.sendText.mockResolvedValue({ messageId: "m1" });
  h.graph.mockResolvedValue({ success: true });
  h.creds.mockResolvedValue({ phoneNumberId: "pn1", token: "tok" });
  h.readMedia.mockResolvedValue(Buffer.from("ogg"));
  await eph.run(`
    DELETE FROM booking; DELETE FROM booking_draft; DELETE FROM offered_slot; DELETE FROM message;
    UPDATE conversation SET handoff_at = NULL, handoff_reason = NULL, ai_enabled = true,
      last_inbound_at = now() WHERE id IN ('cv_real', 'cv_test');
  `);
});

async function inbound(
  conversationId: string,
  opts: { text?: string; waId?: string | null; audio?: boolean } = {}
) {
  seq += 1;
  const wa = opts.waId === undefined ? `wamid.IN${seq}` : opts.waId;
  await eph.run(`
    INSERT INTO message (id, organization_id, conversation_id, direction, type, text, status,
        wa_message_id, media_asset_id, created_at)
    VALUES ('in_${seq}', 'org1', '${conversationId}', 'in', '${opts.audio ? "audio" : "text"}',
        ${opts.text ? `'${opts.text.replaceAll("'", "''")}'` : "NULL"}, 'delivered',
        ${wa ? `'${wa}'` : "NULL"}, ${opts.audio ? "'ma_voice'" : "NULL"}, now() + interval '${seq} seconds')
  `);
  return wa;
}

const typingBody = (id: string | null) => ({ ...TYPING, message_id: id });

describeDb("typing indicator in the in-process agent (real DB)", () => {
  it("marks the latest inbound message read and shows typing BEFORE the model runs", async () => {
    const wamid = await inbound("cv_real", { text: "hola" });
    h.queue.push({ action: "reply", text: "Hola" });
    await runAgentTurn("cv_real");

    expect(h.graph).toHaveBeenCalledTimes(1);
    expect(h.graph).toHaveBeenCalledWith("pn1/messages", {
      method: "POST",
      token: "tok",
      body: typingBody(wamid),
    });
    expect(h.graph.mock.invocationCallOrder[0]).toBeLessThan(h.chat.mock.invocationCallOrder[0]!);
    expect(h.sendText).toHaveBeenCalledTimes(1);
  });

  it("uses the newest inbound message", async () => {
    await inbound("cv_real", { text: "uno" });
    const latest = await inbound("cv_real", { text: "dos" });
    h.queue.push({ action: "reply", text: "Hola" });
    await runAgentTurn("cv_real");
    expect(h.graph.mock.calls[0]?.[1].body.message_id).toBe(latest);
  });

  it("never for a Laboratorio conversation", async () => {
    await inbound("cv_test", { text: "hola" });
    h.queue.push({ action: "reply", text: "Hola" });
    await runAgentTurn("cv_test");
    expect(h.graph).not.toHaveBeenCalled();
    expect(h.creds).not.toHaveBeenCalled();
    expect(h.chat).toHaveBeenCalledTimes(1);
  });

  it("not while a person has the conversation (handoff) or the AI is off", async () => {
    await inbound("cv_real", { text: "hola" });
    await eph.run(`UPDATE conversation SET handoff_at = now() WHERE id = 'cv_real'`);
    await runAgentTurn("cv_real");
    await eph.run(`UPDATE conversation SET handoff_at = NULL, ai_enabled = false WHERE id = 'cv_real'`);
    await runAgentTurn("cv_real");
    expect(h.graph).not.toHaveBeenCalled();
    expect(h.chat).not.toHaveBeenCalled();
  });

  it("not when the 24 h window is closed (the turn becomes a handoff)", async () => {
    await inbound("cv_real", { text: "hola" });
    await eph.run(`UPDATE conversation SET last_inbound_at = now() - interval '30 hours' WHERE id = 'cv_real'`);
    await runAgentTurn("cv_real");
    expect(h.graph).not.toHaveBeenCalled();
    const [row] = await eph.run(`SELECT handoff_reason FROM conversation WHERE id = 'cv_real'`);
    expect(row?.handoff_reason).toBe("ventana");
  });

  it("not when there is no inbound WhatsApp message id; the turn still answers", async () => {
    await inbound("cv_real", { text: "hola", waId: null });
    h.queue.push({ action: "reply", text: "Hola" });
    await runAgentTurn("cv_real");
    expect(h.graph).not.toHaveBeenCalled();
    expect(h.sendText).toHaveBeenCalledTimes(1);
  });

  it("a Meta failure is logged and the turn goes on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.graph.mockRejectedValue(new Error("meta down"));
    await inbound("cv_real", { text: "hola" });
    h.queue.push({ action: "reply", text: "Hola" });
    await runAgentTurn("cv_real");
    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("no WhatsApp connection is just skipped", async () => {
    h.creds.mockResolvedValue(null);
    await inbound("cv_real", { text: "hola" });
    h.queue.push({ action: "reply", text: "Hola" });
    await runAgentTurn("cv_real");
    expect(h.graph).not.toHaveBeenCalled();
    expect(h.sendText).toHaveBeenCalledTimes(1);
  });
});

describeDb("voice notes (Whisper) in the in-process agent (real DB)", () => {
  it("a transcribed voice note drives update_draft exactly like typed text", async () => {
    h.transcribe.mockResolvedValue("quiero un fade con charly mañana en la tarde");
    await inbound("cv_real", { audio: true });
    h.queue.push({
      action: "update_draft",
      service: "Fade",
      staff: "Charly",
      when: { day: "mañana", from: "14:00", to: "19:00" },
    });
    await runAgentTurn("cv_real");

    expect(h.transcribe).toHaveBeenCalledWith(Buffer.from("ogg"), "audio/ogg");
    // The model read the transcript as the client's last message.
    const last = (h.calls[0] ?? []).filter((m) => m.role === "user").at(-1)?.content;
    expect(last).toBe("[Nota de voz]: quiero un fade con charly mañana en la tarde");
    // The transcript is kept on the message.
    const [msg] = await eph.run(`SELECT text FROM message WHERE id LIKE 'in_%' AND type = 'audio'`);
    expect(msg?.text).toBe("[Nota de voz]: quiero un fade con charly mañana en la tarde");
    // And the booking flow moved: draft saved, slots offered in natural language.
    const [draft] = await eph.run(`SELECT service_id, staff_choice FROM booking_draft WHERE conversation_id = 'cv_real'`);
    expect(draft).toMatchObject({ service_id: "sv_fade", staff_choice: "st_charly" });
    expect(String(h.sendText.mock.calls[0]?.[0]?.text)).toContain(
      "Para mañana lunes 12 de octubre tenemos disponible a las 2:00 p. m."
    );
  });

  it("typing is shown before the voice note is transcribed", async () => {
    h.transcribe.mockResolvedValue("hola");
    await inbound("cv_real", { audio: true });
    h.queue.push({ action: "greeting" });
    await runAgentTurn("cv_real");
    expect(h.graph.mock.invocationCallOrder[0]).toBeLessThan(h.transcribe.mock.invocationCallOrder[0]!);
  });

  it.each([
    ["Whisper returns nothing", () => h.transcribe.mockResolvedValue(null)],
    ["Whisper throws", () => h.transcribe.mockRejectedValue(new Error("whisper down"))],
    ["the audio file is gone", () => h.readMedia.mockRejectedValue(new Error("ENOENT"))],
  ])("when %s the bot asks the client to write, without crashing or escalating", async (_name, arrange) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    arrange();
    await inbound("cv_real", { audio: true });
    await expect(runAgentTurn("cv_real")).resolves.toBeUndefined();
    warn.mockRestore();

    expect(h.chat).not.toHaveBeenCalled();
    expect(h.sendText).toHaveBeenCalledTimes(1);
    expect(h.sendText.mock.calls[0]?.[0]?.text).toBe(
      "No pude escuchar bien tu nota de voz. ¿Podrías escribirme lo que necesitas?"
    );
    const [row] = await eph.run(`SELECT handoff_at FROM conversation WHERE id = 'cv_real'`);
    expect(row?.handoff_at).toBeNull();
  });
});
