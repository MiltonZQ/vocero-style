import { apiError } from "@/lib/api";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { loadActiveCatalog } from "@/server/agenda/agent";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";

export const dynamic = "force-dynamic";

/**
 * 018 — Catálogo activo para un cerebro externo.
 * La bandera se evalúa antes que la llave: sin agenda, la ruta no existe.
 * No incluye teléfono ni ningún dato de contacto del profesional.
 */
export async function GET(req: Request) {
  if (!agendaEnabled()) return agendaDisabledResponse();

  const denied = requireBotKey(req);
  if (denied) return denied;

  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "La instancia aún no tiene organización");
  }

  const catalog = await loadActiveCatalog(organizationId);
  return Response.json({
    services: catalog.services.map((service) => ({
      id: service.id,
      name: service.name,
      durationMinutes: service.durationMinutes,
      priceCents: service.priceCents,
      currency: service.currency,
      staff: service.staff.map((person) => ({
        id: person.id,
        displayName: person.displayName,
        jobTitle: person.jobTitle,
        effectiveDurationMinutes: person.effectiveDurationMinutes,
      })),
    })),
    singleStaff: catalog.singleStaff,
    singleService: catalog.singleService,
  });
}
