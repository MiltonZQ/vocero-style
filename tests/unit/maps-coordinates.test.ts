import { describe, expect, it } from "vitest";
import { describeMapsError, parseMapsCoordinates } from "@/lib/maps-coordinates";

// The owner's sample: Google Maps "Insertar un mapa" iframe.
const OWNER_IFRAME =
  '<iframe src="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d1665.0830673235978!2d-74.1632885539481!3d4.598865027392155!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x8e3f9f6954b407d3%3A0x81aa8c852b420af8!2sPapeler%C3%ADa%20Esmeralda!5e0!3m2!1ses!2sco!4v1791744951649!5m2!1ses!2sco" width="600" height="450" style="border:0;" allowfullscreen="" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>';

describe("parseMapsCoordinates", () => {
  it("reads the owner's embed iframe (!2d<lng>!3d<lat>)", () => {
    expect(parseMapsCoordinates(OWNER_IFRAME)).toEqual({
      ok: true,
      lat: 4.598865027392155,
      lng: -74.1632885539481,
    });
  });

  it("reads the bare embed URL and the reverse !3d<lat>!2d<lng> order", () => {
    expect(
      parseMapsCoordinates("https://www.google.com/maps/embed?pb=!1m3!1d500!2d-99.1332!3d19.4326")
    ).toEqual({ ok: true, lat: 19.4326, lng: -99.1332 });
    expect(
      parseMapsCoordinates("https://www.google.com/maps/embed?pb=!1m3!1d500!3d19.4326!2d-99.1332")
    ).toEqual({ ok: true, lat: 19.4326, lng: -99.1332 });
  });

  it("reads a place link, preferring the pin (!3d!4d) over the @ viewport", () => {
    const url =
      "https://www.google.com/maps/place/Style/@4.6000,-74.1700,17z/data=!3m1!4b1!4m6!3m5!1s0x8e3f:0x81aa!8m2!3d4.598865!4d-74.163288!16s%2Fg%2F1";
    expect(parseMapsCoordinates(url)).toEqual({ ok: true, lat: 4.598865, lng: -74.163288 });
  });

  it("reads @lat,lng", () => {
    expect(parseMapsCoordinates("https://www.google.com/maps/@19.4326,-99.1332,15z")).toEqual({
      ok: true,
      lat: 19.4326,
      lng: -99.1332,
    });
  });

  it("reads q=, ll= and query= coordinates", () => {
    for (const query of ["q=19.4326,-99.1332", "ll=19.4326,-99.1332", "query=19.4326%2C-99.1332"]) {
      expect(parseMapsCoordinates(`https://maps.google.com/?${query}`)).toEqual({
        ok: true,
        lat: 19.4326,
        lng: -99.1332,
      });
    }
  });

  it("decodes &amp; inside a pasted iframe", () => {
    const html = '<iframe src="https://maps.google.com/maps?hl=es&amp;q=4.5988,-74.1632&amp;output=embed"></iframe>';
    expect(parseMapsCoordinates(html)).toEqual({ ok: true, lat: 4.5988, lng: -74.1632 });
  });

  it("a short link cannot be read: asks for the embed or the full link", () => {
    expect(parseMapsCoordinates("https://maps.app.goo.gl/abc123")).toEqual({
      ok: false,
      error: "short_link",
    });
    expect(parseMapsCoordinates("https://goo.gl/maps/xyz")).toEqual({
      ok: false,
      error: "short_link",
    });
  });

  it("nothing readable, empty and out-of-range coordinates are not_found", () => {
    for (const input of [
      "",
      "   ",
      "hola",
      "https://www.google.com/maps/search/barberia",
      "https://maps.google.com/?q=95,10",
      "https://maps.google.com/?q=10,190",
    ]) {
      expect(parseMapsCoordinates(input)).toEqual({ ok: false, error: "not_found" });
    }
  });
});

describe("describeMapsError", () => {
  it("explains a short link in Spanish and what to paste instead", () => {
    const text = describeMapsError("short_link");
    expect(text).toMatch(/enlace corto/i);
    expect(text).toMatch(/Insertar un mapa/);
  });

  it("explains a link without coordinates", () => {
    expect(describeMapsError("not_found")).toMatch(/coordenadas/i);
  });
});
