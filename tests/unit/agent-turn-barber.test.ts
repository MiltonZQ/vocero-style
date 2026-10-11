import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";
import { describeDb, openEphemeralDb, type EphemeralDb } from "./helpers/ephemeral-db";

/**
 * 019 — The barber bot turn, end to end against a real database.
 *
 * Only the model (`chatJson`) and the connector layer are replaced. Everything
 * else is real: draft, guards, catalog matching, availability, offers,
 * booking, confirmation. The stub validates each scripted model answer with
 * the REAL action schema, so a test can't invent an action the contract
 * doesn't allow.
 */

const h = vi.hoisted(() => ({
  db: null as unknown,
  queue: [] as unknown[],
  calls: [] as Array<Array<{ role: string; content: string }>>,
  bindConnector: vi.fn(),
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
    h.calls.push(messages);
    const next = h.queue.shift();
    if (next === "FAIL" || next === undefined) {
      return { ok: false, error: "invalid_output", detail: "scripted failure" };
    }
    const parsed = schemaArg.safeParse(next);
    if (!parsed.success) return { ok: false, error: "invalid_output", detail: "schema" };
    return { ok: true, data: parsed.data, raw: "" };
  },
}));
vi.mock("@/server/agenda/connectors", () => ({
  bindConnector: h.bindConnector,
  markConnectorAuthError: async () => {},
}));
vi.mock("@/server/events/bus", () => ({ publish: () => {} }));

const NOW = new Date("2026-10-11T16:00:00Z"); // Sunday 10:00 in Mexico City
const MON_HOURS = '[{"start":"10:00","end":"20:00"}]';

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
    INSERT INTO contact (id, organization_id, name, wa_identity) VALUES
      ('ct1', 'org1', 'Uno', '5215500000001'), ('ct2', 'org1', 'Dos', '5215500000002');
    INSERT INTO conversation (id, organization_id, contact_id, is_test, last_inbound_at)
      VALUES ('cv1', 'org1', 'ct1', true, now());
    INSERT INTO agent_profile (id, organization_id, enabled, name)
      VALUES ('ap1', 'org1', true, 'Style Bot');
    INSERT INTO calendar_settings (id, organization_id, weekly_hours, slot_minutes, buffer_minutes,
        min_notice_hours, max_days_ahead, timezone, location_address, location_maps_url,
        arrival_lead_minutes)
      VALUES ('cs1', 'org1',
        '{"mon":${MON_HOURS},"tue":${MON_HOURS},"wed":${MON_HOURS},"thu":${MON_HOURS},"fri":${MON_HOURS},"sat":${MON_HOURS}}',
        30, 0, 2, 7, 'America/Mexico_City', 'Av. Juárez 123, Col. Centro', 'https://maps.example/style', 5);
    INSERT INTO service (id, organization_id, name, duration_minutes, price_cents, position) VALUES
      ('sv_fade', 'org1', 'Fade', 45, 25000, 1),
      ('sv_corte', 'org1', 'Corte clásico', 30, 20000, 2),
      ('sv_barba', 'org1', 'Barba', 30, 15000, 3),
      ('sv_cejas', 'org1', 'Cejas', 15, 8000, 4),
      ('sv_mascarilla', 'org1', 'Mascarilla', 60, 30000, 5);
    INSERT INTO staff (id, organization_id, display_name, position) VALUES
      ('st_charly', 'org1', 'Charly', 1), ('st_luis', 'org1', 'Luis', 2),
      ('st_ana', 'org1', 'Ana', 3), ('st_charlie', 'org1', 'Charlie', 4);
    INSERT INTO staff_service (staff_id, service_id, organization_id) VALUES
      ('st_charly', 'sv_fade', 'org1'), ('st_charly', 'sv_corte', 'org1'),
      ('st_luis', 'sv_fade', 'org1'), ('st_luis', 'sv_corte', 'org1'), ('st_luis', 'sv_barba', 'org1'),
      ('st_ana', 'sv_corte', 'org1'), ('st_ana', 'sv_barba', 'org1'),
      ('st_charlie', 'sv_barba', 'org1'),
      ('st_ana', 'sv_cejas', 'org1');
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
  h.bindConnector.mockClear();
  await eph.run(`
    DELETE FROM booking; DELETE FROM booking_draft; DELETE FROM offered_slot; DELETE FROM message;
    UPDATE conversation SET handoff_at = NULL, handoff_reason = NULL WHERE id = 'cv1';
  `);
});

