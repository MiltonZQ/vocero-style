import { z } from "zod";
import { apiError, parseBody } from "@/lib/api";
import { getStaffHours, putStaffHours } from "@/server/agenda/hours";
import { agendaErrorResponse, withAgenda } from "@/server/agenda/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const hoursPutSchema = z
  .object({
    weeklyHours: z.union([z.record(z.string(), z.unknown()), z.null()]),
  })
  .strict();

/** Horario guardado y el efectivo (recortado al local). Staff solo el propio. */
export const GET = withAgenda(
  async (session, _req: Request, ctx: Params) => {
    const { id } = await ctx.params;
    try {
      const hours = await getStaffHours(session.actor, id);
      return Response.json(hours);
    } catch (err) {
      return agendaErrorResponse(err);
    }
  },
  { allowStaff: true }
);

/**
 * Dueño o el propio profesional. Recepción recibe 403 antes del cuerpo.
 * `weeklyHours: null` vuelve a heredar el horario del local.
 */
export const PUT = withAgenda(
  async (session, req: Request, ctx: Params) => {
    const { id } = await ctx.params;
    if (session.actor.role === "staff" && session.actor.staffId !== id) {
      return apiError(404, "not_found", "No encontrado");
    }
    if (session.actor.role === "reception") {
      return apiError(403, "forbidden", "La recepción no edita horarios");
    }
    const body = await parseBody(req, hoursPutSchema);
    if (!body.ok) return body.response;
    try {
      const hours = await putStaffHours(
        session.actor,
        id,
        body.data.weeklyHours
      );
      return Response.json(hours);
    } catch (err) {
      return agendaErrorResponse(err);
    }
  },
  { roles: ["owner"], allowStaff: true }
);
