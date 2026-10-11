"use client";

import { useEffect, useRef, useState } from "react";
import { ImageUp, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Foto del profesional. El cuerpo es el archivo en crudo: el servidor
 * reconoce el tipo por los bytes, no por multipart.
 */
export function PhotoUpload({
  staffId,
  photoUrl,
  canEdit,
  onChange,
}: {
  staffId: string;
  photoUrl: string | null;
  canEdit: boolean;
  onChange?: (photoUrl: string | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState(photoUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPreview(photoUrl);
  }, [photoUrl, staffId]);

  async function upload(file: File) {
    if (!canEdit) return;
    setBusy(true);
    setError(null);
    const bytes = await file.arrayBuffer();
    const res = await fetch(`/api/staff/${staffId}/photo`, {
      method: "PUT",
      body: bytes,
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      setError(await apiMessage(res, "No se pudo subir la foto"));
      return;
    }
    const data = (await res.json().catch(() => null)) as { photoUrl?: unknown } | null;
    const next = typeof data?.photoUrl === "string" ? data.photoUrl : photoUrl;
    setPreview(next);
    onChange?.(next);
  }

  async function remove() {
    if (!canEdit) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/staff/${staffId}/photo`, {
      method: "DELETE",
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      setError(await apiMessage(res, "No se pudo quitar la foto"));
      return;
    }
    setPreview(null);
    onChange?.(null);
  }

  return (
    <section className="space-y-3 rounded-md border bg-subtle p-4">
      <h3 className="text-sm font-semibold">Foto</h3>
      <div className="flex items-center gap-4">
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={preview}
            alt="Foto del profesional"
            width={64}
            height={64}
            className="h-16 w-16 rounded-full border bg-card object-cover"
          />
        ) : (
          <span className="flex h-16 w-16 items-center justify-center rounded-full border bg-card text-xs text-text-2">
            Sin foto
          </span>
        )}
        <p className="text-sm text-text-2">
          JPEG, PNG o WebP. Si pesa de más o el formato no se reconoce, se
          muestra el motivo.
        </p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <input
            ref={input}
            id={`${staffId}-photo`}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void upload(file);
            }}
          />
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            <ImageUp className="h-4 w-4" />
            {busy ? "Subiendo…" : preview ? "Cambiar foto" : "Subir foto"}
          </Button>
          {preview && (
            <Button type="button" variant="ghost" disabled={busy} onClick={() => void remove()}>
              <Trash2 className="h-4 w-4" />
              Quitar
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

async function apiMessage(res: Response | null, fallback: string): Promise<string> {
  if (!res) return "No hubo respuesta del servidor";
  const data = (await res.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  const message = data?.error?.message?.trim();
  return message ? message : fallback;
}
