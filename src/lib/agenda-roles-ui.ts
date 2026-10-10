import type { Role } from "@/lib/auth/roles";

/**
 * 018 — Entradas de navegación por rol. Compartido servidor/cliente: solo
 * datos y funciones puras (sin variables de entorno ni BD). Es UX, no
 * seguridad: las APIs re-validan el rol en cada ruta.
 */
export type NavKey =
  | "inbox"
  | "pipeline"
  | "contacts"
  | "bookings"
  | "calendar"
  | "agent"
  | "lab"
  | "settings"
  | "my-agenda"
  | "my-profile";

const MANAGER_NAV: readonly NavKey[] = [
  "inbox",
  "pipeline",
  "contacts",
  "bookings",
  "calendar",
  "agent",
  "lab",
  "settings",
];

/** El staff solo ve «Mi agenda» y «Mi perfil»: nada de bandeja, leads ni Lab. */
const STAFF_NAV: readonly NavKey[] = ["my-agenda", "my-profile"];

/** Las entradas de agenda existen solo con la bandera encendida. */
const AGENDA_KEYS: ReadonlySet<NavKey> = new Set([
  "bookings",
  "calendar",
  "my-agenda",
  "my-profile",
]);

export function navKeysFor(role: Role, agendaEnabled: boolean): NavKey[] {
  const base = role === "staff" ? STAFF_NAV : MANAGER_NAV;
  return base.filter((k) => agendaEnabled || !AGENDA_KEYS.has(k));
}
