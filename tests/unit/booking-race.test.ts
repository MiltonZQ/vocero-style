import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 015 — La carrera del hueco (FR-006).
 *
 * Dos confirmaciones simultáneas del mismo instante pasan las dos la
 * re-validación —entre leer y escribir cabe la otra— y es la BASE quien las
 * separa, con el índice único parcial. Lo que se fija aquí es la traducción de
 * ese choque: `23505` ⇒ `slot_taken` CON alternativas frescas, y jamás una
 * cita creada.
 *
 * La carrera de verdad, con dos peticiones concurrentes contra la app viva, la
 * corre el arnés E2E: esto asegura que cuando ocurra, la respuesta sea útil.
 */

const settings = {
  weeklyHours: { wed: [{ start: "09:00", end: "18:00" }] },
  slotMinutes: 30,
  bufferMinutes: 0,
  minNoticeHours: 0,
  maxDaysAhead: 7,
  timezone: "America/Mexico_City",
  connector: "enlace-fijo" as const,
  meetingLink: "https://meet.ejemplo.com/sala",
};

const SLOT = "2026-08-05T15:00:00.000Z";

const ALTERNATIVES = [
  { startUtc: "2026-08-05T15:30:00.000Z", endUtc: "…", label: "mié 5 ago, 09:30" },
  { startUtc: "2026-08-05T16:00:00.000Z", endUtc: "…", label: "mié 5 ago, 10:00" },
];

const replaceOffers = vi.fn(async () => {});
const clearOffers = vi.fn(async () => {});
const moveLeadToStage = vi.fn(async () => ({ ok: true as const }));
const createMeeting = vi.fn(async () => ({
  externalId: null,
  joinUrl: settings.meetingLink,
}));

vi.mock("@/server/agenda/settings", () => ({
  getSettings: async () => settings,
}));

// 018: la resolución temporal de profesional/servicio (TEMPORAL US2) se simula;
// su comportamiento real lo cubre tests/unit/default-staff.test.ts.
vi.mock("@/server/agenda/default-staff", () => ({
  resolveSoleStaffId: async () => "st_1",
  resolveDefaultCatalog: async () => ({
    staffId: "st_1",
    serviceId: "sv_1",
    durationMinutes: 30,
    priceCents: 0,
    currency: "MXN",
  }),
}));

vi.mock("@/server/agenda/availability", () => ({
  // El hueco se ve libre al re-validar: la otra confirmación aún no escribía.
  findSlot: async () => ({ startUtc: SLOT, endUtc: "…", label: "mié 5 ago, 09:00" }),
  computeAvailability: async () => ALTERNATIVES,
}));

vi.mock("@/server/agenda/offers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/agenda/offers")>();
  return {
    ...original,
    getOffers: async () => [{ startUtc: SLOT, label: "mié 5 ago, 09:00" }],
    replaceOffers,
    clearOffers,
  };
});

vi.mock("@/server/agenda/connectors", () => ({
  bindConnector: async () => ({
    id: "enlace-fijo",
    createMeeting,
    updateMeeting: async () => {},
    deleteMeeting: async () => {},
    testConnection: async () => ({ ok: true }),
  }),
  markConnectorAuthError: async () => {},
}));

vi.mock("@/server/leads/stage-history", () => ({ moveLeadToStage }));
vi.mock("@/server/events/bus", () => ({ publish: () => {} }));

/** Cola de resultados para cada `select(...).limit(n)` en orden de llamada. */
const selectRows: unknown[][] = [];
/** Si tiene algo, el INSERT lo lanza en vez de insertar. */
let insertThrows: unknown = null;
const inserted: unknown[] = [];

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "leftJoin", "innerJoin"]) {
    c[m] = () => c;
  }
  c.limit = () => Promise.resolve(rows);
  return c;
}

const column = (name: string) => ({ name });

