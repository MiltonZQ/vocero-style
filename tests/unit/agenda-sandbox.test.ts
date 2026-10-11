import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 015 — El sandbox del Laboratorio en la agenda.
 *
 * Una cita de una conversación de prueba se registra, pero JAMÁS llega a un
 * conector: nadie crea una reunión de Zoom ni un evento en el calendario del
 * dueño por una simulación.
 *
 * Se prueba aquí y no en el arnés E2E por una razón concreta: las
 * conversaciones del Laboratorio no son alcanzables desde la API pública (a
 * propósito), así que no hay forma de conducirlas desde fuera. Este test sí
 * puede afirmar lo que importa —que el conector no se llama— en vez de
 * observarlo por ausencia.
 *
 * En el fork del que salió este motor la protección es ASIMÉTRICA: existe al
 * crear y está cableada a `false` al reprogramar y cancelar. Ahí no rompe nada
 * de milagro; aquí se comprueban las tres.
 */

const settings = {
  weeklyHours: { wed: [{ start: "09:00", end: "18:00" }] },
  slotMinutes: 30,
  bufferMinutes: 0,
  minNoticeHours: 0,
  maxDaysAhead: 7,
  timezone: "America/Mexico_City",
  connector: "zoom" as const,
  meetingLink: null,
};

const SLOT = "2026-08-05T15:00:00.000Z";

const createMeeting = vi.fn(async () => ({
  externalId: "zoom_1",
  joinUrl: "https://zoom.test/j/1",
}));
const updateMeeting = vi.fn(async () => {});
const deleteMeeting = vi.fn(async () => {});
const bindConnector = vi.fn(async () => ({
  id: "zoom",
  createMeeting,
  updateMeeting,
  deleteMeeting,
  testConnection: async () => ({ ok: true }),
}));

vi.mock("@/server/agenda/settings", () => ({ getSettings: async () => settings }));
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
  findSlot: async () => ({ startUtc: SLOT, endUtc: "…", label: "mié 5 ago, 09:00" }),
  computeAvailability: async () => [],
  rankStaffFreeAt: async () => [],
}));

let currentOffers: Array<{
  startUtc: string;
  label: string;
  staffId?: string | null;
  serviceId?: string | null;
  durationMinutes?: number | null;
  anyStaff?: boolean;
}> = [{ startUtc: SLOT, label: "mié 5 ago, 09:00" }];

vi.mock("@/server/agenda/offers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/agenda/offers")>();
  return {
    ...original,
    getOffers: async () => currentOffers,
    replaceOffers: async () => {},
    clearOffers: async () => {},
  };
});
vi.mock("@/server/agenda/connectors", () => ({
  bindConnector,
  markConnectorAuthError: async () => {},
}));
vi.mock("@/server/leads/stage-history", () => ({
  moveLeadToStage: async () => ({ ok: true }),
}));
vi.mock("@/server/events/bus", () => ({ publish: () => {} }));

const selectRows: unknown[][] = [];
let lastInsert: Record<string, unknown> | null = null;
/** La fila que devuelve un `update(...).returning()`. */
let updatedRow: Record<string, unknown> = {};

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "leftJoin", "innerJoin"]) c[m] = () => c;
  c.limit = () => Promise.resolve(rows);
  return c;
}

const column = (name: string) => ({ name });

