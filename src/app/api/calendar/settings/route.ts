import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { CONNECTOR_ORDER } from "@/lib/agenda-connectors";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import {
  ADDRESS_MAX_LENGTH,
  CalendarSettingsError,
  LIMITS,
  getSettings,
  upsertSettings,
} from "@/server/agenda/settings";

export const dynamic = "force-dynamic";

/**
 * 015 — La configuración de la agenda del negocio.
 *
 * Una instancia sin configurar responde 200 con los defaults, no 404: la
 * agenda ya es usable el día que se enciende.
 *
 * Jamás devuelve credenciales de un conector — esas viven en su propio
 * endpoint y solo salen como últimos 4 dígitos.
 */
export const GET = withAuth(async (session) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  const settings = await getSettings(session.organizationId);
  return Response.json({ settings });
});

const intervalSchema = z.object({
  start: z.string(),
  end: z.string(),
});

const putSchema = z.object({
  weeklyHours: z.record(z.string(), z.array(intervalSchema)).optional(),
  slotMinutes: z.number().optional(),
  bufferMinutes: z.number().optional(),
  minNoticeHours: z.number().optional(),
  maxDaysAhead: z.number().optional(),
  timezone: z.string().optional(),
  // El catálogo manda: un conector que no existe se rechaza aquí, y el
  // servicio lo vuelve a comprobar por si el llamador no es esta ruta.
  connector: z
    .string()
    .refine((v) => (CONNECTOR_ORDER as readonly string[]).includes(v), {
      message: "Conector desconocido",
    })
    .optional(),
  meetingLink: z.string().nullish(),
  // 019 — local físico. Aquí SÍ se rechaza (no se recorta): una dirección
  // cortada o un enlace roto se le mandaría tal cual al cliente.
  locationAddress: z.string().max(ADDRESS_MAX_LENGTH).nullish(),
  locationMapsUrl: z
    .string()
    .trim()
    .refine((v) => v === "" || isHttpsUrl(v), {
      message: "El enlace de Google Maps debe ser una URL https",
    })
    .nullish(),
  arrivalLeadMinutes: z
    .number()
    .int()
    .min(LIMITS.arrivalLeadMinutes.min)
    .max(LIMITS.arrivalLeadMinutes.max)
    .optional(),
  // 019 — pin de ubicación. `null` los borra; van juntos (lo comprueba el servicio).
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
});

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Guarda lo que se pueda salvar: los enteros fuera de rango se recortan y los
 * intervalos mal escritos se descartan, en vez de tumbar el horario entero por
 * una celda. Lo que sí se rechaza es lo que rompería el motor después: una
 * zona horaria que el runtime no conoce, o un conector inexistente.
 */
export const PUT = withAuth(async (session, req: Request) => {
  if (!agendaEnabled()) return agendaDisabledResponse();
  if (session.actor.role !== "owner") {
    return apiError(403, "forbidden", "Sin acceso");
  }
  const body = await parseBody(req, putSchema);
  if (!body.ok) return body.response;

  try {
    const settings = await upsertSettings(session.organizationId, {
      ...body.data,
      // `undefined` = no lo tocaron; `null` = lo vaciaron a propósito.
      meetingLink:
        body.data.meetingLink === undefined ? undefined : body.data.meetingLink,
    });
    return Response.json({ settings });
  } catch (err) {
    if (err instanceof CalendarSettingsError) {
      return apiError(422, "invalid_body", err.message);
    }
    throw err;
  }
});