afterEach(() => {
  delete process.env.AGENDA;
});

/** The client says `text`, the model answers `action`; returns what the bot sent. */
async function turn(text: string, action: unknown): Promise<string> {
  seq += 1;
  await eph.run(`
    INSERT INTO message (id, organization_id, conversation_id, direction, type, text, status, created_at)
    VALUES ('in_${seq}', 'org1', 'cv1', 'in', 'text', '${text.replaceAll("'", "''")}', 'delivered',
            now() + interval '${seq} seconds')
  `);
  h.queue.push(action);
  const before = await outboundCount();
  await runAgentTurn("cv1");
  const rows = await eph.run(
    `SELECT text FROM message WHERE conversation_id = 'cv1' AND direction = 'out' ORDER BY created_at DESC, id DESC LIMIT 1`
  );
  return (await outboundCount()) > before ? String(rows[0]?.text) : "";
}

async function outboundCount(): Promise<number> {
  const rows = await eph.run(
    `SELECT count(*)::int AS n FROM message WHERE conversation_id = 'cv1' AND direction = 'out'`
  );
  return Number(rows[0]?.n);
}

async function draft() {
  const rows = await eph.run(`SELECT * FROM booking_draft WHERE conversation_id = 'cv1'`);
  return rows[0];
}

async function conversationRow() {
  const rows = await eph.run(`SELECT handoff_at, handoff_reason FROM conversation WHERE id = 'cv1'`);
  return rows[0];
}

async function seedBooking(contactId: string, scheduledAt: string, staffId = "st_charly") {
  await eph.run(`
    INSERT INTO booking (id, organization_id, kind, status, source, contact_id, scheduled_at,
        duration_minutes, is_test, staff_id, service_id, price_cents, currency)
    VALUES ('bk_${++seq}', 'org1', 'session', 'agendada', 'ai', '${contactId}', '${scheduledAt}',
        45, true, '${staffId}', 'sv_fade', 25000, 'MXN')
  `);
}

