import { apiError } from "@/lib/api";
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

const STAFF_SELF_KEYS = new Set(["bio", "phone", "color"]);

/**
 * Dueño: ficha completa. Staff: solo bio, phone y color, y solo la propia.
 * Cualquier otra clave es 403 antes de Zod. Recepción no entra.
 */
export const PATCH = withAgenda(
  async (session, req: Request, ctx: Params) => {
    const { id } = await ctx.params;
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return apiError(422, "invalid_body", "El body debe ser JSON válido");
    }
    if (session.actor.role === "staff") {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return apiError(422, "invalid_body", "El body debe ser JSON válido");
      }
      for (const key of Object.keys(raw)) {
        if (!STAFF_SELF_KEYS.has(key)) {
          return apiError(403, "forbidden", "Sin acceso");
        }
      }
    }
    const parsed = staffPatchSchema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
        .join("; ");
      return apiError(422, "invalid_body", detail);
    }
    try {
      const staff = await updateStaff(session.actor, id, parsed.data);
      return Response.json({ staff });
    } catch (err) {
      return agendaErrorResponse(err);
    }
  },
  { roles: ["owner"], allowStaff: true }
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
