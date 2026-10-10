import { parseBody } from "@/lib/api";
import {
  createService,
  listServices,
  serviceInputSchema,
} from "@/server/agenda/catalog";
import { agendaErrorResponse, withAgenda } from "@/server/agenda/http";

export const dynamic = "force-dynamic";

/** Catálogo. Staff solo ve activos, y solo lectura. */
export const GET = withAgenda(
  async (session, req: Request) => {
    const includeInactive =
      new URL(req.url).searchParams.get("includeInactive") === "1";
    const services = await listServices(session.actor, { includeInactive });
    return Response.json({ services });
  },
  { allowStaff: true }
);

/** Alta. Recepción y staff reciben 403 antes de parsear el cuerpo. */
export const POST = withAgenda(
  async (session, req: Request) => {
    const body = await parseBody(req, serviceInputSchema);
    if (!body.ok) return body.response;
    try {
      const service = await createService(
        session.actor,
        serviceInputSchema.parse(body.data)
      );
      return Response.json({ service }, { status: 201 });
    } catch (err) {
      return agendaErrorResponse(err);
    }
  },
  { roles: ["owner"] }
);