describeDb("barber agent turn (real DB)", () => {
  it("books step by step: service, staff, time window, option, confirmation", async () => {
    const t1 = await turn("quiero un fade", { action: "update_draft", service: "Fade" });
    expect(t1).toBe(
      "Perfecto. Para Fade contamos con Charly y Luis. ¿Con cuál de nuestros profesionales deseas ser atendido? Si prefieres, también puedo agendarte con el primero disponible."
    );

    const t2 = await turn("con charly", { action: "update_draft", staff: "Charly" });
    expect(t2).toContain("tenemos disponible a las");
    expect(t2).not.toMatch(/número|\d\) /);

    const t3 = await turn("mejor mañana en la tarde", {
      action: "update_draft",
      when: { day: "mañana", from: "14:00", to: "19:00" },
    });
    expect(t3).toBe(
      "Para mañana lunes 12 de octubre tenemos disponible a las 2:00 p. m., 2:30 p. m. y 3:00 p. m. ¿Cuál de estos horarios prefieres, o deseas que consultemos otra fecha?"
    );

    const t4 = await turn("a las 2:30", { action: "book_slot", time: "14:30" });
    expect(t4).toContain("¡Listo, tu cita quedó agendada!");
    expect(t4).toContain("Fade");
    expect(t4).toContain("Charly");
    expect(t4).toContain("Lunes 12 de octubre, 2:30 p. m.");
    expect(t4).toContain("45 min");
    expect(t4).toContain("$250 MXN");
    expect(t4).toContain("Av. Juárez 123, Col. Centro");
    expect(t4).toContain("https://maps.example/style");
    expect(t4).toContain("Te recomendamos llegar 5 minutos antes. ¡Te esperamos!");

    const bookings = await eph.run(`SELECT * FROM booking`);
    expect(bookings).toHaveLength(1);
    expect(bookings[0]).toMatchObject({ staff_id: "st_charly", service_id: "sv_fade", source: "ai" });
    // The draft and the offers are gone; in-person never touches a connector.
    expect(await draft()).toBeUndefined();
    expect(await eph.run(`SELECT 1 FROM offered_slot`)).toHaveLength(0);
    expect(h.bindConnector).not.toHaveBeenCalled();
  });

  it("fills everything said at once and goes straight to the window's offers", async () => {
    const text = await turn("fade con luis el martes después de las 5", {
      action: "update_draft",
      service: "fade",
      staff: "luis",
      when: { day: "martes", from: "17:00" },
    });
    expect(text).toContain(
      "Para el martes 13 de octubre tenemos disponible a las 5:00 p. m., 5:30 p. m. y 6:00 p. m."
    );
    expect((await draft())?.staff_choice).toBe("st_luis");
  });

  it("any staff is accepted and the offers are flagged any-staff", async () => {
    await turn("fade", { action: "update_draft", service: "Fade" });
    const text = await turn("me da igual", { action: "update_draft", staff: "any" });
    expect(text).toContain("tenemos disponible a las");
    expect((await draft())?.staff_choice).toBe("any");
    const offers = await eph.run(`SELECT any_staff FROM offered_slot`);
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every((o) => o.any_staff === true)).toBe(true);
  });

  it("asks which one when a staff name is ambiguous", async () => {
    await turn("barba", { action: "update_draft", service: "Barba" });
    const text = await turn("con char", { action: "update_draft", staff: "Char" });
    expect(text).toContain("¿Con cuál de ellos deseas ser atendido?");
    expect(text).toContain("Charly");
    expect(text).toContain("Charlie");
    expect((await draft())?.staff_choice).toBeNull();
  });

  it("lists who does the service when the staff does not", async () => {
    const text = await turn("fade con ana", {
      action: "update_draft",
      service: "Fade",
      staff: "Ana",
    });
    expect(text).toContain("Ana no hace Fade");
    expect(text).toContain("Para Fade contamos con Charly y Luis.");
    const row = await draft();
    expect(row?.service_id).toBe("sv_fade");
    expect(row?.staff_choice).toBeNull();
  });

  it("says a service is not offered and shows the catalog without setting a service", async () => {
    const text = await turn("tienen tinte?", { action: "update_draft", service: "tinte" });
    expect(text).toContain("no ofrecemos «tinte»");
    expect(text).toContain("Contamos con Fade ($250 MXN)");
    expect((await draft())?.service_id).toBeNull();
  });

  it("changing the service drops a staff who does not do the new one", async () => {
    await turn("fade con charly", { action: "update_draft", service: "Fade", staff: "Charly" });
    const text = await turn("mejor barba", { action: "update_draft", service: "Barba" });
    expect(text).toContain("Charly no hace Barba");
    expect(text).toContain("Para Barba");
    const row = await draft();
    expect(row?.service_id).toBe("sv_barba");
    expect(row?.staff_choice).toBeNull();
    expect(await eph.run(`SELECT 1 FROM offered_slot`)).toHaveLength(0);
  });

  it("an empty window says so and offers the nearest slots", async () => {
    // Sunday the shop is closed.
    const text = await turn("fade con luis este domingo", {
      action: "update_draft",
      service: "Fade",
      staff: "Luis",
      when: { day: "2026-10-18" },
    });
    expect(text).toContain("Con Luis no tenemos horarios disponibles");
    expect(text).toContain("Lo más cercano es para");
  });

  it("the guard turns an early book_slot into the missing step", async () => {
    const text = await turn("la primera", { action: "book_slot", option: 1 });
    expect(text).toContain("¿En cuál de nuestros servicios estás interesado?");
    expect(await eph.run(`SELECT 1 FROM booking`)).toHaveLength(0);
  });

  it("a taken slot says so and offers fresh options", async () => {
    await turn("fade con charly mañana", {
      action: "update_draft",
      service: "Fade",
      staff: "Charly",
      when: { day: "mañana", from: "14:00", to: "19:00" },
    });
    const [first] = await eph.run(`SELECT start_utc FROM offered_slot ORDER BY start_utc LIMIT 1`);
    const start = `${String(first?.start_utc).replace(" ", "T")}Z`;
    // Sandbox bookings never block real ones, so the rival booking is a real one.
    await eph.run(`
      INSERT INTO booking (id, organization_id, kind, status, source, contact_id, scheduled_at,
          duration_minutes, is_test, staff_id, service_id)
      VALUES ('bk_race', 'org1', 'session', 'agendada', 'manual', 'ct2', '${start}', 45, false,
          'st_charly', 'sv_fade')
    `);
    const text = await turn("la primera", { action: "book_slot", option: 1 });
    expect(text).toContain("se acaba de ocupar");
    expect(text).toContain("tenemos disponible");
    expect(text).not.toMatch(/\d\) /);
    expect(await eph.run(`SELECT 1 FROM booking WHERE contact_id = 'ct1'`)).toHaveLength(0);
  });

  it("my_bookings lists upcoming bookings with staff, duration and address", async () => {
    await seedBooking("ct1", "2026-10-13 22:00");
    const text = await turn("a qué hora era mi cita", { action: "my_bookings" });
    expect(text).toContain("Fade con Charly");
    expect(text).toContain("Martes 13 de octubre, 4:00 p. m.");
    expect(text).toContain("45 min");
    expect(text).toContain("Av. Juárez 123");
  });

  it("mentions an existing booking in the first offer message only", async () => {
    await seedBooking("ct1", "2026-10-13 22:00");
    const first = await turn("fade con charly", {
      action: "update_draft",
      service: "Fade",
      staff: "Charly",
    });
    expect(first).toContain("Ya tienes una cita");
    expect(first).toContain("otra adicional");
    const second = await turn("mejor el miércoles", {
      action: "update_draft",
      when: { day: "miércoles" },
    });
    expect(second).not.toContain("Ya tienes una cita");
  });

  it("hands off with the model's reason, delivering the farewell", async () => {
    const text = await turn("quiero cancelar mi cita", {
      action: "handoff",
      reason: "cancelacion",
      farewell: "Te paso con el equipo.",
    });
    expect(text).toBe("Te paso con el equipo.");
    expect((await conversationRow())?.handoff_reason).toBe("cancelacion");
  });

  it("an unknown handoff reason still hands off", async () => {
    await turn("ayuda", { action: "handoff", reason: "porque sí" });
    const row = await conversationRow();
    expect(row?.handoff_at).not.toBeNull();
    expect(row?.handoff_reason).toBe("modelo");
  });

  it("gives the model today's date, the shop hours and the numbered draft state", async () => {
    await turn("hola", { action: "reply", text: "¡Hola! ¿Qué servicio quieres?" });
    const first = h.calls[0] ?? [];
    expect(first[0]?.content).toContain("HORARIO DEL LOCAL");
    expect(first[0]?.content).toContain("domingo cerrado");
    expect(first[0]?.content).toContain('reason "cancelacion"');
    const state = first[first.length - 1]?.content ?? "";
    expect(state).toContain("Hoy es domingo 11 de octubre de 2026, 10:00");
    expect(state).toContain("paso: need_service");

    await turn("fade con luis", { action: "update_draft", service: "Fade", staff: "Luis" });
    await turn("hola otra vez", { action: "reply", text: "Aquí sigo." });
    const last = h.calls[h.calls.length - 1] ?? [];
    const next = last[last.length - 1]?.content ?? "";
    expect(next).toContain("paso: ready");
    expect(next).toContain("servicio: Fade");
    expect(next).toContain("profesional: Luis");
    expect(next).toMatch(/\n {2}1\) /);
  });

  it("re-asks the step on a model failure and hands off on the second in a row", async () => {
    const first = await turn("hola", "FAIL");
    expect(first).toContain("¿En cuál de nuestros servicios estás interesado?");
    expect((await draft())?.failed_turns).toBe(1);
    expect((await conversationRow())?.handoff_at).toBeNull();

    await turn("hola?", "FAIL");
    expect((await conversationRow())?.handoff_reason).toBe("error");
  });

  it("a successful turn resets the failure counter", async () => {
    await turn("hola", "FAIL");
    await turn("hola", { action: "reply", text: "Hola" });
    expect((await draft())?.failed_turns).toBe(0);
    await turn("hola", "FAIL");
    expect((await conversationRow())?.handoff_at).toBeNull();
  });

  it("hands off as stuck after three booking turns without progress", async () => {
    await turn("la primera", { action: "book_slot", option: 1 });
    await turn("la primera", { action: "book_slot", option: 1 });
    expect((await conversationRow())?.handoff_at).toBeNull();
    const text = await turn("la primera", { action: "book_slot", option: 1 });
    expect(text).toContain("Te paso con alguien del equipo");
    expect((await conversationRow())?.handoff_reason).toBe("atascado");
  });

  it("FAQ replies, my_bookings, lead notes and stage moves never count as stuck", async () => {
    for (let i = 0; i < 3; i++) {
      await turn("¿dónde están?", { action: "reply", text: "Estamos en Av. Juárez 123." });
    }
    await turn("¿cuándo es mi cita?", { action: "my_bookings" });
    await turn("soy fan", { action: "update_lead", note: "le gusta el fade" });
    await turn("hola", { action: "reply", text: "Hola" });
    expect((await conversationRow())?.handoff_at).toBeNull();
    expect((await draft())?.stuck_turns ?? 0).toBe(0);
  });

  it("FAQ replies in between do not reset the stuck counter", async () => {
    await turn("la primera", { action: "book_slot", option: 1 });
    await turn("la primera", { action: "book_slot", option: 1 });
    await turn("¿dónde están?", { action: "reply", text: "Av. Juárez 123." });
    expect((await draft())?.stuck_turns).toBe(2);
    await turn("la primera", { action: "book_slot", option: 1 });
    expect((await conversationRow())?.handoff_reason).toBe("atascado");
  });

  it("progress resets the stuck counter", async () => {
    await turn("la primera", { action: "book_slot", option: 1 });
    await turn("la primera", { action: "book_slot", option: 1 });
    await turn("fade", { action: "update_draft", service: "Fade" });
    expect((await draft())?.stuck_turns).toBe(0);
    await turn("la primera", { action: "book_slot", option: 1 });
    expect((await conversationRow())?.handoff_at).toBeNull();
  });

  it("auto-picks the only barber who does the service and names them in the offer", async () => {
    const text = await turn("quiero cejas", { action: "update_draft", service: "Cejas" });
    expect(text).toContain("Ana");
    expect(text).toContain("tenemos disponible a las");
    expect(text).not.toContain("primero disponible");
    const row = await draft();
    expect(row?.staff_choice).toBe("st_ana");
    const offers = await eph.run(`SELECT staff_id, any_staff FROM offered_slot`);
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every((o) => o.staff_id === "st_ana" && o.any_staff === false)).toBe(true);
  });

  it("does not auto-pick when several barbers do the service", async () => {
    const text = await turn("quiero un fade", { action: "update_draft", service: "Fade" });
    expect(text).toContain("primero disponible");
    expect((await draft())?.staff_choice).toBeNull();
  });
});

