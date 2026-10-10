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
