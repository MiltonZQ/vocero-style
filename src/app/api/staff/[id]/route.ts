import { parseBody } from "@/lib/api";
import { agendaErrorResponse, withAgenda } from "@/server/agenda/http";
import {
  deleteStaff,
  getStaff,
  staffPatchSchema,
  updateStaff,
} from "@/server/agenda/staff";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Ficha. Staff solo la propia; cualquier otro id es 404. */
export const GET = withAgenda(
  async (session, _req: Request, ctx: Params) => {
    const { id } = await ctx.params;
    try {
      const detail = await getStaff(session.actor, id);
      return Response.json(detail);
    } catch (err) {
      return agendaErrorResponse(err);
    }
  },
  { allowStaff: true }
);

/**
 * Edición del dueño, incluido `active`. El subconjunto del propio staff
 * llega en una slice posterior: aquí recepción y staff reciben 403 antes
 * de leer el cuerpo.
 */
export const PATCH = withAgenda(
  async (session, req: Request, ctx: Params) => {
    const { id } = await ctx.params;
    const body = await parseBody(req, staffPatchSchema);
    if (!body.ok) return body.response;
    try {
      const staff = await updateStaff(
        session.actor,
        id,
        staffPatchSchema.parse(body.data)
      );
      return Response.json({ staff });
    } catch (err) {
      return agendaErrorResponse(err);
    }
  },
  { roles: ["owner"] }
);

export const DELETE = withAgenda(
  async (session, _req: Request, ctx: Params) => {
    const { id } = await ctx.params;
    try {
      await deleteStaff(session.actor, id);
      return new Response(null, { status: 204 });
    } catch (err) {
      return agendaErrorResponse(err);
    }
  },
  { roles: ["owner"] }
);
