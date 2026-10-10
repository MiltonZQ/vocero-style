import { JUDGE_MARKER } from "@/server/ai/prompts";
import { CABECERA_HUECOS } from "@/server/agenda/offers";

/**
 * Proveedor LLM determinista para el self-test (contrato mocks.md).
 * Despacha por contenido del último mensaje `user` (o del system si es el
 * juez). JAMÁS es fallback en runtime: solo responde si OPENROUTER_BASE_URL
 * apunta explícitamente a él y el gate de mocks está activo.
 */

type InMessage = { role: string; content: string };

export function aiMockCompletion(messages: InMessage[]): string {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const lastUser =
    [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

  // Juez del Laboratorio: veredicto determinista por persona. Para cerrar el
  // loop del self-test, la persona fuera_de_kb pasa a verde si el CONOCIMIENTO
  // configurado ya cubre garantías/devoluciones (sugerencia aplicada).
  if (system.includes(JUDGE_MARKER)) {
    const kbSection =
      lastUser
        .split("CONOCIMIENTO CONFIGURADO:")[1]
        ?.split("TRANSCRIPT COMPLETO:")[0] ?? "";
    const kbCoversWarranty = /garant|devoluc/i.test(kbSection);
    if (lastUser.includes("fuera_de_kb") && !kbCoversWarranty) {
      return JSON.stringify({
        veredicto: "rojo",
        hallazgos: [
          {
            tipo: "fuera_de_kb",
            evidencia:
              "El cliente preguntó por garantías y devoluciones y el conocimiento no lo cubre.",
            sugerencia: {
              pregunta: "¿Cuál es la política de garantías y devoluciones?",
              respuesta:
                "Aceptamos devoluciones dentro de los 30 días con ticket de compra; la garantía depende del fabricante.",
            },
          },
        ],
      });
    }
    return JSON.stringify({ veredicto: "verde", hallazgos: [] });
  }

  const text = lastUser.toLowerCase();

  /**
   * 015 — La agenda, ejercitando el camino REAL.
   *
   * El mock reserva copiando el `startUtc` del mapa de huecos, igual que tiene
   * que hacer un modelo de verdad. Si ese mapa deja de llegar, aquí no hay de
   * dónde sacar el instante y la reserva falla — que es exactamente el fallo
   * que se vivió en producción (#50), en vez de un test que lo simula.
   *
   * Se buscan TODOS los mensajes `system`, no solo el primero: el mapa va al
   * final, después del historial.
   */
  const huecos = messages
    .filter((m) => m.role === "system" && m.content.includes(CABECERA_HUECOS))
    .flatMap((m) => m.content.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g) ?? []);

  const systemAll = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
  const quiereCita = /cita|agendar|agenda|horario|reserv/.test(text);
  if (quiereCita && huecos.length === 0) {
    const offer: {
      action: "offer_slots";
      reply: string;
      service?: string;
      staff?: string;
    } = {
      action: "offer_slots",
      reply: "Claro, tengo estos horarios:",
    };
    const staff = staffForOffer(lastUser, systemAll);
    const service = serviceForOffer(lastUser, systemAll);
    if (staff) offer.staff = staff;
    if (service) offer.service = service;
    return JSON.stringify(offer);
  }
  const eligeUno = /primero|segundo|ese|esa|confirmo|quiero|me sirve/.test(text);
  if (huecos.length > 0 && eligeUno && huecos[0]) {
    return JSON.stringify({
      action: "book_slot",
      startUtc: huecos[0],
      reply: "¡Listo! Te agendé.",
    });
  }

  // Persona pide_humano (el regex de respaldo captura la frase canónica; esta
  // rama cubre variantes que llegan al modelo).
  if (text.includes("humano") || text.includes("asesor")) {
    return JSON.stringify({ action: "handoff", reason: "cliente" });
  }

  // Intención de compra → mover a Interesado.
  if (
    text.includes("lo compro") ||
    text.includes("quiero comprar") ||
    text.includes("me lo llevo")
  ) {
    return JSON.stringify({
      action: "move_stage",
      stage: "Interesado",
      reply: "¡Excelente! Te aparto el producto y un compañero te confirma el pago.",
    });
  }

  const eco = lastUser.slice(0, 80);
  return JSON.stringify({
    action: "reply",
    text: `Respuesta de prueba sobre: ${eco}`,
  });
}

function listedServices(systemText: string): string[] {
  return [...systemText.matchAll(/^- (.+?) — \d+ min — /gm)].map((match) => match[1]!.trim());
}

function listedStaff(systemText: string): string[] {
  return [...systemText.matchAll(/^\s+-\s+([^(\n]+?)(?:\s+\([^)\n]+\))?\s*$/gm)].map(
    (match) => match[1]!.trim()
  );
}

/** Nombres solo si el texto del cliente los pide. Nunca inventa un startUtc. */
function staffForOffer(userText: string, systemText: string): string | undefined {
  const lower = userText.toLowerCase();
  if (lower.includes("el que esté libre") || lower.includes("el que este libre")) return "any";
  if (lower.includes("no ofrece") || lower.includes("con alguien que no")) {
    return "Nadie De Mentira";
  }
  return listedStaff(systemText).find((name) => lower.includes(name.toLowerCase()));
}

function serviceForOffer(userText: string, systemText: string): string | undefined {
  const lower = userText.toLowerCase();
  return listedServices(systemText).find((name) => lower.includes(name.toLowerCase()));
}
