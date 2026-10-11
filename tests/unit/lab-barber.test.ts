import { afterAll, beforeAll, beforeEach, expect, it, describe, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";
import { aiMockCompletion } from "@/server/dev/ai-mock";
import { buildDraftStateBlock } from "@/server/ai/prompts";
import { AGENDA_PERSONAS, HANDOFF_PERSONAS, judgeCase } from "@/server/lab/judge";
import { PERSONAS } from "@/server/lab/personas";
import { describeDb, openEphemeralDb, type EphemeralDb } from "./helpers/ephemeral-db";

/**
 * 019 — Lab barber personas: the scripted personas stay well-formed, the
 * deterministic ai-mock maps their lines to the real contract, and the
 * deterministic judge decides by the saved booking / handoff reason.
 */

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/db")>();
  return { ...original, getDb: () => h.db };
});

describe("barber personas", () => {
  it("have unique keys and phones, and only known markers", () => {
    expect(new Set(PERSONAS.map((p) => p.key)).size).toBe(PERSONAS.length);
    expect(new Set(PERSONAS.map((p) => p.phone)).size).toBe(PERSONAS.length);
    for (const persona of PERSONAS) {
      for (const line of persona.script) {
        for (const marker of line.matchAll(/\{\{(\w+)\}\}/g)) {
          expect(["service1", "service2", "staff1"]).toContain(marker[1]);
        }
      }
    }
  });

  it("cover the scenarios of the design", () => {
    const keys = PERSONAS.map((p) => p.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "saludo_catalogo",
        "agenda_todo_en_un_mensaje",
        "agenda_cualquiera_tarde",
        "agenda_tinte_no_ofrecido",
        "agenda_opcion_dos",
        "agenda_mi_cita",
        "handoff_cancelar",
        "handoff_reprogramar",
        "handoff_llegada_tarde",
        "direccion_faq",
        "handoff_pide_humano",
        "jerga_corte_barba",
        "fuera_de_kb",
      ])
    );
  });

  it("every booking and handoff persona is registered for a deterministic verdict", () => {
    for (const key of Object.keys(HANDOFF_PERSONAS)) {
      expect(PERSONAS.some((p) => p.key === key)).toBe(true);
    }
    for (const key of AGENDA_PERSONAS) {
      expect(PERSONAS.some((p) => p.key === key)).toBe(true);
    }
    for (const persona of PERSONAS.filter((p) => p.key.startsWith("agenda_"))) {
      expect(AGENDA_PERSONAS.has(persona.key)).toBe(true);
    }
  });
});

const SYSTEM = [
  "Catálogo de la agenda (usa estos nombres tal cual en update_draft):",
  "- Fade — 45 min — $250",
  "  - Charly",
  "  - Luis",
  "- Barba — 30 min — $150",
  "  - Luis",
].join("\n");

function mock(userText: string, opts: { options?: string[] } = {}) {
  const state = buildDraftStateBlock({
    now: new Date("2026-10-11T16:00:00Z"),
    timezone: "America/Mexico_City",
    step: opts.options ? "ready" : "need_service",
    serviceName: null,
    staffLabel: null,
    whenLabel: null,
    options: opts.options ?? [],
  });
  return JSON.parse(
    aiMockCompletion([
      { role: "system", content: SYSTEM },
      { role: "user", content: userText },
      { role: "system", content: state },
    ])
  );
}

