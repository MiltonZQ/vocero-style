import { describe, expect, it } from "vitest";
import { matchesHandoffIntent } from "@/server/ai/handoff";

describe("patrón de respaldo de handoff (FR-022 / SC-006)", () => {
  it.each([
    "quiero hablar con un humano",
    "¿puedo hablar con un asesor?",
    "necesito comunicarme con alguien",
    "quiero contactar a una persona real",
    "quiero hablar con alguien por favor",
    "quiero hablar con una persona",
    "me pasas a un asesor",
    "me pasas con un humano",
    "prefiero atención humana",
    "atencion humana por favor",
    "¿está el encargado?",
    "quiero hablar con el encargado",
    "pásame con un humano",
  ])("dispara: %s", (text) => {
    expect(matchesHandoffIntent(text)).toBe(true);
  });

  it.each([
    "somos 4 personas", // el caso canónico que NO debe disparar
    "somos cuatro personas y queremos reservar",
    "¿tienen taladros?",
    "la persona que me atendió ayer fue amable",
    "mi humano favorito es mi hijo",
    "el asesor fiscal ya me cobró", // sin verbo de contacto ni "un asesor"
    // 019: "asesor de imagen" es un servicio de la barbería, no una petición.
    "quiero un asesor de imagen",
    "quiero hablar con un asesor de imagen",
    "¿tienen asesor de imagen para bodas?",
    "hablé con una persona ayer y quedó la cita",
  ])("NO dispara: %s", (text) => {
    expect(matchesHandoffIntent(text)).toBe(false);
  });
});
