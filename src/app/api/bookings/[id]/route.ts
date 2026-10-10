import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import { AgendaHttpError, agendaErrorResponse, bookingErrorResponse } from "@/server/agenda/http";
import { getBooking } from "@/server/agenda/queries";
import {
  cancelBooking,
  markBookingStatus,
  reassignBooking,
  rescheduleBooking,
  retryMeetingLink,
} from "@/server/agenda/service";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reschedule"), startUtc: z.string().min(1) }),
  z.object({
    action: z.literal("reassign"),
    staffId: z.string().min(1),
    keepDuration: z.boolean().optional(),
  }),
  z.object({ action: z.literal("cancel") }),
  z.object({
    action: z.literal("status"),
    status: z.enum(["realizada", "no_show"]),
  }),
  z.object({ action: z.literal("retry_link") }),
]);

function missing(): Response {
  return new Response(null, { status: 404 });
}

/** Ficha. Un id fuera de alcance es 404 sin cuerpo. */
export const GET = withAuth(
  async (session, _req: Request, ctx: Params) => {
    if (!agendaEnabled()) return agendaDisabledResponse();
    const { id } = await ctx.params;
    const booking = await getBooking(session.actor, id);
    if (!booking) return missing();
    return Response.json({ booking });
  },
  { allowStaff: true }
);

/**
 * Reprogramar, reasignar, cancelar, marcar o reintentar el enlace.
 * Staff no reasigna. Una cita ajena no se toca y responde 404.
 */
export const PATCH = withAuth(
  async (session, req: Request, ctx: Params) => {
    if (!agendaEnabled()) return agendaDisabledResponse();
    const { id } = await ctx.params;
    const body = await parseBody(req, patchSchema);
    if (!body.ok) return body.response;

    const existing = await getBooking(session.actor, id);
    if (!existing) return missing();
    if (
      session.actor.role === "staff" &&
      existing.staff?.id !== session.actor.staffId
    ) {
      return missing();
    }
    if (body.data.action === "reassign" && session.actor.role === "staff") {
      return apiError(403, "forbidden", "Sin acceso");
    }

    try {
      switch (body.data.action) {
        case "reschedule": {
          const result = await rescheduleBooking({
            organizationId: session.organizationId,
            bookingId: id,
            startUtc: body.data.startUtc,
          });
          return Response.json({ ok: true, label: result.label });
        }
        case "reassign": {
          const result = await reassignBooking({
            organizationId: session.organizationId,
            bookingId: id,
            staffId: body.data.staffId,
            keepDuration: body.data.keepDuration ?? true,
          });
          return Response.json({ ok: true, label: result.label, staffId: result.booking.staffId });
        }
        case "cancel": {
          await cancelBooking({
            organizationId: session.organizationId,
            bookingId: id,
          });
          return Response.json({ ok: true });
        }
        case "status": {
          await markBookingStatus({
            organizationId: session.organizationId,
            bookingId: id,
            status: body.data.status,
          });
          return Response.json({ ok: true });
        }
        case "retry_link": {
          const result = await retryMeetingLink({
            organizationId: session.organizationId,
            bookingId: id,
          });
          return Response.json({
            ok: true,
            meetingLink: result.meetingLink,
            linkPending: result.linkPending,
          });
        }
      }
    } catch (err) {
      if (err instanceof AgendaHttpError) return agendaErrorResponse(err);
      return bookingErrorResponse(err);
    }
  },
  { allowStaff: true }
);
