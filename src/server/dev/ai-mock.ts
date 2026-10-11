import { DRAFT_STATE_MARKER, JUDGE_MARKER } from "@/server/ai/prompts";

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
   * 019 — La agenda, ejercitando el camino REAL.
   *
   * El mock lee el MISMO bloque de estado que ve un modelo de verdad (horarios
   * ofrecidos al final de la conversación) y elige por la hora que dijo el
   * cliente, o por posición, igual que el contrato exige. Si ese bloque deja de llegar, aquí no hay opciones que
   * elegir y la reserva falla en vez de simularse.
   */
  const stateBlock = [...messages]
    .reverse()
    .find((m) => m.role === "system" && m.content.includes(DRAFT_STATE_MARKER))?.content;
  if (stateBlock) {
    const turn = barberTurn(text, stateBlock, messages);
    if (turn) return JSON.stringify(turn);
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

type MockTurn =
  | { action: "book_slot"; option: number }
  | { action: "book_slot"; time: string; day?: string }
  | { action: "greeting" }
  | { action: "my_bookings" }
  | { action: "list_services" }
  | { action: "send_location" }
  | { action: "handoff"; reason: string }
  | { action: "reply"; text: string }
  | {
      action: "update_draft";
      service?: string;
      staff?: string;
      when?: { day?: string; from?: string; to?: string };
    };

const WEEKDAYS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];

function fold(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
}

/** Relative day only (the contract: the model never computes dates). */
function dayFrom(lower: string): string | undefined {
  // "en la mañana" is a time of day, not tomorrow.
  const cleaned = lower.replace(/(?:en|por) la man?ana/g, " ");
  if (/pasado man?ana/.test(cleaned)) return "pasado mañana";
  if (/\bman?ana\b/.test(cleaned)) return "mañana";
  if (/\bhoy\b/.test(cleaned)) return "hoy";
  return WEEKDAYS.find((d) => cleaned.includes(fold(d)));
}

function hoursFrom(lower: string): { from?: string; to?: string } {
  if (/en la tarde|por la tarde/.test(lower)) return { from: "14:00", to: "19:00" };
  if (/en la noche|por la noche/.test(lower)) return { from: "18:00", to: "20:00" };
  if (/(?:en|por) la man?ana/.test(lower)) return { from: "10:00", to: "13:00" };
  const clock = /a las (\d{1,2})(?::(\d{2}))?/.exec(lower);
  if (clock) {
    let hour = Number(clock[1]);
    if (hour <= 7) hour += 12; // the shop opens at 10:00
    return { from: `${String(hour).padStart(2, "0")}:${clock[2] ?? "00"}` };
  }
  return {};
}

/**
 * 019 — Keyword mapping from the client's last message to the barber bot
 * contract. Deterministic and tied to the REAL prompt: service/staff names come
 * from the catalog the system prompt lists, options from the numbered state.
 */
function barberTurn(
  lower: string,
  stateBlock: string,
  messages: InMessage[]
): MockTurn | null {
  const folded = fold(lower);

  if (/cancel/.test(folded)) return { action: "handoff", reason: "cancelacion" };
  if (/reprogram|cambiar (?:mi|la) cita|mover (?:mi|la) cita|otro dia para mi cita/.test(folded)) {
    return { action: "handoff", reason: "reprogramacion" };
  }
  if (/llego tarde|llegar\w* tarde|voy\w* tarde|\d+ ?min\w* tarde|sin cita/.test(folded)) {
    return { action: "handoff", reason: "llegada" };
  }
  if (/mi cita|mis citas|a que hora (?:es|era)|cuando es mi/.test(folded)) {
    return { action: "my_bookings" };
  }

  const hasOptions = /^\s+1\) /m.test(stateBlock);
  if (hasOptions) {
    // Por la hora: solo si es una de las ofrecidas (si no, es otra preferencia).
    const offered = [...stateBlock.matchAll(/^\s+\d\) .*?(\d{2}:\d{2})/gm)].map((m) => m[1]!);
    const clock = /(?:\ba las |\blas )(\d{1,2})(?::(\d{2}))?\b|\b(\d{1,2}):(\d{2})\b/.exec(folded);
    if (clock) {
      let hour = Number(clock[1] ?? clock[3]);
      if (hour <= 7) hour += 12; // the shop opens at 10:00
      const time = `${String(hour).padStart(2, "0")}:${clock[2] ?? clock[4] ?? "00"}`;
      if (offered.includes(time)) {
        const day = dayFrom(folded);
        return { action: "book_slot", time, ...(day ? { day } : {}) };
      }
    }
    if (/primer|segund|tercer|\bla [123]\b|opcion [123]|confirmo|me sirve|\bese\b|\besa\b/.test(folded)) {
      const option = /tercer|[3]/.test(folded) ? 3 : /segund|[2]/.test(folded) ? 2 : 1;
      return { action: "book_slot", option };
    }
  }

  if (/que servicios|\bprecios\b/.test(folded)) return { action: "list_services" };

  if (/donde|direccion|ubicad|ubicacion|como llego/.test(folded)) {
    return { action: "send_location" };
  }

  const systemAll = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
  const catalogNames = listedServices(systemAll);
  // Longest name first: "Corte + barba" must win over "Barba".
  const listed = [...catalogNames]
    .sort((a, b) => b.length - a.length)
    .find((name) => folded.includes(fold(name)));
  const service =
    // A combo the catalog lacks: the model puts the client's words in `service`.
    (/corte y barba/.test(folded) && !catalogNames.some((n) => /corte.{1,3}barba/.test(fold(n)))
      ? "corte y barba"
      : undefined) ??
    listed ??
    // Not in the catalog: the model puts the client's literal text in `service`.
    /tinte|manicure|masaje|facial|pedicure/.exec(folded)?.[0];
  const anyone = /me da igual|cualquiera|el que este libre|quien sea/.test(folded);
  const staff = anyone
    ? "any"
    : /no ofrece|con alguien que no/.test(folded)
      ? "Nadie De Mentira"
      : listedStaff(systemAll).find((name) => folded.includes(fold(name)));
  const day = dayFrom(folded);
  const hours = hoursFrom(folded);

  if (service || staff || day || hours.from) {
    const draft: Extract<MockTurn, { action: "update_draft" }> = { action: "update_draft" };
    if (service) draft.service = service;
    if (staff) draft.staff = staff;
    if (day || hours.from) draft.when = { ...(day ? { day } : {}), ...hours };
    return draft;
  }
  if (/cita|agendar|agenda|horario|reserv/.test(folded)) return { action: "update_draft" };
  if (/^(?:hola|buenas|buenos|q onda|que onda|hey)/.test(folded.trim())) {
    return { action: "greeting" };
  }
  return null;
}
