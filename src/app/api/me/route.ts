import { eq } from "drizzle-orm";
import { apiError, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { agendaEnabled } from "@/server/agenda/flag";

export const dynamic = "force-dynamic";

/**
 * 018 — Quién soy y qué rol tengo, para que el cliente arme su navegación.
 * NO es fuente de autorización: el servidor re-valida en cada ruta. A
 * diferencia del resto de la agenda, con la bandera apagada NO responde 404:
 * informa `agendaEnabled: false`.
 */
export const GET = withAuth(
  async (session) => {
    const { actor } = session;
    const rows = await getDb()
      .select({
        id: schema.user.id,
        name: schema.user.name,
        email: schema.user.email,
      })
      .from(schema.user)
      .where(eq(schema.user.id, actor.userId))
      .limit(1);
    const user = rows[0];
    if (!user) return apiError(401, "unauthorized", "No autenticado");
    return Response.json({
      user: { id: user.id, name: user.name, email: user.email },
      role: actor.role,
      staffId: actor.staffId,
      agendaEnabled: agendaEnabled(),
    });
  },
  { allowStaff: true }
);
