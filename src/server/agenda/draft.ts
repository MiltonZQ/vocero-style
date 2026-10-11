import { and, eq, lt } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";

/**
 * 019 — Borrador de reserva del bot (una fila por conversación).
 *
 * Guarda lo que el cliente ya decidió; el paso se DERIVA de aquí, nunca se
 * guarda como verdad. Un borrador sin actividad por 24 h se descarta.
 */

export type DraftWhen = { day?: string; from?: string; to?: string };

export type BookingDraft = {
  serviceId: string | null;
  /** Id de profesional, el literal `any` o null. */
  staffChoice: string | null;
  when: DraftWhen | null;
  stuckTurns: number;
  failedTurns: number;
  lastStep: string | null;
  updatedAt: Date;
};

/** Campos que el llamador puede cambiar; `null` borra el valor. */
export type DraftPatch = Partial<Omit<BookingDraft, "updatedAt">>;

export type DraftStep = "need_service" | "need_staff" | "need_slot" | "ready";

export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

/** `getDb()` por defecto; los tests inyectan una BD efímera. */
export type DraftDb = ReturnType<typeof getDb>;

/**
 * Regla del paso: primero servicio, luego profesional, luego horario.
 * `ready` no se deduce del borrador (la preferencia de horario es opcional):
 * se alcanza cuando ya hay ofertas vigentes, que el llamador informa con
 * `hasOffers`. Una oferta nunca salta un paso faltante.
 */
export function deriveStep(
  draft: Pick<BookingDraft, "serviceId" | "staffChoice">,
  opts: { hasOffers?: boolean } = {}
): DraftStep {
  if (!draft.serviceId) return "need_service";
  if (!draft.staffChoice) return "need_staff";
  return opts.hasOffers ? "ready" : "need_slot";
}

function isExpired(updatedAt: Date, now: Date): boolean {
  return now.getTime() - updatedAt.getTime() > DRAFT_TTL_MS;
}

function conversationFilter(organizationId: string, conversationId: string) {
  return scoped(
    schema.bookingDraft.organizationId,
    organizationId,
    eq(schema.bookingDraft.conversationId, conversationId)
  );
}

/** El borrador vigente, o null si no existe o caducó (y entonces se borra). */
export async function getDraft(
  organizationId: string,
  conversationId: string,
  db: DraftDb = getDb(),
  now: Date = new Date()
): Promise<BookingDraft | null> {
  const [row] = await db
    .select()
    .from(schema.bookingDraft)
    .where(conversationFilter(organizationId, conversationId))
    .limit(1);
  if (!row) return null;
  if (isExpired(row.updatedAt, now)) {
    await clearDraft(organizationId, conversationId, db);
    return null;
  }
  return {
    serviceId: row.serviceId,
    staffChoice: row.staffChoice,
    when: row.when ?? null,
    stuckTurns: row.stuckTurns,
    failedTurns: row.failedTurns,
    lastStep: row.lastStep,
    updatedAt: row.updatedAt,
  };
}

/**
 * Actualización parcial: solo cambia las claves presentes en `patch`. Sobre un
 * borrador caducado empieza de cero.
 */
export async function upsertDraft(
  organizationId: string,
  conversationId: string,
  patch: DraftPatch,
  db: DraftDb = getDb()
): Promise<void> {
  const now = new Date();
  await db
    .delete(schema.bookingDraft)
    .where(
      and(
        conversationFilter(organizationId, conversationId),
        lt(schema.bookingDraft.updatedAt, new Date(now.getTime() - DRAFT_TTL_MS))
      )
    );
  // `undefined` se ignora en el SET de Drizzle; `null` sí escribe NULL.
  await db
    .insert(schema.bookingDraft)
    .values({
      id: newId("bookingDraft"),
      organizationId,
      conversationId,
      ...patch,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.bookingDraft.conversationId,
      set: { ...patch, updatedAt: now },
    });
}

export async function clearDraft(
  organizationId: string,
  conversationId: string,
  db: DraftDb = getDb()
): Promise<void> {
  await db
    .delete(schema.bookingDraft)
    .where(conversationFilter(organizationId, conversationId));
}
