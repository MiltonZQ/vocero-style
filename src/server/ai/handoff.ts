/**
 * Patrón de RESPALDO de intención de escalado (FR-022). Se evalúa sobre el
 * mensaje del cliente ANTES del LLM: si matchea, el handoff ocurre aunque el
 * modelo no lo detecte.
 *
 * 019 — Solo frases explícitas: un verbo de contacto pegado al objeto humano
 * ("hablar con una persona", "pasar a un asesor"), o la frase sola ("un
 * humano", "el encargado", "atención humana"). "Somos 4 personas" y "quiero un
 * asesor de imagen" (un servicio de la barbería) NO matchean.
 */
const CONTACT_VERB =
  "(?:hablar|comunicar(?:me|nos)?|contactar|pasas|pasar|p[aá]same|p[aá]senos)";
const HUMAN_TARGET =
  "(?:una persona|alguien|un humano|un asesor(?!\\s+de\\s)|el encargado)";

export const HANDOFF_BACKUP_REGEX = new RegExp(
  `\\b${CONTACT_VERB}\\s+(?:con|a)\\s+${HUMAN_TARGET}|\\bun humano\\b|\\bel encargado\\b|atenci[oó]n humana`,
  "i"
);

export function matchesHandoffIntent(text: string): boolean {
  return HANDOFF_BACKUP_REGEX.test(text);
}