vi.mock("@/lib/db", () => {
  const db = {
    select: () => chain(selectRows.shift() ?? []),
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: () => {
          lastInsert = v;
          return Promise.resolve([
            { ...v, scheduledAt: new Date(SLOT), externalRef: null, linkPending: false },
          ]);
        },
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => ({
          returning: () => Promise.resolve([{ ...updatedRow, ...v }]),
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
        contactId: column("contactId"),
      },
      staff: {
        organizationId: column("organizationId"),
        id: column("id"),
        active: column("active"),
        weeklyHours: column("weeklyHours"),
        displayName: column("displayName"),
        jobTitle: column("jobTitle"),
        position: column("position"),
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
      conversation: {
        organizationId: column("organizationId"),
        id: column("id"),
        contactId: column("contactId"),
        isTest: column("isTest"),
      },
      contact: {
        organizationId: column("organizationId"),
        id: column("id"),
        name: column("name"),
      },
      lead: {
        organizationId: column("organizationId"),
        contactId: column("contactId"),
        id: column("id"),
      },
      pipelineStage: { organizationId: column("organizationId") },
      offeredSlot: {},
    },
  };
});

const CITA_DE_PRUEBA = {
  id: "bk_test",
  organizationId: "org_1",
  scheduledAt: new Date(SLOT),
  durationMinutes: 30,
  status: "agendada",
  isTest: true,
  connector: "zoom",
  // Aunque tuviera reunión, no debe tocarse: es de prueba.
  externalRef: "zoom_viejo",
  meetingLink: null,
  linkPending: false,
  notes: null,
  contactId: "ct_1",
  staffId: "st_1",
  serviceId: "sv_1",
};

function primeCatalog(isTest: boolean) {
  selectRows.push([{ id: "st_1", active: true, weeklyHours: null }]);
  selectRows.push([
    { id: "sv_1", active: true, durationMinutes: 30, priceCents: 0, currency: "MXN" },
  ]);
  selectRows.push([{ durationMinutes: null }]);
  selectRows.push([]);
  selectRows.push([{ contactId: "ct_1", isTest }]);
  selectRows.push([{ name: isTest ? "Persona simulada" : "Cliente real" }]);
  selectRows.push([]);
}

describe("una cita del Laboratorio jamás llega al proveedor", () => {
  beforeEach(() => {
    selectRows.length = 0;
    lastInsert = null;
    currentOffers = [{ startUtc: SLOT, label: "mié 5 ago, 09:00" }];
    updatedRow = { ...CITA_DE_PRUEBA };
    createMeeting.mockClear();
    updateMeeting.mockClear();
    deleteMeeting.mockClear();
    bindConnector.mockClear();
  });

  it("al CREAR: la cita se registra como de prueba y no se crea reunión", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");
    primeCatalog(true);

    const result = await createSessionBooking({
      organizationId: "org_1",
      conversationId: "cv_lab",
      startUtc: SLOT,
      source: "ai",
      requireOffer: true,
      staffId: "st_1",
      serviceId: "sv_1",
    });

    expect(lastInsert?.isTest).toBe(true);
    expect(result.booking.isTest).toBe(true);
    // Lo que importa: ni siquiera se resolvió el conector.
    expect(bindConnector).not.toHaveBeenCalled();
    expect(createMeeting).not.toHaveBeenCalled();
  });

  it("al REPROGRAMAR: no se mueve nada en el proveedor", async () => {
    const { rescheduleBooking } = await import("@/server/agenda/service");
    selectRows.push([CITA_DE_PRUEBA]);

    await rescheduleBooking({
      organizationId: "org_1",
      bookingId: "bk_test",
      startUtc: SLOT,
    });

    expect(updateMeeting).not.toHaveBeenCalled();
    expect(bindConnector).not.toHaveBeenCalled();
  });

  it("al CANCELAR: no se borra nada en el proveedor", async () => {
    const { cancelBooking } = await import("@/server/agenda/service");
    selectRows.push([CITA_DE_PRUEBA]);

    await cancelBooking({ organizationId: "org_1", bookingId: "bk_test" });

    expect(deleteMeeting).not.toHaveBeenCalled();
    expect(bindConnector).not.toHaveBeenCalled();
  });

  it("una cita REAL sí llega al proveedor (el guardarraíl no apaga todo)", async () => {
    const { createSessionBooking } = await import("@/server/agenda/service");
    primeCatalog(false);

    await createSessionBooking({
      organizationId: "org_1",
      conversationId: "cv_real",
      startUtc: SLOT,
      source: "ai",
      requireOffer: true,
      staffId: "st_1",
      serviceId: "sv_1",
    });

    expect(createMeeting).toHaveBeenCalledOnce();
  });

  it("con profesional y servicio en la oferta, la cita de prueba tampoco llama al conector", async () => {
    const { bookFromOffer } = await import("@/server/agenda/agent");
    currentOffers = [
      {
        startUtc: SLOT,
        label: "mié 5 ago, 09:00",
        staffId: "st_1",
        serviceId: "sv_1",
        durationMinutes: 45,
        anyStaff: false,
      },
    ];
    primeCatalog(true);

    const booked = await bookFromOffer({
      organizationId: "org_1",
      conversationId: "cv_lab",
      startUtc: SLOT,
    });

    expect(booked.booking).toBeDefined();
    expect(lastInsert?.isTest).toBe(true);
    expect(lastInsert?.staffId).toBe("st_1");
    expect(lastInsert?.serviceId).toBe("sv_1");
    expect(lastInsert?.durationMinutes).toBe(45);
    expect(bindConnector).not.toHaveBeenCalled();
    expect(createMeeting).not.toHaveBeenCalled();
  });
});
