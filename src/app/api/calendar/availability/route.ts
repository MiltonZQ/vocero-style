import { withAuth } from "@/lib/api";
import { dayIsoInTz, timeInTz, dayLabelInTz } from "@/lib/time/slots";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import { computeAvailability } from "@/server/agenda/availability";
import {
  loadAvailabilityMeta,
  resolveAvailabilityTarget,
} from "@/server/agenda/default-staff";
import { agendaErrorResponse } from "@/server/agenda/http";
import { getSettings } from "@/server/agenda/settings";

export const dynamic = "force-dynamic";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 015 — Los huecos libres, para el operador.
 *
 * A diferencia de la superficie del bot, esta NO registra oferta: es la vista
 * de quien ya está mirando la agenda y elige de lo que ve.
 *
 * Sin huecos responde `{"slots":[]}` con 200: agenda llena es una respuesta,
 * no un error.
 */
export const GET = withAuth(async (session, req: Request) => {
  if (!agendaEnabled()) return agendaDisabledResponse();

  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const settings = await getSettings(session.organizationId);
  const now = new Date();
  const target = await resolveAvailabilityTarget(session.organizationId, {
    staffId: url.searchParams.get("staffId"),
    serviceId: url.searchParams.get("serviceId"),
  });
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
  let slots;
  try {
    slots = await computeAvailability(session.organizationId, {
      fromISO: from && ISO_DATE.test(from) ? from : undefined,
      toISO: to && ISO_DATE.test(to) ? to : undefined,
      settings,
      now,
      staffId: target.staffId,
      serviceId: target.serviceId,
    });
  } catch (err) {
    return agendaErrorResponse(err);
  }

  const meta = await loadAvailabilityMeta(
    session.organizationId,
    target.staffId,
    target.serviceId
  );

  return Response.json({
    slots: slots.map((s) => ({
      ...s,
      dayIso: dayIsoInTz(new Date(s.startUtc), settings.timezone),
      dayLabel: dayLabelInTz(s.startUtc, settings.timezone, now),
      time: timeInTz(s.startUtc, settings.timezone),
      staffId: target.staffId,
      staffName: meta?.staffName ?? null,
      serviceId: target.serviceId,
      durationMinutes: meta?.durationMinutes ?? null,
      priceCents: meta?.priceCents ?? null,
    })),
  });
});
