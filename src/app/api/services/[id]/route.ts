import { parseBody } from "@/lib/api";
import {
  deleteService,
  servicePatchSchema,
  updateService,
} from "@/server/agenda/catalog";
import { agendaErrorResponse, withAgenda } from "@/server/agenda/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Edición del catálogo, incluido el precio. Solo el dueño. */
export const PATCH = withAgenda(
  async (session, req: Request, ctx: Params) => {
    const { id } = await ctx.params;
    const body = await parseBody(req, servicePatchSchema);
    if (!body.ok) return body.response;
    try {
      const service = await updateService(
        session.actor,
        id,
        servicePatchSchema.parse(body.data)
      );
      return Response.json({ service });
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
      await deleteService(session.actor, id);
      return new Response(null, { status: 204 });
    } catch (err) {
      return agendaErrorResponse(err);
    }
  },
  { roles: ["owner"] }
);
