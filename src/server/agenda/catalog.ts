import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Actor } from "@/lib/auth/actor";
import { ForbiddenError } from "@/lib/auth/actor";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { AgendaHttpError } from "@/server/agenda/http";

/**
 * 018 — Catálogo del dueño (un precio) y los servicios que ofrece cada
 * profesional (solo duración). El precio no tiene columna en `staff_service`.
 */

export function effectiveDuration(
  staffService: { durationMinutes: number | null },
  service: { durationMinutes: number }
): number {
  return staffService.durationMinutes ?? service.durationMinutes;
}

const jobTitleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(40)
  .nullable()
  .optional();

const currencySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/)
  .default("MXN");

export const serviceInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    durationMinutes: z.number().int().min(5).max(600),
    priceCents: z.number().int().min(0),
    currency: currencySchema,
    jobTitle: jobTitleSchema,
    position: z.number().int().optional(),
  })
  .strict();

export const servicePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    durationMinutes: z.number().int().min(5).max(600).optional(),
    priceCents: z.number().int().min(0).optional(),
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    jobTitle: jobTitleSchema,
    position: z.number().int().optional(),
    active: z.boolean().optional(),
  })
  .strict();

export type ServiceInput = z.infer<typeof serviceInputSchema>;
export type ServicePatch = z.infer<typeof servicePatchSchema>;

export type ServiceDTO = {
  id: string;
  name: string;
  durationMinutes: number;
  priceCents: number;
  currency: string;
  jobTitle: string | null;
  active: boolean;
  position: number;
};

export function parseServiceInput(
  body: unknown
): { ok: true; data: ServiceInput } | { ok: false; code: "invalid_body" } {
  const parsed = serviceInputSchema.safeParse(body);
  if (!parsed.success) return { ok: false, code: "invalid_body" };
  return { ok: true, data: parsed.data };
}

/** Cuerpo de `PUT /api/staff/[id]/services/[serviceId]`. Nada más que la duración. */
export const PutStaffService = z
  .object({
    durationMinutes: z.number().int().min(5).max(600).nullable().optional(),
  })
  .strict();

export type PutStaffServiceInput = z.infer<typeof PutStaffService>;

const STAFF_SERVICE_KEYS = new Set(["durationMinutes"]);

/**
 * R-403: un staff que manda precio, nombre u otra clave no llega a Zod.
 * El dueño sí: su cuerpo extra lo rechaza `.strict()` con 422.
 */
export function rejectStaffPriceEdit(
  role: string,
  body: unknown
): ForbiddenError | null {
  if (role !== "staff") return null;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  for (const key of Object.keys(body)) {
    if (!STAFF_SERVICE_KEYS.has(key)) return new ForbiddenError();
  }
  return null;
}

/** La duración que queda tras un PUT. Sin la clave, se conserva la actual. */
export function nextStaffServiceDuration(
  existing: number | null,
  input: { durationMinutes?: number | null }
): number | null {
  if (!Object.prototype.hasOwnProperty.call(input, "durationMinutes")) {
    return existing;
  }
  return input.durationMinutes ?? null;
}

export type StaffServiceDTO = {
  serviceId: string;
  name: string;
  priceCents: number;
  currency: string;
  catalogDurationMinutes: number;
  durationMinutes: number | null;
  effectiveDurationMinutes: number;
};

/** Un staff solo opera sobre su propio id. Otro id es 404, no 403. */
export function assertOwnStaff(actor: Actor, staffId: string): void {
  if (actor.role === "staff" && actor.staffId !== staffId) {
    throw new AgendaHttpError("not_found", "No encontrado");
  }
}

function toServiceDTO(row: typeof schema.service.$inferSelect): ServiceDTO {
  return {
    id: row.id,
    name: row.name,
    durationMinutes: row.durationMinutes,
    priceCents: row.priceCents,
    currency: row.currency,
    jobTitle: row.jobTitle,
    active: row.active,
    position: row.position,
  };
}

function toStaffServiceDTO(
  service: {
    id: string;
    name: string;
    priceCents: number;
    currency: string;
    durationMinutes: number;
  },
  durationMinutes: number | null
): StaffServiceDTO {
  return {
    serviceId: service.id,
    name: service.name,
    priceCents: service.priceCents,
    currency: service.currency,
    catalogDurationMinutes: service.durationMinutes,
    durationMinutes,
    effectiveDurationMinutes: effectiveDuration({ durationMinutes }, service),
  };
}

function postgresCode(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

async function requireStaffRow(actor: Actor, staffId: string) {
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
  return rows[0];
}

export async function listServices(
  actor: Actor,
  options: { includeInactive: boolean }
): Promise<ServiceDTO[]> {
  const activeOnly = actor.role === "staff" || !options.includeInactive;
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.service)
    .where(
      scoped(
        schema.service.organizationId,
        actor.organizationId,
        activeOnly ? eq(schema.service.active, true) : undefined
      )
    )
    .orderBy(asc(schema.service.position), asc(schema.service.name));
  return rows.map(toServiceDTO);
}

