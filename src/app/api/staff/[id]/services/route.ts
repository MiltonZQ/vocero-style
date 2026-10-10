import { agendaErrorResponse, withAgenda } from "@/server/agenda/http";
import { listStaffServices } from "@/server/agenda/catalog";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Servicios que ofrece el profesional, activos o no. Staff solo los propios. */
export const GET = withAgenda(
  async (session, _req: Request, ctx: Params) => {
    const { id } = await ctx.params;
    try {
      const services = await listStaffServices(session.actor, id);
      return Response.json({ services });
    } catch (err) {
      return agendaErrorResponse(err);
    }
  },
  { allowStaff: true }
);
