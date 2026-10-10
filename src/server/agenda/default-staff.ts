import { and, asc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";

/**
 * TEMPORAL (018 US2): se reemplaza por selección explícita de profesional y
 * servicio.
 *
 * La migración 0014 hizo obligatorios `staff_id` y `service_id` en toda
 * sesión. Mientras las superficies de la 015 (tablero, bot, agente) no
 * mandan esos datos, se resuelven aquí contra el único profesional activo y
 * el único servicio activo de la organización, para que la 015 siga
 * funcionando sin tocarse. Con más de uno, la elección es ambigua y no se
 * adivina: quien llama decide qué hacer (422 `service_required`).
 */

/** El único profesional activo, o null si hay cero o varios. */
export async function resolveSoleStaffId(
  organizationId: string
): Promise<string | null> {
  const rows = await getDb()
    .select({ id: schema.staff.id })
    .from(schema.staff)
    .where(
      scoped(
        schema.staff.organizationId,
        organizationId,
        eq(schema.staff.active, true)
      )
    )
    .orderBy(asc(schema.staff.position))
    .limit(2);
  return rows.length === 1 ? rows[0]!.id : null;
}

export type DefaultCatalogPick = {
  staffId: string;
  serviceId: string;
  durationMinutes: number;
  priceCents: number;
  currency: string;
};

/**
 * El único profesional activo con el único servicio activo, o null si alguno
 * de los dos es ambiguo o inexistente. La duración sale del catálogo (o de la
 * propia del profesional en `staff_service`, si la tiene).
 */
export async function resolveDefaultCatalog(
  organizationId: string
): Promise<DefaultCatalogPick | null> {
  const staffId = await resolveSoleStaffId(organizationId);
  if (!staffId) return null;

  const db = getDb();
  const services = await db
    .select({
      id: schema.service.id,
      durationMinutes: schema.service.durationMinutes,
      priceCents: schema.service.priceCents,
      currency: schema.service.currency,
    })
    .from(schema.service)
    .where(
      scoped(
        schema.service.organizationId,
        organizationId,
        eq(schema.service.active, true)
      )
    )
    .orderBy(asc(schema.service.position))
    .limit(2);
  if (services.length !== 1) return null;
  const sv = services[0]!;

  const own = await db
    .select({ durationMinutes: schema.staffService.durationMinutes })
    .from(schema.staffService)
    .where(
      scoped(
        schema.staffService.organizationId,
        organizationId,
        and(
          eq(schema.staffService.staffId, staffId),
          eq(schema.staffService.serviceId, sv.id)
        )
      )
    )
    .limit(1);

  return {
    staffId,
    serviceId: sv.id,
    durationMinutes: own[0]?.durationMinutes ?? sv.durationMinutes,
    priceCents: sv.priceCents,
    currency: sv.currency,
  };
}

export type AvailabilityMeta = {
  staffId: string;
  staffName: string;
  serviceId: string;
  durationMinutes: number;
  priceCents: number;
};

/** Nombre, precio y duración efectiva del par que ya se ofreció en un hueco. */
export async function loadAvailabilityMeta(
  organizationId: string,
  staffId: string,
  serviceId: string
): Promise<AvailabilityMeta | null> {
  const db = getDb();
  const staffRows = await db
    .select({ displayName: schema.staff.displayName })
    .from(schema.staff)
    .where(
      scoped(schema.staff.organizationId, organizationId, eq(schema.staff.id, staffId))
    )
    .limit(1);
  const serviceRows = await db
    .select({
      priceCents: schema.service.priceCents,
      durationMinutes: schema.service.durationMinutes,
    })
    .from(schema.service)
    .where(
      scoped(
        schema.service.organizationId,
        organizationId,
        eq(schema.service.id, serviceId)
      )
    )
    .limit(1);
  const own = await db
    .select({ durationMinutes: schema.staffService.durationMinutes })
    .from(schema.staffService)
    .where(
      scoped(
        schema.staffService.organizationId,
        organizationId,
        and(
          eq(schema.staffService.staffId, staffId),
          eq(schema.staffService.serviceId, serviceId)
        )
      )
    )
    .limit(1);
  const staff = staffRows[0];
  const service = serviceRows[0];
  if (!staff || !service) return null;
  return {
    staffId,
    staffName: staff.displayName,
    serviceId,
    durationMinutes: own[0]?.durationMinutes ?? service.durationMinutes,
    priceCents: service.priceCents,
  };
}

export type ActiveServiceOption = {
  id: string;
  name: string;
  durationMinutes: number;
};

/** Active catalog, for a `service_required` response. */
export async function listActiveServices(
  organizationId: string
): Promise<ActiveServiceOption[]> {
  return getDb()
    .select({
      id: schema.service.id,
      name: schema.service.name,
      durationMinutes: schema.service.durationMinutes,
    })
    .from(schema.service)
    .where(
      scoped(
        schema.service.organizationId,
        organizationId,
        eq(schema.service.active, true)
      )
    )
    .orderBy(asc(schema.service.position), asc(schema.service.name));
}

/**
 * 015 edges pass nothing and get the sole active staff + service.
 * An explicit pair is kept. Anything ambiguous returns the active services.
 */
export async function resolveAvailabilityTarget(
  organizationId: string,
  input: { staffId?: string | null; serviceId?: string | null } = {}
): Promise<
  | { ok: true; staffId: string; serviceId: string }
  | { ok: false; services: ActiveServiceOption[] }
> {
  const requestedStaff = input.staffId || null;
  const requestedService = input.serviceId || null;
  if (requestedStaff && requestedService) {
    return { ok: true, staffId: requestedStaff, serviceId: requestedService };
  }

  const [soleStaff, services] = await Promise.all([
    resolveSoleStaffId(organizationId),
    listActiveServices(organizationId),
  ]);

  if (!requestedService) {
    const only = services[0];
    if (soleStaff && services.length === 1 && only && (!requestedStaff || requestedStaff === soleStaff)) {
      return { ok: true, staffId: soleStaff, serviceId: only.id };
    }
    return { ok: false, services };
  }

  if (!soleStaff) return { ok: false, services };
  return { ok: true, staffId: soleStaff, serviceId: requestedService };
}
