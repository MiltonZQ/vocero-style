"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { describeMapsError, parseMapsCoordinates } from "@/lib/maps-coordinates";

/**
 * 019 — Coordenadas del local para el pin de ubicación de WhatsApp.
 *
 * El dueño pega el código de "Insertar un mapa" (o el enlace largo) de Google
 * Maps y se llenan latitud y longitud; también pueden escribirse a mano. Un
 * enlace corto no trae coordenadas: se explica qué pegar en su lugar.
 */

type Props = {
  latitude: number | null;
  longitude: number | null;
  onChange: (latitude: number | null, longitude: number | null) => void;
};

function toNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export function LocationPinFields({ latitude, longitude, onChange }: Props) {
  const [paste, setPaste] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [latText, setLatText] = useState(latitude === null ? "" : String(latitude));
  const [lngText, setLngText] = useState(longitude === null ? "" : String(longitude));

  function onPaste(value: string) {
    setPaste(value);
    if (value.trim() === "") {
      setPasteError(null);
      return;
    }
    const result = parseMapsCoordinates(value);
    if (!result.ok) {
      setPasteError(describeMapsError(result.error));
      return;
    }
    setPasteError(null);
    setLatText(String(result.lat));
    setLngText(String(result.lng));
    onChange(result.lat, result.lng);
  }

  function onManual(nextLat: string, nextLng: string) {
    setLatText(nextLat);
    setLngText(nextLng);
    onChange(toNumber(nextLat), toNumber(nextLng));
  }

  const hasPin = latitude !== null && longitude !== null;
  const half = (latitude === null) !== (longitude === null);

  return (
    <div className="space-y-4 rounded-md border border-border p-3">
      <div className="space-y-1.5">
        <Label htmlFor="maps-paste">Mapa de Google Maps</Label>
        <Input
          id="maps-paste"
          value={paste}
          onChange={(e) => onPaste(e.target.value)}
          placeholder='<iframe src="https://www.google.com/maps/embed?…'
          aria-invalid={pasteError ? true : undefined}
        />
        <p className="text-xs text-text-3">
          Pega el mapa de Google Maps (iframe de «Insertar un mapa») o el enlace
          completo. Con eso el cliente recibe un pin de ubicación en WhatsApp al
          confirmar su cita.
        </p>
        {pasteError ? (
          <p role="alert" className="text-xs text-danger-text">
            {pasteError}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="lat">Latitud</Label>
          <Input
            id="lat"
            inputMode="decimal"
            className="w-44"
            value={latText}
            onChange={(e) => onManual(e.target.value, lngText)}
            placeholder="4.598865"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lng">Longitud</Label>
          <Input
            id="lng"
            inputMode="decimal"
            className="w-44"
            value={lngText}
            onChange={(e) => onManual(latText, e.target.value)}
            placeholder="-74.163288"
          />
        </div>
      </div>
      {hasPin ? (
        <p className="text-xs text-text-2" data-testid="pin-coordinates">
          Pin detectado: {latitude}, {longitude} ·{" "}
          <a
            className="underline"
            href={`https://www.google.com/maps?q=${latitude},${longitude}`}
            target="_blank"
            rel="noreferrer"
          >
            ver en Google Maps
          </a>
        </p>
      ) : half ? (
        <p className="text-xs text-danger-text">Llena latitud y longitud, o deja las dos vacías.</p>
      ) : (
        <p className="text-xs text-text-3">
          Sin coordenadas el bot manda el enlace de Google Maps en el texto.
        </p>
      )}
    </div>
  );
}
