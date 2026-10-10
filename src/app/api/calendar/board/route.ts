import { agendaErrorResponse, withAgenda } from "@/server/agenda/http";
import { getCalendarBoard } from "@/server/agenda/board-query";

export const dynamic = "force-dynamic";

/**
 * Tablero del local. La bandera se evalúa antes de la sesión: apagada, 404.
 * Staff no entra. Recepción y dueño sí.
 */
export const GET = withAgenda(
  async (session, req: Request) => {
    const url = new URL(req.url);
    const days = Number(url.searchParams.get("days") ?? "1");
    try {
      const board = await getCalendarBoard(session.actor, {
        from: url.searchParams.get("from") ?? "",
        days,
        staffId: url.searchParams.get("staffId"),
        jobTitle: url.searchParams.get("jobTitle"),
      });
      return Response.json(board);
    } catch (err) {
      return agendaErrorResponse(err);
    }
  },
  { roles: ["owner", "reception"] }
);
