"use client";

import { useCallback, useEffect, useState } from "react";
import { formatMoneyCents } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Qué ofrece este profesional. El precio es el del catálogo y no se envía:
 * el cuerpo solo lleva `durationMinutes` (null hereda la duración base).
 */

type CatalogService = {
  id: string;
  name: string;
  durationMinutes: number;
  priceCents: number;
  currency: string;
  active: boolean;
};

type OfferedService = {
  serviceId: string;
  durationMinutes: number | null;
  effectiveDurationMinutes: number;
};

export function StaffServicesEditor({
  staffId,
  canEdit,
}: {
  staffId: string;
  canEdit: boolean;
}) {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<CatalogService[]>([]);
  const [offered, setOffered] = useState<Map<string, OfferedService>>(new Map());
  const [durations, setDurations] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setPhase("loading");
    setError(null);
    const [catalogRes, offeredRes] = await Promise.all([
      fetch("/api/services").catch(() => null),
      fetch(`/api/staff/${staffId}/services`).catch(() => null),
    ]);
    if (!catalogRes?.ok || !offeredRes?.ok) {
      const failed = !catalogRes?.ok ? catalogRes : offeredRes;
      setError(await apiMessage(failed, "No se pudieron cargar los servicios"));
      setPhase("error");
      return;
    }
    const catalogData = (await catalogRes.json().catch(() => null)) as {
      services?: unknown;
    } | null;
    const offeredData = (await offeredRes.json().catch(() => null)) as {
      services?: unknown;
    } | null;
    const nextCatalog = parseCatalog(catalogData?.services);
    const nextOffered = parseOffered(offeredData?.services);
    const inputs: Record<string, string> = {};
    for (const row of nextOffered.values()) {
      inputs[row.serviceId] = row.durationMinutes == null ? "" : String(row.durationMinutes);
    }
    setCatalog(nextCatalog);
    setOffered(nextOffered);
    setDurations(inputs);
    setPhase("ready");
  }, [staffId]);

  useEffect(() => {
    void load(false);
  }, [load]);

  async function toggle(service: CatalogService, checked: boolean) {
    if (!canEdit) return;
    setBusy(service.id);
    setError(null);
    if (!checked) {
      const res = await fetch(`/api/staff/${staffId}/services/${service.id}`, {
        method: "DELETE",
      }).catch(() => null);
      setBusy(null);
      if (!res?.ok) {
        setError(await apiMessage(res, "No se pudo dejar de ofrecer el servicio"));
        return;
      }
      await load(true);
      return;
    }
    const parsed = durationBody(durations[service.id] ?? "");
    if ("error" in parsed) {
      setBusy(null);
      setError(parsed.error);
      return;
    }
    const res = await fetch(`/api/staff/${staffId}/services/${service.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ durationMinutes: parsed.durationMinutes }),
    }).catch(() => null);
    setBusy(null);
    if (!res?.ok) {
      setError(await apiMessage(res, "No se pudo marcar el servicio"));
      return;
    }
    await load(true);
  }

  async function saveDuration(serviceId: string) {
    if (!canEdit) return;
    const parsed = durationBody(durations[serviceId] ?? "");
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setBusy(serviceId);
    setError(null);
    const res = await fetch(`/api/staff/${staffId}/services/${serviceId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ durationMinutes: parsed.durationMinutes }),
    }).catch(() => null);
    setBusy(null);
    if (!res?.ok) {
      setError(await apiMessage(res, "No se pudo guardar la duración"));
      return;
    }
    await load(true);
  }

  if (phase === "loading") return <p className="text-sm text-text-2">Cargando servicios…</p>;
  if (phase === "error") {
    return (
      <div className="space-y-2">
        <p className="text-sm text-destructive">{error ?? "No se pudieron cargar los servicios"}</p>
        <Button type="button" variant="secondary" onClick={() => void load()}>
          Reintentar
        </Button>
      </div>
    );
  }

  return (
    <section className="space-y-3 rounded-md border bg-subtle p-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Servicios que ofrece</h3>
        <p className="text-sm text-text-2">
          El precio es el del catálogo y no se cambia aquí. La duración vacía
          hereda la del catálogo.
        </p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {catalog.length === 0 ? (
        <p className="text-sm text-text-2">No hay servicios activos en el catálogo.</p>
      ) : (
        <ul className="divide-y rounded-md border bg-card">
          {catalog.map((service) => {
            const row = offered.get(service.id);
            const checked = row != null;
            const price = formatMoneyCents(service.priceCents, service.currency) ?? "—";
            const effective = row?.effectiveDurationMinutes ?? service.durationMinutes;
            return (
              <li key={service.id} className="space-y-2 p-3">
                <label className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={checked}
                    disabled={!canEdit || busy === service.id}
                    onChange={(event) => void toggle(service, event.target.checked)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{service.name}</span>
                    <span className="block text-sm text-text-2">
                      {price} · catálogo {service.durationMinutes} min · aplica {effective} min
                    </span>
                  </span>
                </label>
                {checked && canEdit && (
                  <div className="flex flex-wrap items-end gap-2 pl-7">
                    <div className="space-y-1">
                      <label
                        htmlFor={`${staffId}-duration-${service.id}`}
                        className="text-xs font-medium text-text-2"
                      >
                        Duración propia (min)
                      </label>
                      <Input
                        id={`${staffId}-duration-${service.id}`}
                        inputMode="numeric"
                        value={durations[service.id] ?? ""}
                        placeholder={String(service.durationMinutes)}
                        onChange={(event) =>
                          setDurations((current) => ({
                            ...current,
                            [service.id]: event.target.value,
                          }))
                        }
                        className="w-28"
                      />
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={busy === service.id}
                      onClick={() => void saveDuration(service.id)}
                    >
                      {busy === service.id ? "Guardando…" : "Guardar duración"}
                    </Button>
                  </div>
                )}
                {checked && !canEdit && (
                  <p className="pl-7 text-sm text-text-2">
                    Duración: {row?.durationMinutes ?? service.durationMinutes} min
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function durationBody(raw: string): { durationMinutes: number | null } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { durationMinutes: null };
  if (!/^\d+$/.test(trimmed)) {
    return { error: "La duración tiene que ser un número entero de minutos." };
  }
  const value = Number(trimmed);
  if (value < 5 || value > 600) {
    return { error: "La duración debe estar entre 5 y 600 minutos." };
  }
  return { durationMinutes: value };
}

function parseCatalog(value: unknown): CatalogService[] {
  if (!Array.isArray(value)) return [];
  const out: CatalogService[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    if (record.active === false) continue;
    if (typeof record.id !== "string" || typeof record.name !== "string") continue;
    if (typeof record.durationMinutes !== "number") continue;
    if (typeof record.priceCents !== "number") continue;
    out.push({
      id: record.id,
      name: record.name,
      durationMinutes: record.durationMinutes,
      priceCents: record.priceCents,
      currency: typeof record.currency === "string" ? record.currency : "MXN",
      active: true,
    });
  }
  return out;
}

function parseOffered(value: unknown): Map<string, OfferedService> {
  const out = new Map<string, OfferedService>();
  if (!Array.isArray(value)) return out;
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    if (typeof record.serviceId !== "string") continue;
    const durationMinutes =
      typeof record.durationMinutes === "number" ? record.durationMinutes : null;
    const effective =
      typeof record.effectiveDurationMinutes === "number"
        ? record.effectiveDurationMinutes
        : (durationMinutes ?? 0);
    out.set(record.serviceId, {
      serviceId: record.serviceId,
      durationMinutes,
      effectiveDurationMinutes: effective,
    });
  }
  return out;
}

async function apiMessage(res: Response | null, fallback: string): Promise<string> {
  if (!res) return "No hubo respuesta del servidor";
  const data = (await res.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  const message = data?.error?.message?.trim();
  return message ? message : fallback;
}
