import { parseBody } from "@/lib/api";
import { agendaErrorResponse, withAgenda } from "@/server/agenda/http";
import { createStaff, listStaff, staffInputSchema } from "@/server/agenda/staff";

export const dynamic = "force-dynamic";

/** Equipo. Staff solo ve el propio perfil; sin perfil, la lista va vacía. */
export const GET = withAgenda(
  async (session, req: Request) => {
    const includeInactive =
      new URL(req.url).searchParams.get("includeInactive") === "1";
    const staff = await listStaff(session.actor, { includeInactive });
    return Response.json({ staff });
  },
  { allowStaff: true }
);

/** Alta de profesional. Solo el dueño; recepción y staff ni parsean el cuerpo. */
export const POST = withAgenda(
  async (session, req: Request) => {
    const body = await parseBody(req, staffInputSchema);
    if (!body.ok) return body.response;
    try {
      const staff = await createStaff(
        session.actor,
        staffInputSchema.parse(body.data)
      );
      return Response.json({ staff }, { status: 201 });
    } catch (err) {
      return agendaErrorResponse(err);
    }
  },
  { roles: ["owner"] }
);
