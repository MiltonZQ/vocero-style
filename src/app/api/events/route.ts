import {
  AccountDisabledError,
  ForbiddenError,
  requireActor,
  type Actor,
} from "@/lib/auth/actor";
import { UnauthorizedError } from "@/lib/auth/session";
import { eventVisibleTo, subscribe } from "@/server/events/bus";

/**
 * Canal SSE de la bandeja (contrato sse.md).
 * Headers exactos + heartbeat ~25s para sobrevivir detrás de Caddy/Traefik.
 * El servidor no garantiza replay: el cliente hace catch-up con `since=`.
 */
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;
const encoder = new TextEncoder();

export async function GET(req: Request) {
  let actor: Actor;
  try {
    actor = await requireActor();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return new Response("No autenticado", { status: 401 });
    }
    if (err instanceof AccountDisabledError) {
      return Response.json(
        { error: { code: "account_disabled", message: "Cuenta desactivada" } },
        { status: 403 }
      );
    }
    if (err instanceof ForbiddenError) {
      return Response.json(
        { error: { code: "forbidden", message: "Sin acceso" } },
        { status: 403 }
      );
    }
    throw err;
  }
  const { organizationId } = actor;

  let cleanup: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup?.();
        }
      };

      send(`: conectado\n\n`);

      // 018: el filtro por rol vive aqui, en el servidor. Un staff sin perfil
      // recibe el stream abierto (heartbeat) pero ningun evento.
      const unsubscribe = subscribe(organizationId, (event) => {
        if (!eventVisibleTo(actor, event)) return;
        send(
          `event: ${event.type}\n` +
            `id: ${Date.now()}\n` +
            `data: ${JSON.stringify(event.data)}\n\n`
        );
      });

      const heartbeat = setInterval(() => send(`: ping\n\n`), HEARTBEAT_MS);

      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // ya cerrado
        }
      };

      req.signal.addEventListener("abort", () => cleanup?.());
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
