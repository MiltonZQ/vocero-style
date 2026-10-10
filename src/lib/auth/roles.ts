/**
 * 018 (D5) — rol de acceso de una cuenta de equipo.
 *
 * Vive en `member.role` (texto de Better Auth) sin tocar el esquema. El valor
 * legado `member` —todas las cuentas de equipo previas— se LEE como
 * `reception` sin reescribir filas. El oficio (`job_title`) es dato de perfil:
 * jamas otorga ni quita un permiso.
 */

export type Role = "owner" | "reception" | "staff";

const ROLES: ReadonlySet<string> = new Set(["owner", "reception", "staff"]);

/**
 * Normaliza el texto crudo de `member.role`. Lo desconocido devuelve `null`
 * (sin acceso): nunca se asume owner por defecto.
 */
export function normalizeRole(raw: string | null | undefined): Role | null {
  if (raw === "member") return "reception";
  if (raw && ROLES.has(raw)) return raw as Role;
  return null;
}

export type Capability =
  | "calendar.global"
  | "booking.manage_any"
  | "catalog.read"
  | "catalog.write"
  | "staff_services.manage_any"
  | "team.manage"
  | "hours.manage_all"
  | "blocks.shop"
  | "inbox"
  | "sse.all";

/** Matriz de permisos (data-model.md). Referencia; las rutas la aplican. */
const MATRIX: Record<Capability, ReadonlySet<Role>> = {
  "calendar.global": new Set(["owner", "reception"]),
  "booking.manage_any": new Set(["owner", "reception"]),
  "catalog.read": new Set(["owner", "reception", "staff"]),
  "catalog.write": new Set(["owner"]),
  "staff_services.manage_any": new Set(["owner"]),
  "team.manage": new Set(["owner"]),
  "hours.manage_all": new Set(["owner"]),
  "blocks.shop": new Set(["owner", "reception"]),
  // Bandeja, conversaciones, contactos, leads, Laboratorio y ajustes.
  inbox: new Set(["owner", "reception"]),
  "sse.all": new Set(["owner", "reception"]),
};

export function can(role: Role | null, capability: Capability): boolean {
  return role !== null && MATRIX[capability].has(role);
}

/**
 * Defensa en profundidad (research D5): el catch-all `/api/auth/*` de Better
 * Auth expone los endpoints del plugin de organizacion a cualquier sesion.
 * Un `staff` (o una cuenta con rol ilegible) no puede mutarlos.
 * `path` es el path interno del endpoint (sin el prefijo `/api/auth`).
 */
export function isOrgMutationBlocked(
  path: string,
  method: string,
  role: Role | null
): boolean {
  if (!path.startsWith("/organization/")) return false;
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") return false;
  return role === "staff" || role === null;
}
