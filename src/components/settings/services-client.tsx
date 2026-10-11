"use client";

import { useCallback, useEffect, useState } from "react";
import { CURRENCIES, formatMoneyCents, parseMoneyToCents, type Currency } from "@/lib/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type ServiceRow = {
  id: string;
  name: string;
  durationMinutes: number;
  priceCents: number;
  currency: string;
  jobTitle: string | null;
  active: boolean;
};

const selectClass = "h-9 w-full rounded-md border border-input bg-card px-2 text-sm";

export function ServicesClient({ canEdit }: { canEdit: boolean }) {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [editing, setEditing] = useState<ServiceRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPhase("loading");
    const res = await fetch("/api/services?includeInactive=1").catch(() => null);
    if (!res?.ok) {
      setError(await apiMessage(res, "No se pudo cargar el catálogo"));
      setPhase("error");
      return;
    }
    const data = (await res.json().catch(() => null)) as { services?: unknown } | null;
    setServices(parseServices(data?.services));
    setError(null);
    setPhase("ready");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function setActive(service: ServiceRow, active: boolean) {
    if (!canEdit) return;
    setBusy(service.id);
    setError(null);
    const res = await fetch(`/api/services/${service.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active }),
    }).catch(() => null);
    setBusy(null);
    if (!res?.ok) {
      setError(await apiMessage(res, "No se pudo cambiar el estado"));
      return;
    }
    await load();
  }

  if (phase === "loading") return <p className="text-sm text-text-2">Cargando…</p>;
  if (phase === "error") {
    return (
      <div className="space-y-2">
        <p className="text-sm text-destructive">{error}</p>
        <Button type="button" variant="secondary" onClick={() => void load()}>
          Reintentar
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-6">
      {!canEdit && (
        <p className="text-sm text-text-2">
          Solo lectura. El precio y el catálogo los edita el propietario.
        </p>
      )}
      {canEdit && (creating || editing) && (
        <ServiceForm
          service={editing}
          onCancel={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            void load();
          }}
        />
      )}
      {canEdit && !creating && !editing && (
        <Button type="button" onClick={() => setCreating(true)}>
          Nuevo servicio
        </Button>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {services.length === 0 ? (
        <p className="text-sm text-text-2">
          Todavía no hay servicios en el catálogo.
          {canEdit ? " Crea el primero para que los profesionales puedan ofrecerlo." : ""}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-left text-sm">
            <thead className="bg-subtle text-text-2">
              <tr>
                <th className="px-3 py-2 font-semibold">Nombre</th>
                <th className="px-3 py-2 font-semibold">Duración base</th>
                <th className="px-3 py-2 font-semibold">Precio</th>
                <th className="px-3 py-2 font-semibold">Moneda</th>
                <th className="px-3 py-2 font-semibold">Oficio</th>
                <th className="px-3 py-2 font-semibold">Activo</th>
                {canEdit && <th className="px-3 py-2 font-semibold">Acciones</th>}
              </tr>
            </thead>
            <tbody className="divide-y">
              {services.map((service) => (
                <tr key={service.id}>
                  <td className="px-3 py-2 font-medium">{service.name}</td>
                  <td className="px-3 py-2 text-text-2">{service.durationMinutes} min</td>
                  <td className="px-3 py-2 text-text-2">
                    {formatMoneyCents(service.priceCents, service.currency) ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-text-2">{service.currency}</td>
                  <td className="px-3 py-2 text-text-2">{service.jobTitle ?? "—"}</td>
                  <td className="px-3 py-2">
                    <Badge variant={service.active ? "default" : "secondary"}>
                      {service.active ? "Activo" : "Inactivo"}
                    </Badge>
                  </td>
                  {canEdit && (
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            setCreating(false);
                            setEditing(service);
                          }}
                        >
                          Editar
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={busy === service.id}
                          onClick={() => void setActive(service, !service.active)}
                        >
                          {service.active ? "Desactivar" : "Activar"}
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ServiceForm({
  service,
  onCancel,
  onSaved,
}: {
  service: ServiceRow | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(service?.name ?? "");
  const [duration, setDuration] = useState(String(service?.durationMinutes ?? 30));
  const [price, setPrice] = useState(
    service ? (service.priceCents / 100).toFixed(2) : ""
  );
  const [currency, setCurrency] = useState<Currency>(asCurrency(service?.currency));
  const [jobTitle, setJobTitle] = useState(service?.jobTitle ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const durationMinutes = Number(duration);
    if (!name.trim()) {
      setError("El nombre es obligatorio.");
      return;
    }
    if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 600) {
      setError("La duración base debe ser un entero entre 5 y 600 minutos.");
      return;
    }
    const priceCents = parseMoneyToCents(price);
    if (priceCents == null || priceCents < 0) {
      setError("Ese precio no se entiende.");
      return;
    }
    const body = {
      name: name.trim(),
      durationMinutes,
      priceCents,
      currency,
      jobTitle: jobTitle.trim() ? jobTitle.trim() : null,
    };
    setSaving(true);
    setError(null);
    const res = await fetch(service ? `/api/services/${service.id}` : "/api/services", {
      method: service ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      setError(await apiMessage(res, "No se pudo guardar el servicio"));
      return;
    }
    onSaved();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{service ? "Editar servicio" : "Nuevo servicio"}</CardTitle>
        <CardDescription>Un solo precio para todo el local. El oficio es opcional.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="service-name">Nombre</Label>
            <Input
              id="service-name"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="service-job">Oficio</Label>
            <Input
              id="service-job"
              value={jobTitle}
              maxLength={40}
              placeholder="opcional"
              onChange={(event) => setJobTitle(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="service-duration">Duración base (min)</Label>
            <Input
              id="service-duration"
              inputMode="numeric"
              value={duration}
              onChange={(event) => setDuration(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="service-price">Precio</Label>
            <Input
              id="service-price"
              value={price}
              placeholder="250 o 250.50"
              onChange={(event) => setPrice(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="service-currency">Moneda</Label>
            <select
              id="service-currency"
              className={selectClass}
              value={currency}
              onChange={(event) => setCurrency(asCurrency(event.target.value))}
            >
              {CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </div>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={saving} onClick={() => void save()}>
            {saving ? "Guardando…" : "Guardar"}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancelar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function asCurrency(value: string | null | undefined): Currency {
  if (value && (CURRENCIES as readonly string[]).includes(value)) return value as Currency;
  return "MXN";
}

function parseServices(value: unknown): ServiceRow[] {
  if (!Array.isArray(value)) return [];
  const out: ServiceRow[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.name !== "string") continue;
    if (typeof record.durationMinutes !== "number" || typeof record.priceCents !== "number") {
      continue;
    }
    out.push({
      id: record.id,
      name: record.name,
      durationMinutes: record.durationMinutes,
      priceCents: record.priceCents,
      currency: typeof record.currency === "string" ? record.currency : "MXN",
      jobTitle: typeof record.jobTitle === "string" ? record.jobTitle : null,
      active: record.active !== false,
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
