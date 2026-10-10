import {
  apiError,
  withAuth,
  type ActorSession,
  type WithAuthOptions,
} from "@/lib/api";
import { ForbiddenError } from "@/lib/auth/actor";
import { agendaDisabledResponse, agendaEnabled } from "@/server/agenda/flag";
import { BookingError, type BookingResult } from "@/server/agenda/service";

/**
 * 015 — La traducción entre el dominio y HTTP, en un solo sitio.
 *
 * Vive aquí y no dentro de los `route.ts` por dos razones: Next solo admite
 * handlers como exports de una ruta (así que no serían testeables), y porque
 * los códigos y la FORMA del error son contrato observable, no un detalle.
 *
 * Las dos lecciones que costaron caro en producción y que este módulo fija:
 *  - Crear responde **201**, no 200. Un cliente que validaba `=== 200` dejó a
 *    todos los leads sin agendar durante horas, y los mocks no lo vieron
 *    porque respondían 200.
 *  - El error va ANIDADO (`{"error":{"code":…}}`) con `slots` como HERMANO. Un
 *    mock con la forma plana escondió el camino de re-oferta durante semanas:
 *    todo 409 se leía como conflicto genérico y las alternativas nunca se
 *    ofrecían.
 */

export type BookingPayload = {
  bookingId: string;
  meetingLink: string | null;
  linkPending: boolean;
  label: string;
};

export function bookingPayload(result: BookingResult): BookingPayload {
  return {
    bookingId: result.booking.id,
    meetingLink: result.meetingLink,
    /**
     * true ⇒ la cita EXISTE pero el proveedor aún no entregó el enlace.
     * Confirma la cita y di que el enlace llega luego; no prometas uno que no
     * tienes.
     */
    linkPending: result.linkPending,
    label: result.label,
  };
}

export function bookingErrorStatus(code: BookingError["code"]): number {
  switch (code) {
    case "not_found":
      return 404;
    case "invalid":
    case "service_required":
      return 422;
    case "slot_taken":
    case "slot_not_offered":
      return 409;
  }
}

/** Traduce un `BookingError` al sobre estándar. Cualquier otro error se relanza. */
export function bookingErrorResponse(err: unknown): Response {
  if (!(err instanceof BookingError)) throw err;
  const code = err.code === "invalid" ? "invalid_body" : err.code;
  return Response.json(
    { error: { code, message: err.message }, slots: err.slots },
    { status: bookingErrorStatus(err.code) }
  );
}

/**
 * Códigos estables de la 018. No sustituyen a `bookingErrorStatus`: una
 * reserva sigue siendo 201, y `slot_taken` / `slot_not_offered` siguen en 409.
 */
export const AGENDA_ERROR_STATUS = {
  forbidden: 403,
  account_disabled: 403,
  last_active_staff: 409,
  has_bookings: 409,
  has_account: 409,
  service_required: 422,
  service_not_offered: 422,
  duplicate: 409,
  not_found: 404,
  invalid_body: 422,
} as const;

export type AgendaErrorCode = keyof typeof AGENDA_ERROR_STATUS;

export function agendaErrorStatus(code: AgendaErrorCode): number {
  return AGENDA_ERROR_STATUS[code];
}

export class AgendaHttpError extends Error {
  readonly code: AgendaErrorCode;

  constructor(code: AgendaErrorCode, message: string) {
    super(message);
    this.name = "AgendaHttpError";
    this.code = code;
  }
}

/** Traduce un error de equipo/catálogo. Lo que no es de este dominio se relanza. */
export function agendaErrorResponse(err: unknown): Response {
  if (err instanceof AgendaHttpError) {
    return apiError(agendaErrorStatus(err.code), err.code, err.message);
  }
  if (err instanceof ForbiddenError) {
    return apiError(403, "forbidden", err.message);
  }
  throw err;
}

/**
 * Bandera primero, sesión después. Con la agenda apagada la ruta no existe
 * (404 vacío) aunque nadie haya iniciado sesión.
 */
export function withAgenda<Args extends unknown[]>(
  handler: (session: ActorSession, ...args: Args) => Promise<Response>,
  opts: WithAuthOptions = {}
): (...args: Args) => Promise<Response> {
  const authed = withAuth(handler, opts);
  return async (...args: Args) => {
    if (!agendaEnabled()) return agendaDisabledResponse();
    return authed(...args);
  };
}
