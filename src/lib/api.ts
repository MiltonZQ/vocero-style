import { z } from "zod";
import {
  AccountDisabledError,
  ForbiddenError,
  requireActor,
  type Actor,
} from "@/lib/auth/actor";
import type { Role } from "@/lib/auth/roles";
import { UnauthorizedError, type SessionContext } from "@/lib/auth/session";

/** Respuesta de error estándar de la API interna (contrato api.md). */
export function apiError(
  status: number,
  code: string,
  message: string
): Response {
  return Response.json({ error: { code, message } }, { status });
}

export type ActorSession = SessionContext & { actor: Actor };

export type WithAuthOptions = {
  /** Restringe el acceso a estos roles (ademas del deny-by-default de staff). */
  roles?: readonly Role[];
  /** Declara que la ruta es segura para `staff` (su propio alcance). */
  allowStaff?: boolean;
};

/**
 * Envuelve un route handler autenticado: resuelve el actor (401 si no hay
 * sesion), captura errores no controlados (500 sin stack) y deja pasar
 * Response.
 *
 * DENY-BY-DEFAULT (018, D6): un `staff` recibe 403 en cualquier ruta que no
 * declare `{ allowStaff: true }`; una ruta nueva nace cerrada para el. `roles`
 * restringe ademas a un subconjunto (p. ej. `["owner"]`). Una cuenta con el
 * perfil desactivado recibe 403 `account_disabled` en todo.
 */
export function withAuth<Args extends unknown[]>(
  handler: (session: ActorSession, ...args: Args) => Promise<Response>,
  opts: WithAuthOptions = {}
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    let actor: Actor;
    let session: SessionContext;
    try {
      actor = await requireActor();
      session = {
        userId: actor.userId,
        organizationId: actor.organizationId,
        role: actor.role,
      };
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        return apiError(401, "unauthorized", "No autenticado");
      }
      if (err instanceof AccountDisabledError) {
        return apiError(403, "account_disabled", "Cuenta desactivada");
      }
      if (err instanceof ForbiddenError) {
        return apiError(403, "forbidden", "Sin acceso");
      }
      throw err;
    }
    const staffAllowed = opts.allowStaff === true;
    if (actor.role === "staff" && !staffAllowed) {
      return apiError(403, "forbidden", "Sin acceso");
    }
    if (
      opts.roles &&
      !opts.roles.includes(actor.role) &&
      !(actor.role === "staff" && staffAllowed)
    ) {
      return apiError(403, "forbidden", "Sin acceso");
    }
    try {
      return await handler({ ...session, actor }, ...args);
    } catch (err) {
      console.error("[api] error no controlado:", err);
      return apiError(500, "internal", "Error interno");
    }
  };
}

/** Parsea el body JSON con un esquema Zod; inválido → Response 422. */
export async function parseBody<T>(
  req: Request,
  schema: z.ZodType<T>
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return {
      ok: false,
      response: apiError(422, "invalid_body", "El body debe ser JSON válido"),
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
      .join("; ");
    return {
      ok: false,
      response: apiError(422, "invalid_body", detail),
    };
  }
  return { ok: true, data: parsed.data };
}
