import { eq } from "drizzle-orm";
import type { Actor } from "@/lib/auth/actor";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { WEEKDAYS, type Interval } from "@/lib/time/slots";
import { assertOwnStaff } from "@/server/agenda/catalog";
import { AgendaHttpError } from "@/server/agenda/http";
import {
  getSettings,
  normalizeWeeklyHours,
  type WeeklyHours,
} from "@/server/agenda/settings";

/**
 * Horario que rige para un profesional.
 *
 * `null` hereda el del local: se devuelve el mismo objeto, sin copiarlo.
 * Un horario propio se recorta a la apertura al calcular (D13): nunca la
 * excede, y un día sin solape desaparece. Lo guardado puede ser más amplio;
 * si el local abre más tarde, no hay que reeditar.
 */

export type EffectiveHours = {
  weeklyHours: WeeklyHours;
  inherits: boolean;
};

function toMinutes(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

function fromMinutes(total: number): string {
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Recorta cada franja del profesional a cada franja del local. Sin solape, se cae. */
function clipDay(staff: Interval[], shop: Interval[]): Interval[] {
  const clipped: Interval[] = [];
  for (const staffInterval of staff) {
    const staffStart = toMinutes(staffInterval.start);
    const staffEnd = toMinutes(staffInterval.end);
    for (const shopInterval of shop) {
      const start = Math.max(staffStart, toMinutes(shopInterval.start));
      const end = Math.min(staffEnd, toMinutes(shopInterval.end));
      if (start < end) {
        clipped.push({ start: fromMinutes(start), end: fromMinutes(end) });
      }
    }
  }
  clipped.sort((left, right) => left.start.localeCompare(right.start));
  return clipped;
}

export function effectiveHours(
  staffHours: WeeklyHours | null,
  shopHours: WeeklyHours
): EffectiveHours {
  if (staffHours === null) {
    return { weeklyHours: shopHours, inherits: true };
  }

  const weeklyHours: WeeklyHours = {};
  for (const day of WEEKDAYS) {
    const staffDay = staffHours[day];
    const shopDay = shopHours[day];
    if (!staffDay || !shopDay) continue;
    const clipped = clipDay(staffDay, shopDay);
    if (clipped.length > 0) weeklyHours[day] = clipped;
  }
  return { weeklyHours, inherits: false };
}

export type StaffHoursView = {
  weeklyHours: WeeklyHours | null;
  effectiveWeeklyHours: WeeklyHours;
  inheritsShopHours: boolean;
};

function storedWeeklyHours(value: unknown): WeeklyHours | null {
  if (value == null) return null;
  const hours = normalizeWeeklyHours(value);
  return Object.keys(hours).length > 0 ? hours : null;
}

function toView(stored: WeeklyHours | null, shopHours: WeeklyHours): StaffHoursView {
  const effective = effectiveHours(stored, shopHours);
  return {
    weeklyHours: stored,
    effectiveWeeklyHours: effective.weeklyHours,
    inheritsShopHours: effective.inherits,
  };
}

async function requireStaff(actor: Actor, staffId: string): Promise<void> {
  assertOwnStaff(actor, staffId);
  const db = getDb();
  const rows = await db
    .select({ id: schema.staff.id })
    .from(schema.staff)
    .where(
      scoped(
        schema.staff.organizationId,
        actor.organizationId,
        eq(schema.staff.id, staffId)
      )
    )
    .limit(1);
  if (!rows[0]) throw new AgendaHttpError("not_found", "No encontrado");
}

export async function getStaffHours(
  actor: Actor,
  staffId: string
): Promise<StaffHoursView> {
  assertOwnStaff(actor, staffId);
  const db = getDb();
  const rows = await db
    .select({ weeklyHours: schema.staff.weeklyHours })
    .from(schema.staff)
    .where(
      scoped(
        schema.staff.organizationId,
        actor.organizationId,
        eq(schema.staff.id, staffId)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new AgendaHttpError("not_found", "No encontrado");
  const settings = await getSettings(actor.organizationId);
  return toView(storedWeeklyHours(row.weeklyHours), settings.weeklyHours);
}

export async function putStaffHours(
  actor: Actor,
  staffId: string,
  weeklyHours: unknown | null
): Promise<StaffHoursView> {
  if (actor.role === "reception") {
    throw new AgendaHttpError("forbidden", "La recepción no edita horarios");
  }
  await requireStaff(actor, staffId);
  // `null` (o un cuerpo que no deja ninguna franja válida) vuelve a heredar.
  // Nunca se copia el horario del local a la fila.
  const stored = storedWeeklyHours(weeklyHours);
  const db = getDb();
  await db
    .update(schema.staff)
    .set({ weeklyHours: stored, updatedAt: new Date() })
    .where(
      scoped(
        schema.staff.organizationId,
        actor.organizationId,
        eq(schema.staff.id, staffId)
      )
    );
  const settings = await getSettings(actor.organizationId);
  return toView(stored, settings.weeklyHours);
}
