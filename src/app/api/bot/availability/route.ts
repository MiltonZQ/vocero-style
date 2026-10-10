import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { apiError } from "@/lib/api";
import { scoped } from "@/lib/db/tenant";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import { computeAvailability } from "@/server/agenda/availability";
import { resolveAvailabilityTarget } from "@/server/agenda/default-staff";
import { getSettings } from "@/server/agenda/settings";
import { daysWithAgenda, spreadByDay } from "@/server/agenda/spread";
import { replaceOffers } from "@/server/agenda/offers";

export const dynamic = "force-dynamic";

/**
 * 015 — Los horarios que se le van a ofrecer al cliente, para quien conduce la
 * conversación.
 *
 * A diferencia de la vista del operador, esta REGISTRA la oferta: es ese
 * registro lo que después habilita la reserva. Sin él, `POST /api/bot/bookings`
 * rechaza cualquier instante.
 *
 * El catálogo reservable (`limit`) es más ancho que el menú que el agente
 * enseña: guardar solo los tres que se muestran deja al agente sin nada
 * legítimo que aceptar cuando el cliente pide otro día.
 */

const LIMITS = {
  limit: { min: 1, max: 48, def: 12 },
  perDay: { min: 1, max: 8, def: 3 },
  days: { min: 1, max: 14, def: 5 },
};

function clamp(raw: string | null, l: { min: number; max: number; def: number }) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return l.def;
  return Math.max(l.min, Math.min(l.max, Math.round(n)));
}

export async function GET(req: Request) {
  // La bandera se evalúa ANTES que la llave: si esta instancia no tiene
  // agenda, el endpoint no existe — no hay nada que autenticar.
  if (!agendaEnabled()) return agendaDisabledResponse();

  const denied = requireBotKey(req);
  if (denied) return denied;

  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "La instancia aún no tiene organización");
  }

  const url = new URL(req.url);
  const conversationId = url.searchParams.get("conversationId");
  if (!conversationId) {
    return apiError(422, "invalid_body", "Falta conversationId");
  }

  const db = getDb();
  const rows = await db
    .select({ id: schema.conversation.id })
    .from(schema.conversation)
    .where(
      scoped(
        schema.conversation.organizationId,
        organizationId,
        eq(schema.conversation.id, conversationId)
      )
    )
    .limit(1);
  if (!rows[0]) return apiError(404, "not_found", "Conversación no encontrada");

  const limit = clamp(url.searchParams.get("limit"), LIMITS.limit);
  const perDay = clamp(url.searchParams.get("perDay"), LIMITS.perDay);
  const days = clamp(url.searchParams.get("days"), LIMITS.days);

  const settings = await getSettings(organizationId);
  const now = new Date();
  const target = await resolveAvailabilityTarget(organizationId);
  if (!target.ok) {
    return Response.json(
      {
        error: {
          code: "service_required",
          message: "Hay que elegir profesional y servicio",
        },
        services: target.services,
      },
      { status: 422 }
    );
  }
  const all = await computeAvailability(organizationId, {
    settings,
    now,
    staffId: target.staffId,
    serviceId: target.serviceId,
  });
  const slots = spreadByDay(all, {
    timezone: settings.timezone,
    limit,
    perDay,
    now,
  }).filter((s) => withinDays(s.dayIso, days, settings.timezone, now));

  // Reemplazo completo: la oferta vigente es siempre la última.
  await replaceOffers(
    organizationId,
    conversationId,
    slots.map((s) => ({ startUtc: s.startUtc, label: s.label }))
  );

  return Response.json({
    slots: slots.map((s) => ({
      startUtc: s.startUtc,
      endUtc: s.endUtc,
      label: s.label,
      dayIso: s.dayIso,
      dayLabel: s.dayLabel,
      time: s.time,
    })),
    // Los días que NO están aquí no tienen agenda: es la lista que evita que
    // el modelo invente un jueves que el negocio tiene cerrado.
    diasConAgenda: daysWithAgenda(slots),
  });
}

function withinDays(
  dayIso: string,
  days: number,
  timezone: string,
  now: Date
): boolean {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const diff =
    (Date.parse(`${dayIso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) /
    86_400_000;
  return diff >= 0 && diff < days;
}
