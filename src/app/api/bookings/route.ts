import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { normalizeMx } from "@/lib/meta/client";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import { AgendaHttpError, agendaErrorResponse, bookingErrorResponse, bookingPayload } from "@/server/agenda/http";
import { getOrCreateContactByIdentity } from "@/server/inbox/identity";
import { listBookings, staffMayUseContact } from "@/server/agenda/queries";
import { createBlock, createSessionBooking } from "@/server/agenda/service";

export const dynamic = "force-dynamic";

export const GET = withAuth(
  async (session, req: Request) => {
    if (!agendaEnabled()) return agendaDisabledResponse();
    const url = new URL(req.url);
    const fromRaw = url.searchParams.get("from");
    const toRaw = url.searchParams.get("to");
    const bookings = await listBookings(session.actor, {
      from: fromRaw ? new Date(fromRaw) : undefined,
      to: toRaw ? new Date(toRaw) : undefined,
    });
    return Response.json({ bookings });
  },
  { allowStaff: true }
);

const postSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("session"),
    staffId: z.string().min(1),
    serviceId: z.string().min(1),
    contactId: z.string().min(1).optional(),
    contact: z
      .object({
        name: z.string().trim().min(1).max(120),
        phone: z.string().trim().min(5).max(40),
      })
      .optional(),
    conversationId: z.string().min(1).nullish(),
    startUtc: z.string().min(1),
    notes: z.string().nullish(),
  }),
  z.object({
    kind: z.literal("block"),
    staffId: z.string().min(1).nullable(),
    startUtc: z.string().min(1),
    durationMinutes: z.number().int().min(5).max(600),
    notes: z.string().nullish(),
  }),
]);

/**
 * El operador agenda o bloquea. Crear responde 201.
 * Staff solo escribe lo suyo; un bloqueo de todo el local es 403.
 */
export const POST = withAuth(
  async (session, req: Request) => {
    if (!agendaEnabled()) return agendaDisabledResponse();
    if (session.actor.role === "staff" && !session.actor.staffId) {
      return apiError(403, "forbidden", "Sin acceso");
    }
    const body = await parseBody(req, postSchema);
    if (!body.ok) return body.response;

    try {
      if (body.data.kind === "block") {
        if (session.actor.role === "staff") {
          if (!body.data.staffId || body.data.staffId !== session.actor.staffId) {
            return apiError(403, "forbidden", "Sin acceso");
          }
        }
        const result = await createBlock({
          organizationId: session.organizationId,
          staffId: body.data.staffId,
          startUtc: body.data.startUtc,
          durationMinutes: body.data.durationMinutes,
          notes: body.data.notes ?? null,
        });
        if (!result.block) {
          return Response.json(
            {
              error: {
                code: "slot_taken",
                message: "Hay citas en ese horario",
              },
              conflicts: result.conflicts,
            },
            { status: 409 }
          );
        }
        return Response.json(
          { booking: { id: result.block.id, durationMinutes: result.block.durationMinutes } },
          { status: 201 }
        );
      }

      if (session.actor.role === "staff" && body.data.staffId !== session.actor.staffId) {
        return apiError(403, "forbidden", "Sin acceso");
      }

      let contactId = body.data.contactId ?? null;
      if (session.actor.role === "staff" && contactId) {
        const allowed = await staffMayUseContact(session.actor, contactId);
        if (!allowed) return apiError(403, "forbidden", "Ese contacto no está en tus citas");
      }
      if (!contactId && body.data.contact) {
        const phone = normalizeMx(body.data.contact.phone);
        if (!phone) return apiError(422, "invalid_body", "Ese teléfono no es válido");
        const created = await getOrCreateContactByIdentity(session.organizationId, {
          identity: phone,
          phone,
          waUserId: null,
          profileName: body.data.contact.name,
        });
        contactId = created.contact.id;
      }
      if (!contactId) return apiError(422, "invalid_body", "Indica un contacto");

      const result = await createSessionBooking({
        organizationId: session.organizationId,
        contactId,
        conversationId: body.data.conversationId ?? null,
        startUtc: body.data.startUtc,
        notes: body.data.notes ?? null,
        source: "manual",
        requireOffer: false,
        staffId: body.data.staffId,
        serviceId: body.data.serviceId,
      });
      return Response.json(
        {
          booking: {
            id: result.booking.id,
            durationMinutes: result.booking.durationMinutes,
          },
          ...bookingPayload(result),
          durationMinutes: result.booking.durationMinutes,
        },
        { status: 201 }
      );
    } catch (err) {
      if (err instanceof AgendaHttpError) return agendaErrorResponse(err);
      return bookingErrorResponse(err);
    }
  },
  { allowStaff: true }
);
