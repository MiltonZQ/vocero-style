import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Actor } from "@/lib/auth/actor";
import { apiError } from "@/lib/api";
import { booking } from "@/lib/db/schema";

/**
 * 018 (D6) — alcance de las citas por actor. Se COMPONE con `scoped()` de
 * `src/lib/db/tenant.ts` (que aporta el tenant), no lo sustituye:
 *
 *   scoped(booking.organizationId, actor.organizationId, bookingScope(actor), …)
 *
 * - owner / reception: `undefined` (todo el tenant).
 * - staff con perfil: las propias + los bloqueos del local (los debe ver).
 * - staff sin perfil: `false` (no ve nada, FR-006).
 */
export function bookingScope(actor: Actor): SQL | undefined {
  if (actor.role !== "staff") return undefined;
  if (!actor.staffId) return sql`false`;
  return or(
    eq(booking.staffId, actor.staffId),
    and(eq(booking.kind, "block"), isNull(booking.staffId))
  );
}

/** La cita (o bloqueo) existe pero no es del actor. */
export class OutOfScopeError extends Error {
  constructor(message = "Fuera de alcance") {
    super(message);
    this.name = "OutOfScopeError";
  }
}

/**
 * owner / reception escriben todo; staff solo lo suyo. Los bloqueos del local
 * (`staffId` nulo) no son editables por staff.
 */
export function assertCanWriteBooking(
  actor: Actor,
  target: { staffId: string | null; kind: "session" | "block" }
): void {
  if (actor.role !== "staff") return;
  if (actor.staffId && target.staffId === actor.staffId) return;
  throw new OutOfScopeError();
}

/**
 * Recurso ajeno por id -> 404, no 403: no se confirma que exista (FR-005).
 * 403 queda para superficies/acciones vedadas por rol.
 */
export function denyOutOfScope(): Response {
  return apiError(404, "not_found", "No encontrado");
}
