/**
 * 019 — Coordinates out of whatever the owner pastes from Google Maps: the
 * "Insertar un mapa" iframe, a full place link or a plain `?q=lat,lng` URL.
 *
 * Pure and client-safe (the settings card previews with it and the WhatsApp
 * location pin uses the result). Short links (`maps.app.goo.gl`) hide the
 * coordinates behind a redirect that we will not follow from the server, so
 * they come back as a typed error the UI can explain.
 */

export type MapsParseError = "short_link" | "not_found";

export type MapsParseResult =
  | { ok: true; lat: number; lng: number }
  | { ok: false; error: MapsParseError };

const NUM = "(-?\\d{1,3}(?:\\.\\d+)?)";

const SHORT_LINK = /(?:maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs)/i;

function decode(input: string): string {
  let text = input.replace(/&amp;/gi, "&");
  // The src of a pasted iframe, when there is one.
  const src = /<iframe[^>]*\ssrc\s*=\s*["']([^"']+)["']/i.exec(text);
  if (src?.[1]) text = src[1];
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function inRange(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function pair(latRaw: string | undefined, lngRaw: string | undefined): MapsParseResult | null {
  if (latRaw === undefined || lngRaw === undefined) return null;
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  return inRange(lat, lng) ? { ok: true, lat, lng } : null;
}

/**
 * What gets stored in the "maps link" field: if the owner pasted the whole
 * `<iframe …>` embed, only its `src` (never raw HTML); otherwise the text as is.
 */
export function extractMapsUrl(input: string): string {
  const text = input.trim();
  const src = /<iframe[^>]*\ssrc\s*=\s*["']([^"']+)["']/i.exec(text);
  return (src?.[1] ?? text).replace(/&amp;/gi, "&").trim();
}

export function parseMapsCoordinates(input: string): MapsParseResult {
  const text = decode(input.trim());
  if (!text) return { ok: false, error: "not_found" };

  const matchers: Array<() => MapsParseResult | null> = [
    // Place links: the pin itself, `!3d<lat>!4d<lng>`.
    () => {
      const m = new RegExp(`!3d${NUM}!4d${NUM}`).exec(text);
      return pair(m?.[1], m?.[2]);
    },
    // Embed `pb=`: `!2d<lng>!3d<lat>` (or the reverse order).
    () => {
      const lng = new RegExp(`!2d${NUM}(?![\\d.])`).exec(text)?.[1];
      const lat = new RegExp(`!3d${NUM}(?![\\d.])`).exec(text)?.[1];
      return pair(lat, lng);
    },
    // Viewport center: `@lat,lng,zoom`.
    () => {
      const m = new RegExp(`@${NUM},${NUM}`).exec(text);
      return pair(m?.[1], m?.[2]);
    },
    // Query-string forms.
    () => {
      const m = new RegExp(`[?&](?:q|ll|query|center|destination)=${NUM},\\s*${NUM}`, "i").exec(text);
      return pair(m?.[1], m?.[2]);
    },
  ];
  for (const match of matchers) {
    const found = match();
    if (found) return found;
  }
  return { ok: false, error: SHORT_LINK.test(text) ? "short_link" : "not_found" };
}

/** What the owner reads when the paste could not be turned into coordinates. */
export function describeMapsError(error: MapsParseError): string {
  return error === "short_link"
    ? "Ese es un enlace corto de Google Maps y no trae las coordenadas. Abre el lugar en Google Maps, pulsa Compartir → Insertar un mapa y pega aquí el código completo (o copia el enlace largo de la barra del navegador)."
    : "No encontré coordenadas en lo que pegaste. Usa el código de Compartir → Insertar un mapa, el enlace largo de la barra del navegador, o escribe la latitud y la longitud a mano.";
}
