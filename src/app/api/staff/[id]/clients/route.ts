import { agendaErrorResponse, withAgenda } from "@/server/agenda/http";
import { listStaffClients } from "@/server/agenda/queries";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Clientes que ya se atendieron con este profesional. Staff solo los propios. */
export const GET = withAgenda(
  async (session, _req: Request, ctx: Params) => {
    const { id } = await ctx.params;
    try {
      const clients = await listStaffClients(session.actor, id);
      return Response.json({ clients });
    } catch (err) {
      return agendaErrorResponse(err);
    }
  },
  { allowStaff: true }
);
