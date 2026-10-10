import { parseBody } from "@/lib/api";
import { agendaErrorResponse, withAgenda } from "@/server/agenda/http";
import {
  accountInputSchema,
  linkAccount,
  unlinkAccount,
} from "@/server/agenda/staff";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Crea la cuenta `staff` y la vincula al perfil. Solo el dueño. */
export const POST = withAgenda(
  async (session, req: Request, ctx: Params) => {
    const { id } = await ctx.params;
    const body = await parseBody(req, accountInputSchema);
    if (!body.ok) return body.response;
    try {
      await linkAccount(
        session.actor,
        id,
        accountInputSchema.parse(body.data)
      );
      return Response.json({ ok: true }, { status: 201 });
    } catch (err) {
      return agendaErrorResponse(err);
    }
  },
  { roles: ["owner"] }
);

/** Desvincula y retira la membresía. El usuario conserva su historial. */
export const DELETE = withAgenda(
  async (session, _req: Request, ctx: Params) => {
    const { id } = await ctx.params;
    try {
      await unlinkAccount(session.actor, id);
      return new Response(null, { status: 204 });
    } catch (err) {
      return agendaErrorResponse(err);
    }
  },
  { roles: ["owner"] }
);
