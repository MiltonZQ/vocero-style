import { describe, expect, it } from "vitest";
import { MAX_STAFF_PHOTO_BYTES, sniffImage } from "@/lib/image-sniff";

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function ascii(value: string): Uint8Array {
  return Uint8Array.from(value, (char) => char.charCodeAt(0));
}

describe("sniffImage", () => {
  it("reconoce JPEG por FF D8 FF, sin mirar un content-type", () => {
    expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00))).toBe("image/jpeg");
  });

  it("reconoce PNG por la firma de 8 bytes", () => {
    expect(
      sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00))
    ).toBe("image/png");
  });

  it("reconoce WebP cuando RIFF está en el byte 0 y WEBP en el 8", () => {
    const webp = new Uint8Array(12);
    webp.set(ascii("RIFF"), 0);
    webp.set(ascii("WEBP"), 8);
    expect(sniffImage(webp)).toBe("image/webp");
  });

  it("rechaza SVG, HTML, el vacío y los buffers que no alcanzan la firma", () => {
    expect(sniffImage(ascii("<svg xmlns=\"http://www.w3.org/2000/svg\">"))).toBeNull();
    expect(sniffImage(ascii("<!DOCTYPE html><html></html>"))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
    expect(sniffImage(bytes(0xff, 0xd8))).toBeNull();
    expect(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47))).toBeNull();
  });

  it("no trata como WebP un RIFF de otro formato", () => {
    const wave = new Uint8Array(12);
    wave.set(ascii("RIFF"), 0);
    wave.set(ascii("WAVE"), 8);
    expect(sniffImage(wave)).toBeNull();
  });
});

describe("MAX_STAFF_PHOTO_BYTES", () => {
  it("topa la foto de staff en 512 KB", () => {
    expect(MAX_STAFF_PHOTO_BYTES).toBe(524288);
  });
});
