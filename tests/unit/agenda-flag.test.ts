import { afterEach, describe, expect, it } from "vitest";
import { GET as boardGET } from "@/app/api/calendar/board/route";
import { GET as servicesGET } from "@/app/api/services/route";
import { GET as staffGET } from "@/app/api/staff/route";
import { buildAgentSystemPrompt } from "@/server/ai/prompts";
import { agendaEnabled, parseAgendaFlag } from "@/server/agenda/flag";

/**
 * 015 — La bandera de la agenda. El caso que importa es el DEFAULT: una
 * instancia que no la pidió no debe acabar con la agenda encendida por un
 * despiste de configuración.
 */

describe("parseAgendaFlag", () => {
  it("sin variable, la agenda no existe", () => {
    expect(parseAgendaFlag(undefined)).toBe(false);
    expect(parseAgendaFlag("")).toBe(false);
    expect(parseAgendaFlag("   ")).toBe(false);
  });

  it("`on` la enciende, con espacios y mayúsculas de por medio", () => {
    expect(parseAgendaFlag("on")).toBe(true);
    expect(parseAgendaFlag("ON")).toBe(true);
    expect(parseAgendaFlag("  On  ")).toBe(true);
  });

  it("acepta las otras formas de decir que sí", () => {
    expect(parseAgendaFlag("1")).toBe(true);
    expect(parseAgendaFlag("true")).toBe(true);
    expect(parseAgendaFlag("TRUE")).toBe(true);
    expect(parseAgendaFlag("si")).toBe(true);
    expect(parseAgendaFlag("sí")).toBe(true);
    expect(parseAgendaFlag("yes")).toBe(true);
  });

  it("cualquier otra cosa deja la agenda apagada, incluido `off` y `false`", () => {
    expect(parseAgendaFlag("off")).toBe(false);
    expect(parseAgendaFlag("false")).toBe(false);
    expect(parseAgendaFlag("0")).toBe(false);
    expect(parseAgendaFlag("no")).toBe(false);
    expect(parseAgendaFlag("agenda")).toBe(false);
    // Un typo no enciende nada: apagada es el estado seguro.
    expect(parseAgendaFlag("onn")).toBe(false);
  });
});

/**
 * 018 — Con la bandera ausente las rutas nuevas no existen (404 vacío) y
 * eso ocurre antes de mirar la sesión. `/api/me` no entra aquí: no usa
 * `withAgenda` y, apagada, informa `agendaEnabled: false` en vez de 404.
 */
describe("agendaEnabled y las rutas withAgenda", () => {
  const previous = process.env.AGENDA;

  afterEach(() => {
    if (previous === undefined) delete process.env.AGENDA;
    else process.env.AGENDA = previous;
  });

  async function flag404(res: Response) {
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
  }

  it("sin AGENDA, staff, servicios y tablero son 404 vacío y no 401", async () => {
    delete process.env.AGENDA;
    expect(agendaEnabled()).toBe(false);
    await flag404(await staffGET(new Request("http://localhost/api/staff")));
    await flag404(await servicesGET(new Request("http://localhost/api/services")));
    await flag404(await boardGET(new Request("http://localhost/api/calendar/board")));

    process.env.AGENDA = "";
    expect(agendaEnabled()).toBe(false);
    await flag404(await staffGET(new Request("http://localhost/api/staff")));
  });

  it("acepta on, 1, true, si, sí y yes", () => {
    for (const value of ["on", "1", "true", "si", "sí", "yes"]) {
      process.env.AGENDA = value;
      expect(agendaEnabled()).toBe(true);
    }
  });

  it("con la bandera apagada el prompt no nombra agenda ni el catálogo", () => {
    const off = buildAgentSystemPrompt({
      profile: {
        id: "ap_1",
        organizationId: "org_1",
        enabled: false,
        name: "Asistente",
        tone: null,
        instructions: null,
        escalationRules: null,
        greeting: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      kb: [],
      stages: [{ name: "Nuevo" }],
      agenda: false,
      catalog: {
        services: [
          {
            name: "Corte clásico",
            durationMinutes: 30,
            priceCents: 15000,
            currency: "MXN",
            staff: [{ displayName: "Ana Catalogo", jobTitle: "barbero" }],
          },
        ],
      },
    });
    expect(off).not.toContain("offer_slots");
    expect(off).not.toContain("book_slot");
    expect(off).not.toContain("Ana Catalogo");
    expect(off).not.toContain("Corte clásico");
  });
});