describeDb("barber agent turn - receptionist tone (real DB)", () => {
  it("greets by business name and ends at the question, with no service list", async () => {
    const text = await turn("hola", { action: "greeting" });
    expect(text).toBe(
      "¡Hola! ¿Cómo estás? Te damos la bienvenida a Style. ¿En cuál de nuestros servicios estás interesado?"
    );
    expect((await draft())?.service_id ?? null).toBeNull();
  });

  it("list_services answers with the COMPLETE active catalog, even services nobody performs", async () => {
    const text = await turn("¿qué servicios tienen?", { action: "list_services" });
    expect(text).toBe(
      [
        "Estos son nuestros servicios:",
        "- Fade · 45 min · $250 MXN",
        "- Corte clásico · 30 min · $200 MXN",
        "- Barba · 30 min · $150 MXN",
        "- Cejas · 15 min · $80 MXN",
        "- Mascarilla · 60 min · $300 MXN",
        "",
        "¿En cuál de ellos estás interesado?",
      ].join("\n")
    );
    expect((await draft())?.service_id ?? null).toBeNull();
  });

  it("list_services never counts toward the stuck handoff", async () => {
    for (let i = 0; i < 5; i++) await turn("precios?", { action: "list_services" });
    expect((await conversationRow())?.handoff_at).toBeNull();
  });

  it("a service with no professional says it cannot be booked here and offers the bookable ones", async () => {
    await turn("¿qué servicios tienen?", { action: "list_services" });
    const text = await turn("quiero una mascarilla", { action: "update_draft", service: "Mascarilla" });
    expect(text).toContain("Mascarilla");
    expect(text).toMatch(/por ahora.*no se puede agendar por WhatsApp/i);
    expect(text).toContain("Fade");
    expect(text).not.toContain("Cejas ( MXN) y Mascarilla");
    expect((await draft())?.service_id ?? null).toBeNull();
    expect((await conversationRow())?.handoff_at).toBeNull();
  });

  it("'hoy' with nothing today says so first and offers the nearest slots", async () => {
    // Sunday: the shop is closed all day.
    const text = await turn("¿algo para hoy?", {
      action: "update_draft",
      service: "Fade",
      staff: "any",
      when: { day: "hoy" },
    });
    expect(text.startsWith("Para hoy no tenemos horarios disponibles")).toBe(true);
    expect(text).toContain("Lo más cercano es para");
  });

  it("an empty update_draft (wants to book, no service yet) asks which service, without welcoming", async () => {
    const text = await turn("quiero una cita", { action: "update_draft" });
    expect(text).toBe(
      "¿En cuál de nuestros servicios estás interesado? Contamos con Fade ($250 MXN), Corte clásico ($200 MXN), Barba ($150 MXN) y Cejas ($80 MXN)."
    );
  });

  it("a greeting in the middle of the flow re-asks the current step instead of welcoming again", async () => {
    await turn("fade", { action: "update_draft", service: "Fade" });
    const text = await turn("hola?", { action: "greeting" });
    expect(text).toContain("Para Fade contamos con Charly y Luis.");
    expect(text).not.toContain("bienvenida");
  });

  it("greetings are not booking turns: they never trip the stuck handoff", async () => {
    for (let i = 0; i < 4; i++) await turn("hola", { action: "greeting" });
    expect((await conversationRow())?.handoff_at).toBeNull();
  });

  it("never prepends the model's reply to a code-driven step message", async () => {
    const text = await turn("quiero un fade", {
      action: "update_draft",
      service: "Fade",
      reply: "¡Claro que sí! 😄",
    });
    expect(text).not.toContain("Claro que sí");
    expect(text.startsWith("Perfecto. Para Fade")).toBe(true);
  });

  it("books by ordinal when the client does not say the time", async () => {
    await turn("fade con charly mañana en la tarde", {
      action: "update_draft",
      service: "Fade",
      staff: "Charly",
      when: { day: "mañana", from: "14:00", to: "19:00" },
    });
    const text = await turn("el primero", { action: "book_slot", option: 1 });
    expect(text).toContain("Lunes 12 de octubre, 2:00 p. m.");
  });

  it("books by time plus day", async () => {
    await turn("fade con charly", { action: "update_draft", service: "Fade", staff: "Charly" });
    const first = await eph.run(`SELECT start_utc FROM offered_slot ORDER BY start_utc LIMIT 1`);
    expect(first).toHaveLength(1);
    const text = await turn("mañana a las 10", { action: "book_slot", day: "mañana", time: "10:00" });
    expect(text).toContain("Lunes 12 de octubre, 10:00 a. m.");
  });

  it("a time that was not offered re-asks naturally, listing what is available", async () => {
    await turn("fade con charly mañana en la tarde", {
      action: "update_draft",
      service: "Fade",
      staff: "Charly",
      when: { day: "mañana", from: "14:00", to: "19:00" },
    });
    const text = await turn("a las 9:30", { action: "book_slot", time: "09:30" });
    expect(text).toBe(
      "No tenemos disponible ese horario. Para mañana lunes 12 de octubre tenemos disponible a las 2:00 p. m., 2:30 p. m. y 3:00 p. m. ¿Cuál de estos horarios prefieres, o deseas que consultemos otra fecha?"
    );
    expect(await eph.run(`SELECT 1 FROM booking`)).toHaveLength(0);
  });

  it("an ordinal outside the offers also re-asks naturally", async () => {
    await turn("fade con charly", { action: "update_draft", service: "Fade", staff: "Charly" });
    const text = await turn("el quinto", { action: "book_slot", option: 5 });
    expect(text).toContain("tenemos disponible");
    expect(text).not.toMatch(/\d\) |número/);
  });

  it("asks which one when a time is offered on two days", async () => {
    await eph.run(`
      UPDATE calendar_settings SET weekly_hours =
        '{"mon":[{"start":"19:00","end":"20:00"}],"tue":[{"start":"19:00","end":"20:00"}],"wed":[{"start":"10:00","end":"20:00"}]}'
      WHERE id = 'cs1'`);
    try {
      await turn("fade con charly", { action: "update_draft", service: "Fade", staff: "Charly" });
      const text = await turn("a las 7", { action: "book_slot", time: "19:00" });
      expect(text).toContain("Para mañana lunes 12 de octubre");
      expect(await eph.run(`SELECT 1 FROM booking`)).toHaveLength(0);
    } finally {
      await eph.run(`
        UPDATE calendar_settings SET weekly_hours =
          '{"mon":${MON_HOURS},"tue":${MON_HOURS},"wed":${MON_HOURS},"thu":${MON_HOURS},"fri":${MON_HOURS},"sat":${MON_HOURS}}'
        WHERE id = 'cs1'`);
    }
  });
});

describeDb("barber agent turn with the agenda flag off (real DB)", () => {
  it("behaves as before: plain reply, no draft, no agenda in the prompt", async () => {
    delete process.env.AGENDA;
    const text = await turn("hola", { action: "reply", text: "Hola, ¿en qué te ayudo?" });
    expect(text).toBe("Hola, ¿en qué te ayudo?");
    expect(await draft()).toBeUndefined();
    const joined = (h.calls[0] ?? []).map((m) => m.content).join("\n");
    expect(joined).not.toContain("ESTADO DEL BORRADOR");
    expect(joined).not.toContain("update_draft");
  });

  it("does not accept agenda actions and still escalates immediately on a model failure", async () => {
    delete process.env.AGENDA;
    await turn("quiero un fade", { action: "update_draft", service: "Fade" });
    expect((await conversationRow())?.handoff_reason).toBe("error");
    expect(await draft()).toBeUndefined();
  });

  it("a model handoff keeps the generic reason", async () => {
    delete process.env.AGENDA;
    await turn("ayuda", { action: "handoff", reason: "cancelacion" });
    expect((await conversationRow())?.handoff_reason).toBe("modelo");
  });
});
