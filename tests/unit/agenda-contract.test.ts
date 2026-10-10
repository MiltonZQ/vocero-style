import { describe, expect, it } from "vitest";
import { agentActionSchema } from "@/server/ai/actions";
import { buildAgentSystemPrompt } from "@/server/ai/prompts";
import type { OfferedSlot } from "@/server/agenda/offers";
import {
  bookingErrorResponse,
  bookingErrorStatus,
  bookingPayload,
} from "@/server/agenda/http";
import { BookingError } from "@/server/agenda/service";
import { agendaDisabledResponse } from "@/server/agenda/flag";

/**
 * 015 — El CONTRATO observable de la agenda, fijado en un test.
 *
 * No es purismo REST: los dos fallos que esto previene ocurrieron en
 * producción y ninguno lo detectaron los mocks, porque los mocks respondían
 * otra cosa que el servidor real. Aquí el cliente y el servidor miran la misma
 * definición.
 */

const result = {
  booking: { id: "bk_123" },
  meetingLink: "https://meet.ejemplo.com/sala",
  linkPending: false,
  label: "mié 5 ago, 09:00",
} as never;

describe("cuerpo de una reserva creada", () => {
  it("lleva el id, el enlace, si el enlace está pendiente y la etiqueta", () => {
    expect(bookingPayload(result)).toEqual({
      bookingId: "bk_123",
      meetingLink: "https://meet.ejemplo.com/sala",
      linkPending: false,
      label: "mié 5 ago, 09:00",
    });
  });

  it("`linkPending` viaja SIEMPRE: es lo que decide si se promete el enlace", () => {
    const pendiente = bookingPayload({
      ...(result as object),
      meetingLink: null,
      linkPending: true,
    } as never);
    expect(pendiente.meetingLink).toBeNull();
    expect(pendiente.linkPending).toBe(true);
  });
});

describe("códigos de estado", () => {
  it("los conflictos de hueco son 409, no 400", () => {
    expect(bookingErrorStatus("slot_taken")).toBe(409);
    expect(bookingErrorStatus("slot_not_offered")).toBe(409);
  });

  it("no encontrado es 404 y payload inválido 422", () => {
    expect(bookingErrorStatus("not_found")).toBe(404);
    expect(bookingErrorStatus("invalid")).toBe(422);
  });
});

describe("forma del error", () => {
  it("el sobre va ANIDADO y `slots` es HERMANO de `error`", async () => {
    const slots = [{ startUtc: "2026-08-05T15:30:00.000Z", label: "mié 5 ago, 09:30" }];
    const res = bookingErrorResponse(
      new BookingError("slot_taken", "Ese horario acaba de ocuparse", slots)
    );
    expect(res.status).toBe(409);

    const body = (await res.json()) as {
      error: { code: string; message: string };
      slots: { label: string }[];
    };
    // Anidado: un mock con la forma plana `{code}` hizo que todo 409 se leyera
    // como conflicto genérico y el camino de re-oferta nunca se activara.
    expect(body.error.code).toBe("slot_taken");
    expect(body.error.message).toContain("ocuparse");
    // Hermano: es lo que el cliente usa para re-ofrecer sin otra ida y vuelta.
    expect(body.slots).toHaveLength(1);
    expect(body.slots[0]!.label).toBe("mié 5 ago, 09:30");
  });

  it("`invalid` sale como `invalid_body`, el código que ya usa el resto de la API", async () => {
    const res = bookingErrorResponse(new BookingError("invalid", "Instante inválido"));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_body");
  });

  it("un error que no es del dominio se relanza en vez de disfrazarse de 409", () => {
    expect(() => bookingErrorResponse(new Error("se cayó la base"))).toThrow(
      "se cayó la base"
    );
  });
});

describe("la agenda apagada", () => {
  it("responde 404 sin cuerpo: ese endpoint no existe en esta instancia", () => {
    const res = agendaDisabledResponse();
    // 404 y no 403: un 403 confirmaría que la agenda existe pero está vedada.
    expect(res.status).toBe(404);
  });
});

const profile = {
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
};

const catalog = {
  services: [
    {
      name: "Corte clásico",
      durationMinutes: 30,
      priceCents: 15000,
      currency: "MXN",
      staff: [{ displayName: "Ana Catalogo", jobTitle: "barbero" }],
    },
  ],
};

describe("esquema y prompt del agente", () => {
  it("con la bandera apagada el esquema no acepta la agenda", () => {
    const off = agentActionSchema(false);
    expect(off.safeParse({ action: "offer_slots", service: "Corte", staff: "Ana" }).success).toBe(
      false
    );
    expect(off.safeParse({ action: "book_slot", startUtc: "2026-08-05T15:00:00.000Z" }).success).toBe(
      false
    );
    expect(off.safeParse({ action: "reply", text: "hola" }).success).toBe(true);
  });

  it("offer_slots gana service y staff opcionales; book_slot no cambia de entrada", () => {
    const on = agentActionSchema(true);
    expect(on.safeParse({ action: "offer_slots" }).success).toBe(true);
    expect(
      on.safeParse({ action: "offer_slots", service: "Corte clásico", staff: "Ana", reply: "hola" })
        .success
    ).toBe(true);
    const booked = on.safeParse({
      action: "book_slot",
      startUtc: "2026-08-05T15:00:00.000Z",
      reply: "ok",
    });
    expect(booked.success).toBe(true);
    if (booked.success && booked.data.action === "book_slot") {
      expect(booked.data).toEqual({
        action: "book_slot",
        startUtc: "2026-08-05T15:00:00.000Z",
        reply: "ok",
      });
    }
  });

  it("con la bandera apagada el prompt no gasta tokens de agenda ni de catálogo", () => {
    const off = buildAgentSystemPrompt({
      profile,
      kb: [],
      stages: [{ name: "Nuevo" }],
      agenda: false,
      catalog,
    });
    expect(off).not.toContain("offer_slots");
    expect(off).not.toContain("book_slot");
    expect(off).not.toContain("Ana Catalogo");
    expect(off).not.toContain("Corte clásico");
    expect(off).not.toContain("Catálogo de la agenda");
  });

  it("OfferedSlot lleva profesional, servicio, duración y cualquiera", () => {
    const slot: OfferedSlot = {
      startUtc: "2026-09-07T15:00:00.000Z",
      label: "lun 7 sep, 09:00",
      staffId: "st_1",
      serviceId: "sv_1",
      durationMinutes: 45,
      anyStaff: false,
      staffName: "Ana",
    };
    expect(slot).toMatchObject({
      staffId: "st_1",
      serviceId: "sv_1",
      durationMinutes: 45,
      anyStaff: false,
      staffName: "Ana",
    });
  });
});