vi.mock("@/lib/db", () => {
  const db = {
    select: () => chain(selectRows.shift() ?? []),
    insert: () => ({
      values: (v: unknown) => ({
        returning: () => {
          if (insertThrows) return Promise.reject(insertThrows);
          inserted.push(v);
          return Promise.resolve([
            {
              ...(v as object),
              scheduledAt: new Date(SLOT),
              meetingLink: null,
              linkPending: false,
              isTest: false,
              externalRef: null,
            },
          ]);
        },
      }),
    }),
    update: () => ({
      set: (v: unknown) => ({
        where: () => ({
          returning: () =>
            Promise.resolve([
              {
                id: "bk_1",
                organizationId: "org_1",
                scheduledAt: new Date(SLOT),
                durationMinutes: 30,
                isTest: false,
                connector: "enlace-fijo",
                notes: null,
                contactId: "ct_1",
                ...(v as object),
              },
            ]),
        }),
      }),
    }),
    execute: async () => [],
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return {
    getDb: () => db,
    schema: {
      booking: {
        organizationId: column("organizationId"),
        id: column("id"),
        kind: column("kind"),
        staffId: column("staffId"),
        status: column("status"),
        isTest: column("isTest"),
        legacyOverlap: column("legacyOverlap"),
        scheduledAt: column("scheduledAt"),
        durationMinutes: column("durationMinutes"),
      },
      staff: {
        organizationId: column("organizationId"),
        id: column("id"),
        active: column("active"),
        weeklyHours: column("weeklyHours"),
      },
      service: {
        organizationId: column("organizationId"),
        id: column("id"),
        active: column("active"),
        durationMinutes: column("durationMinutes"),
        priceCents: column("priceCents"),
        currency: column("currency"),
      },
      staffService: {
        organizationId: column("organizationId"),
        staffId: column("staffId"),
        serviceId: column("serviceId"),
        durationMinutes: column("durationMinutes"),
      },
      conversation: { organizationId: column("organizationId"), id: column("id"), contactId: column("contactId"), isTest: column("isTest") },
      contact: { organizationId: column("organizationId"), id: column("id"), name: column("name") },
      lead: { organizationId: column("organizationId"), contactId: column("contactId"), id: column("id") },
      pipelineStage: { organizationId: column("organizationId") },
      offeredSlot: {},
    },
  };
});

function primeLookups() {
  // Catálogo del profesional y el servicio, luego la conversación, el nombre y el lead.
  selectRows.push([{ id: "st_1", active: true, weeklyHours: null }]);
  selectRows.push([
    { id: "sv_1", active: true, durationMinutes: 30, priceCents: 0, currency: "MXN" },
  ]);
  selectRows.push([{ durationMinutes: null }]);
  selectRows.push([]);
  selectRows.push([{ contactId: "ct_1", isTest: false }]);
  selectRows.push([{ name: "Ana" }]);
  selectRows.push([{ id: "ld_1" }]);
}

describe("la carrera del hueco", () => {
  beforeEach(() => {
    selectRows.length = 0;
    inserted.length = 0;
    insertThrows = null;
    replaceOffers.mockClear();
    clearOffers.mockClear();
  });

  it("un 23505 se traduce a slot_taken con alternativas frescas, sin crear la cita", async () => {
    const { createSessionBooking, BookingError } = await import(
      "@/server/agenda/service"
    );
    primeLookups();
    insertThrows = { code: "23505" };

    const promise = createSessionBooking({
      organizationId: "org_1",
      conversationId: "cv_1",
      startUtc: SLOT,
      source: "ai",
      requireOffer: true,
      staffId: "st_1",
      serviceId: "sv_1",
    });

    await expect(promise).rejects.toBeInstanceOf(BookingError);
    await promise.catch((err) => {
      expect(err.code).toBe("slot_taken");
      // Con alternativas concretas: sin ellas, la conversación se queda sin
      // salida y el cliente sin cita.
      expect(err.slots).toHaveLength(2);
      expect(err.slots[0].label).toBe("mié 5 ago, 09:30");
    });

    // Y quedan REGISTRADAS como la nueva oferta: el cliente puede aceptar una
    // de inmediato y la validación seguirá siendo válida.
    expect(replaceOffers).toHaveBeenCalledOnce();
    expect(inserted).toHaveLength(0);
  });

  it("un 23P01 (EXCLUDE por profesional, 018) también es slot_taken", async () => {
    const { createSessionBooking, BookingError } = await import(
      "@/server/agenda/service"
    );
    primeLookups();
    insertThrows = { code: "23P01" };

    const promise = createSessionBooking({
      organizationId: "org_1",
      conversationId: "cv_1",
      startUtc: SLOT,
      source: "ai",
      requireOffer: false,
      staffId: "st_1",
      serviceId: "sv_1",
    });
    await expect(promise).rejects.toBeInstanceOf(BookingError);
    await expect(promise).rejects.toMatchObject({ code: "slot_taken" });
    expect(inserted).toHaveLength(0);
  });

  it("el 23505 también se reconoce cuando el driver lo envuelve en `cause`", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");
    primeLookups();
    insertThrows = Object.assign(new Error("insert falló"), {
      cause: { code: "23505" },
    });

    await expect(
      createSessionBooking({
        organizationId: "org_1",
        conversationId: "cv_1",
        startUtc: SLOT,
        source: "ai",
        requireOffer: true,
        staffId: "st_1",
        serviceId: "sv_1",
      })
    ).rejects.toMatchObject({ code: "slot_taken" });
  });

  it("un error que NO es la carrera se propaga tal cual, sin disfrazarse de slot_taken", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");
    primeLookups();
    insertThrows = { code: "23503", message: "foreign key" };

    await expect(
      createSessionBooking({
        organizationId: "org_1",
        conversationId: "cv_1",
        startUtc: SLOT,
        source: "ai",
        requireOffer: true,
        staffId: "st_1",
        serviceId: "sv_1",
      })
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("un instante que nunca se ofreció se rechaza ANTES de tocar la base", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");
    primeLookups();

    const promise = createSessionBooking({
      organizationId: "org_1",
      conversationId: "cv_1",
      // Libre y válido, pero jamás ofrecido en esta conversación.
      startUtc: "2026-08-05T20:00:00.000Z",
      source: "ai",
      requireOffer: true,
      staffId: "st_1",
      serviceId: "sv_1",
    });

    await expect(promise).rejects.toMatchObject({ code: "slot_not_offered" });
    await promise.catch((err) => {
      // Se devuelve lo que SÍ se ofreció, para que se re-ofrezca en vez de
      // inventar.
      expect(err.slots[0].startUtc).toBe(SLOT);
    });
    expect(inserted).toHaveLength(0);
  });
});
