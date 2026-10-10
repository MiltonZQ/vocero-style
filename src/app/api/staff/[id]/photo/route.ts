import { apiError } from "@/lib/api";
import { agendaErrorResponse, withAgenda } from "@/server/agenda/http";
import {
  deleteStaffPhoto,
  readStaffPhoto,
  saveStaffPhoto,
} from "@/server/agenda/photo";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

function ownStaffOrMissing(role: string, staffId: string | null, id: string): boolean {
  return role === "staff" && staffId !== id;
}

/** Bytes de la foto. Recepción puede leer; un staff solo la propia. */
export const GET = withAgenda(
  async (session, _req: Request, ctx: Params) => {
    const { id } = await ctx.params;
    try {
      const photo = await readStaffPhoto(session.actor, id);
      const body = new Uint8Array(photo.bytes.byteLength);
      body.set(photo.bytes);
      return new Response(body, {
        headers: {
          "Content-Type": photo.mime,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, max-age=86400",
        },
      });
    } catch (err) {
      return agendaErrorResponse(err);
    }
  },
  { allowStaff: true }
);

/**
 * Cuerpo crudo, sin multipart. El tipo sale de los bytes. Recepción no entra:
 * `roles: owner` más `allowStaff` la deja en 403 antes de leer el cuerpo.
 */
export const PUT = withAgenda(
  async (session, req: Request, ctx: Params) => {
    const { id } = await ctx.params;
    if (ownStaffOrMissing(session.actor.role, session.actor.staffId, id)) {
      return apiError(404, "not_found", "No encontrado");
    }
    const bytes = new Uint8Array(await req.arrayBuffer());
    try {
      const saved = await saveStaffPhoto(session.actor, id, bytes);
      return Response.json(saved);
    } catch (err) {
      return agendaErrorResponse(err);
    }
  },
  { roles: ["owner"], allowStaff: true }
);

/** Quita la fila. La versión no baja: la URL anterior no debe revivir. */
export const DELETE = withAgenda(
  async (session, _req: Request, ctx: Params) => {
    const { id } = await ctx.params;
    if (ownStaffOrMissing(session.actor.role, session.actor.staffId, id)) {
      return apiError(404, "not_found", "No encontrado");
    }
    try {
      await deleteStaffPhoto(session.actor, id);
      return new Response(null, { status: 204 });
    } catch (err) {
      return agendaErrorResponse(err);
    }
  },
  { roles: ["owner"], allowStaff: true }
);
