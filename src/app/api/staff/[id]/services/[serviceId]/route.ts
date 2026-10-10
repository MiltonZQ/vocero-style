import { z } from "zod";
import { apiError } from "@/lib/api";
import {
  PutStaffService,
  deleteStaffService,
  putStaffService,
  rejectStaffPriceEdit,
} from "@/server/agenda/catalog";
import { agendaErrorResponse, withAgenda } from "@/server/agenda/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; serviceId: string }> };

function invalidBody(error: z.ZodError): Response {
  const detail = error.issues
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
  return apiError(422, "invalid_body", detail);
}

/**
 * Marca el servicio (idempotente). Recepción no entra. Un staff con una
 * clave distinta de `durationMinutes` recibe 403 antes de Zod.
 */
export const PUT = withAgenda(
  async (session, req: Request, ctx: Params) => {
    const { id, serviceId } = await ctx.params;
    if (session.actor.role === "staff" && session.actor.staffId !== id) {
      return apiError(404, "not_found", "No encontrado");
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return apiError(422, "invalid_body", "El body debe ser JSON válido");
    }
    const denied = rejectStaffPriceEdit(session.actor.role, raw);
    if (denied) return apiError(403, "forbidden", denied.message);

    const parsed = PutStaffService.safeParse(raw);
    if (!parsed.success) return invalidBody(parsed.error);

    try {
      const service = await putStaffService(
        session.actor,
        id,
        serviceId,
        parsed.data
      );
      return Response.json({ service });
    } catch (err) {
      return agendaErrorResponse(err);
    }
  },
  { roles: ["owner"], allowStaff: true }
);

/** Deja de ofrecerlo. No reescribe las citas ya agendadas. */
export const DELETE = withAgenda(
  async (session, _req: Request, ctx: Params) => {
    const { id, serviceId } = await ctx.params;
    try {
      await deleteStaffService(session.actor, id, serviceId);
      return new Response(null, { status: 204 });
    } catch (err) {
      return agendaErrorResponse(err);
    }
  },
  { roles: ["owner"], allowStaff: true }
);