export async function createService(
  actor: Actor,
  input: ServiceInput
): Promise<ServiceDTO> {
  const db = getDb();
  const inserted = await db
    .insert(schema.service)
    .values({
      id: newId("service"),
      organizationId: actor.organizationId,
      name: input.name,
      durationMinutes: input.durationMinutes,
      priceCents: input.priceCents,
      currency: input.currency,
      jobTitle: input.jobTitle ?? null,
      position: input.position ?? 0,
      active: true,
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new AgendaHttpError("invalid_body", "No se pudo crear el servicio");
  return toServiceDTO(row);
}

export async function updateService(
  actor: Actor,
  serviceId: string,
  patch: ServicePatch
): Promise<ServiceDTO> {
  const db = getDb();
  const current = await db
    .select()
    .from(schema.service)
    .where(
      scoped(
        schema.service.organizationId,
        actor.organizationId,
        eq(schema.service.id, serviceId)
      )
    )
    .limit(1);
  const row = current[0];
  if (!row) throw new AgendaHttpError("not_found", "No encontrado");

  const set: Partial<typeof schema.service.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.durationMinutes !== undefined) set.durationMinutes = patch.durationMinutes;
  if (patch.priceCents !== undefined) set.priceCents = patch.priceCents;
  if (patch.currency !== undefined) set.currency = patch.currency;
  if (patch.jobTitle !== undefined) set.jobTitle = patch.jobTitle;
  if (patch.position !== undefined) set.position = patch.position;
  if (patch.active !== undefined) set.active = patch.active;

  if (Object.keys(set).length === 0) return toServiceDTO(row);

  const updated = await db
    .update(schema.service)
    .set({ ...set, updatedAt: new Date() })
    .where(
      scoped(
        schema.service.organizationId,
        actor.organizationId,
        eq(schema.service.id, serviceId)
      )
    )
    .returning();
  const next = updated[0];
  if (!next) throw new AgendaHttpError("not_found", "No encontrado");
  return toServiceDTO(next);
}

const HAS_BOOKINGS = "Tiene citas: desactívalo en vez de borrarlo";

export async function deleteService(
  actor: Actor,
  serviceId: string
): Promise<void> {
  const db = getDb();
  const current = await db
    .select({ id: schema.service.id })
    .from(schema.service)
    .where(
      scoped(
        schema.service.organizationId,
        actor.organizationId,
        eq(schema.service.id, serviceId)
      )
    )
    .limit(1);
  if (!current[0]) throw new AgendaHttpError("not_found", "No encontrado");

  const bookings = await db
    .select({ id: schema.booking.id })
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        actor.organizationId,
        eq(schema.booking.serviceId, serviceId)
      )
    )
    .limit(1);
  if (bookings[0]) throw new AgendaHttpError("has_bookings", HAS_BOOKINGS);

  try {
    await db
      .delete(schema.service)
      .where(
        scoped(
          schema.service.organizationId,
          actor.organizationId,
          eq(schema.service.id, serviceId)
        )
      );
  } catch (err) {
    if (postgresCode(err) === "23503") {
      throw new AgendaHttpError("has_bookings", HAS_BOOKINGS);
    }
    throw err;
  }
}

export async function listStaffServices(
  actor: Actor,
  staffId: string
): Promise<StaffServiceDTO[]> {
  await requireStaffRow(actor, staffId);
  const db = getDb();
  const rows = await db
    .select({
      id: schema.service.id,
      name: schema.service.name,
      priceCents: schema.service.priceCents,
      currency: schema.service.currency,
      catalogDuration: schema.service.durationMinutes,
      durationMinutes: schema.staffService.durationMinutes,
    })
    .from(schema.staffService)
    .innerJoin(
      schema.service,
      and(
        eq(schema.staffService.serviceId, schema.service.id),
        eq(schema.service.organizationId, actor.organizationId)
      )
    )
    .where(
      scoped(
        schema.staffService.organizationId,
        actor.organizationId,
        eq(schema.staffService.staffId, staffId)
      )
    )
    .orderBy(asc(schema.service.position), asc(schema.service.name));

  return rows.map((row) =>
    toStaffServiceDTO(
      {
        id: row.id,
        name: row.name,
        priceCents: row.priceCents,
        currency: row.currency,
        durationMinutes: row.catalogDuration,
      },
      row.durationMinutes
    )
  );
}

export async function putStaffService(
  actor: Actor,
  staffId: string,
  serviceId: string,
  input: PutStaffServiceInput
): Promise<StaffServiceDTO> {
  await requireStaffRow(actor, staffId);
  const db = getDb();
  const services = await db
    .select()
    .from(schema.service)
    .where(
      scoped(
        schema.service.organizationId,
        actor.organizationId,
        eq(schema.service.id, serviceId),
        eq(schema.service.active, true)
      )
    )
    .limit(1);
  const service = services[0];
  if (!service) throw new AgendaHttpError("not_found", "No encontrado");

  const existing = await db
    .select({ durationMinutes: schema.staffService.durationMinutes })
    .from(schema.staffService)
    .where(
      scoped(
        schema.staffService.organizationId,
        actor.organizationId,
        eq(schema.staffService.staffId, staffId),
        eq(schema.staffService.serviceId, serviceId)
      )
    )
    .limit(1);
  const durationMinutes = nextStaffServiceDuration(
    existing[0]?.durationMinutes ?? null,
    input
  );

  await db
    .insert(schema.staffService)
    .values({
      staffId,
      serviceId,
      organizationId: actor.organizationId,
      durationMinutes,
    })
    .onConflictDoUpdate({
      target: [schema.staffService.staffId, schema.staffService.serviceId],
      set: { durationMinutes },
    });

  return toStaffServiceDTO(service, durationMinutes);
}

/** Quita la oferta. Las citas ya agendadas conservan duración y precio. */
export async function deleteStaffService(
  actor: Actor,
  staffId: string,
  serviceId: string
): Promise<void> {
  await requireStaffRow(actor, staffId);
  const db = getDb();
  await db
    .delete(schema.staffService)
    .where(
      scoped(
        schema.staffService.organizationId,
        actor.organizationId,
        eq(schema.staffService.staffId, staffId),
        eq(schema.staffService.serviceId, serviceId)
      )
    );
}
