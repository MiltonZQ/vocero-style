/**
 * Foto de un profesional, reconocida por sus bytes.
 *
 * El `content-type` que manda el cliente no cuenta: declarar `image/png` y
 * subir HTML es la forma clásica de colar un documento donde se espera una
 * imagen, y esta foto se sirve desde el mismo dominio.
 */

/** 512 KB. La foto vive en la instancia; el tope evita usarla como almacén. */
export const MAX_STAFF_PHOTO_BYTES = 524288;

export type StaffPhotoMime = "image/jpeg" | "image/png" | "image/webp";

export function sniffImage(bytes: Uint8Array): StaffPhotoMime | null {
  const at = (index: number) => bytes[index];

  // JPEG: FF D8 FF
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    at(0) === 0x89 &&
    at(1) === 0x50 &&
    at(2) === 0x4e &&
    at(3) === 0x47 &&
    at(4) === 0x0d &&
    at(5) === 0x0a &&
    at(6) === 0x1a &&
    at(7) === 0x0a
  ) {
    return "image/png";
  }

  // WEBP: "RIFF" .... "WEBP"
  const ascii = (index: number, text: string) =>
    [...text].every((char, offset) => bytes[index + offset] === char.charCodeAt(0));
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";

  return null;
}