describe("ai-mock drives the barber contract", () => {
  it("full request in one message", () => {
    expect(mock("Fade con Charly mañana a las 5")).toEqual({
      action: "update_draft",
      service: "Fade",
      staff: "Charly",
      when: { day: "mañana", from: "17:00" },
    });
  });

  it("anyone on a weekday afternoon", () => {
    expect(mock("Quiero Barba, me da igual quién, el viernes en la tarde")).toEqual({
      action: "update_draft",
      service: "Barba",
      staff: "any",
      when: { day: "viernes", from: "14:00", to: "19:00" },
    });
  });

  it("'en la mañana' is a time of day, not tomorrow", () => {
    expect(mock("Fade el lunes en la mañana")).toMatchObject({
      when: { day: "lunes", from: "10:00", to: "13:00" },
    });
  });

  it("a service that is not in the catalog goes in literally", () => {
    expect(mock("¿hacen tinte de cabello?")).toEqual({ action: "update_draft", service: "tinte" });
  });

  it("slang for a combo that is not in the catalog", () => {
    expect(mock("q onda bro, un corte y barba pa hoy en la noche")).toEqual({
      action: "update_draft",
      service: "corte y barba",
      when: { day: "hoy", from: "18:00", to: "20:00" },
    });
  });

  it("picks the numbered option", () => {
    const options = ["a", "b", "c"];
    expect(mock("la segunda opción", { options })).toEqual({ action: "book_slot", option: 2 });
    expect(mock("quiero el primero", { options })).toEqual({ action: "book_slot", option: 1 });
    expect(mock("la tercera", { options })).toEqual({ action: "book_slot", option: 3 });
  });

  it("does not pick an option when none is on offer", () => {
    expect(mock("la segunda opción").action).not.toBe("book_slot");
  });

  it("my_bookings, handoff reasons and FAQ", () => {
    expect(mock("¿a qué hora es mi cita?")).toEqual({ action: "my_bookings" });
    expect(mock("necesito cancelar mi cita del lunes")).toEqual({
      action: "handoff",
      reason: "cancelacion",
    });
    expect(mock("quiero reprogramar mi cita")).toEqual({
      action: "handoff",
      reason: "reprogramacion",
    });
    expect(mock("voy 10 minutos tarde a mi cita")).toEqual({ action: "handoff", reason: "llegada" });
    expect(mock("¿dónde están ubicados?").action).toBe("reply");
  });

  it("a plain greeting is a reply, 'tarde' as a time of day is not a late arrival", () => {
    expect(mock("hola buenas").action).toBe("reply");
    expect(mock("Fade el viernes en la tarde").action).toBe("update_draft");
  });
});

let eph: EphemeralDb;

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  eph = await openEphemeralDb();
  await eph.applyMigrations();
  h.db = drizzle(eph.sql, { schema });
  await eph.run(`
    INSERT INTO organization (id, name, slug) VALUES ('org1', 'Style', 'style');
    INSERT INTO contact (id, organization_id, name, wa_identity) VALUES ('ct1', 'org1', 'Uno', '5215500000001');
    INSERT INTO calendar_settings (id, organization_id, weekly_hours, slot_minutes, buffer_minutes,
        min_notice_hours, max_days_ahead, timezone, arrival_lead_minutes)
      VALUES ('cs1', 'org1', '{}', 30, 0, 2, 7, 'America/Mexico_City', 5);
    INSERT INTO service (id, organization_id, name, duration_minutes, price_cents, position)
      VALUES ('sv_fade', 'org1', 'Fade', 45, 25000, 1);
    INSERT INTO staff (id, organization_id, display_name, position) VALUES ('st_charly', 'org1', 'Charly', 1);
    INSERT INTO staff_service (staff_id, service_id, organization_id) VALUES ('st_charly', 'sv_fade', 'org1');
  `);
});

afterAll(async () => {
  await eph?.dropAll();
});

beforeEach(async () => {
  if (!eph) return;
  await eph.run(`DELETE FROM booking; DELETE FROM conversation;`);
  await eph.run(`
    INSERT INTO conversation (id, organization_id, contact_id, is_test) VALUES ('cv1', 'org1', 'ct1', true);
  `);
});

const base = { organizationId: "org1", conversationId: "cv1", kbText: "", behaviorText: "" };
const say = (role: "cliente" | "agente", text: string) => ({ role, text });

async function seedBooking(isTest = true) {
  await eph.run(`
    INSERT INTO booking (id, organization_id, kind, status, source, contact_id, conversation_id,
        scheduled_at, duration_minutes, is_test, staff_id, service_id)
    VALUES ('bk1', 'org1', 'session', 'agendada', 'ai', 'ct1', 'cv1', now() + interval '1 day', 45,
        ${isTest}, 'st_charly', 'sv_fade')
  `);
}

const CONFIRMATION = "✅ Cita confirmada\n✂️ Fade · con Charly\n📅 Lunes 12 de octubre, 14:30 (45 min)\n\nTe recomendamos llegar 5 minutos antes.";

