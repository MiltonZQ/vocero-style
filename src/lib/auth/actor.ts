import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { normalizeRole, type Role } from "@/lib/auth/roles";
import { requireSession, UnauthorizedError } from "@/lib/auth/session";

export type { Role } from "@/lib/auth/roles";
export type { SessionContext } from "@/lib/auth/session";

/**
 * Quien hace la peticion, resuelto en el SERVIDOR (D6): nada de lo que envie
 * el cliente amplia este alcance. `staffId` solo existe para `staff` con perfil
 * activo vinculado; un `staff` sin perfil queda con `staffId = null` y no ve
 * nada (FR-006).
 */
export type Actor = {
  userId: string;
  organizationId: string;
  memberId: string;
  role: Role;
  staffId: string | null;
};

/** El rol no existe o es ilegible: la cuenta no tiene acceso. */
export class ForbiddenError extends Error {
  constructor(message = "Sin acceso") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** Perfil de profesional desactivado: la cuenta deja de poder entrar (FR-004). */
export class AccountDisabledError extends Error {
  constructor(message = "Cuenta desactivada") {
    super(message);
    this.name = "AccountDisabledError";
  }
}

export async function requireActor(): Promise<Actor> {
  const session = await requireSession();
  const role = normalizeRole(session.role);
  if (!role) throw new ForbiddenError();

  const db = getDb();
  const members = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(
      scoped(
        schema.member.organizationId,
        session.organizationId,
        eq(schema.member.userId, session.userId)
      )
    )
    .limit(1);
  const memberId = members[0]?.id;
  if (!memberId) throw new UnauthorizedError("Sesión sin organización activa");

  let staffId: string | null = null;
  if (role === "staff") {
    const profiles = await db
      .select({ id: schema.staff.id, active: schema.staff.active })
      .from(schema.staff)
      .where(
        scoped(
          schema.staff.organizationId,
          session.organizationId,
          eq(schema.staff.memberId, memberId)
        )
      )
      .limit(1);
    const profile = profiles[0];
    if (profile && !profile.active) throw new AccountDisabledError();
    staffId = profile?.id ?? null;
  }

  return {
    userId: session.userId,
    organizationId: session.organizationId,
    memberId,
    role,
    staffId,
  };
}

/**
 * Guarda de PAGINA (UX, no seguridad: la proteccion real son las APIs). Un
 * `staff` va a su agenda; cualquier otro rol no autorizado, a la bandeja.
 */
export function guardPage(actor: Actor, roles: readonly Role[]): void {
  if (roles.includes(actor.role)) return;
  redirect(actor.role === "staff" ? "/my-agenda" : "/inbox");
}

/**
 * Atajo de una linea para `page.tsx` / `layout.tsx`: resuelve el actor
 * (sin sesion -> /login, cuenta desactivada -> /login) y aplica `guardPage`.
 */
export async function requirePageActor(roles: readonly Role[]): Promise<Actor> {
  let actor: Actor;
  try {
    actor = await requireActor();
  } catch (err) {
    if (
      err instanceof UnauthorizedError ||
      err instanceof ForbiddenError ||
      err instanceof AccountDisabledError
    ) {
      redirect("/login");
    }
    throw err;
  }
  guardPage(actor, roles);
  return actor;
}