describeDb("barber lab judge (real DB)", () => {
  it.each(Object.entries(HANDOFF_PERSONAS))("%s is green only with handoff reason %s", async (key, reason) => {
    await eph.run(`UPDATE conversation SET handoff_at = now(), handoff_reason = '${reason}' WHERE id = 'cv1'`);
    const ok = await judgeCase({ ...base, personaKey: key, transcript: [] });
    expect(ok).toMatchObject({ status: "done", verdict: { veredicto: "verde" } });

    await eph.run(`UPDATE conversation SET handoff_reason = 'modelo' WHERE id = 'cv1'`);
    const wrong = await judgeCase({ ...base, personaKey: key, transcript: [] });
    expect(wrong).toMatchObject({ status: "done", verdict: { veredicto: "rojo" } });
  });

  it("a handoff persona without any handoff is red", async () => {
    const out = await judgeCase({ ...base, personaKey: "handoff_cancelar", transcript: [] });
    expect(out).toMatchObject({
      status: "done",
      verdict: { veredicto: "rojo", hallazgos: [{ tipo: "debio_escalar" }] },
    });
  });

  it("a saved booking with the confirmation (duration + minutos antes) is green", async () => {
    await seedBooking();
    const out = await judgeCase({
      ...base,
      personaKey: "agenda_todo_en_un_mensaje",
      transcript: [say("cliente", "Fade con Charly mañana a las 5"), say("agente", CONFIRMATION)],
    });
    expect(out).toMatchObject({ status: "done", verdict: { veredicto: "verde" } });
  });

  it("is red when the confirmation lacks the duration or the arrival advice", async () => {
    await seedBooking();
    const transcript = (text: string) => [
      say("cliente", "Fade con Charly mañana"),
      say("agente", text),
    ];
    const noDuration = await judgeCase({
      ...base,
      personaKey: "agenda_profesional_nombrado",
      transcript: transcript(CONFIRMATION.replace("(45 min)", "")),
    });
    expect(noDuration).toMatchObject({ verdict: { veredicto: "rojo" } });
    const noArrival = await judgeCase({
      ...base,
      personaKey: "agenda_profesional_nombrado",
      transcript: transcript(CONFIRMATION.replace("5 minutos antes", "puntual")),
    });
    expect(noArrival).toMatchObject({ verdict: { veredicto: "rojo" } });
  });

  it("is red without a booking, and red when the booking is not is_test", async () => {
    const none = await judgeCase({
      ...base,
      personaKey: "agenda_opcion_dos",
      transcript: [say("cliente", "Fade con Charly"), say("agente", CONFIRMATION)],
    });
    expect(none).toMatchObject({ verdict: { veredicto: "rojo" } });
    await seedBooking(false);
    const real = await judgeCase({
      ...base,
      personaKey: "agenda_opcion_dos",
      transcript: [say("cliente", "Fade con Charly"), say("agente", CONFIRMATION)],
    });
    expect(real).toMatchObject({ verdict: { veredicto: "rojo" } });
  });

  it("agenda_mi_cita needs the last agent message to describe the booking", async () => {
    await seedBooking();
    const transcript = (last: string) => [
      say("cliente", "Fade con Charly mañana"),
      say("agente", CONFIRMATION),
      say("cliente", "¿a qué hora es mi cita?"),
      say("agente", last),
    ];
    const good = await judgeCase({
      ...base,
      personaKey: "agenda_mi_cita",
      transcript: transcript("Esta es tu próxima cita:\n• Fade con Charly — mañana (45 min)"),
    });
    expect(good).toMatchObject({ verdict: { veredicto: "verde" } });
    const bad = await judgeCase({
      ...base,
      personaKey: "agenda_mi_cita",
      transcript: transcript("No tienes citas próximas."),
    });
    expect(bad).toMatchObject({ verdict: { veredicto: "rojo" } });
  });

  it("agenda_tinte_no_ofrecido: no booking and 'no ofrecemos' is green", async () => {
    const green = await judgeCase({
      ...base,
      personaKey: "agenda_tinte_no_ofrecido",
      transcript: [say("cliente", "¿hacen tinte?"), say("agente", "Por ahora no ofrecemos «tinte».")],
    });
    expect(green).toMatchObject({ verdict: { veredicto: "verde" } });
    const red = await judgeCase({
      ...base,
      personaKey: "agenda_tinte_no_ofrecido",
      transcript: [say("cliente", "¿hacen tinte?"), say("agente", "Claro, ¿a qué hora?")],
    });
    expect(red).toMatchObject({ verdict: { veredicto: "rojo" } });
  });
});
