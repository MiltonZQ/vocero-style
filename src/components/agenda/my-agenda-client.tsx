"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { bookingStatusLabel } from "@/components/bookings/bookings-client";
import { useEvents } from "@/components/use-events";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatMoneyCents } from "@/lib/money";
import type { Role } from "@/lib/auth/roles";
import {
  addDaysISO,
  dayIsoInTz,
  timeInTz,
  todayInTz,
  zonedWallClockToUtc,
} from "@/lib/time/slots";

type AgendaBooking = {
  id: string;
  kind: "session" | "block";
  status: string;
  scheduledAtUtc?: string;
  startUtc?: string;
  durationMinutes: number;
  priceCents: number | null;
  currency: string | null;
  notes: string | null;
  contact: { name: string; phone: string | null } | null;
  staff: { id: string; name: string } | null;
  service: { id: string; name: string } | null;
};

type Offered = {
  id: string;
  name: string;
  effectiveDurationMinutes: number;
  priceCents: number;
  currency: string;
};

type SlotChoice = { startUtc: string; label: string };

const FALLBACK_TZ = "America/Mexico_City";

export function MyAgendaClient() {
  const [phase, setPhase] = useState<"loading" | "ready" | "error" | "missing">("loading");
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [staffId, setStaffId] = useState<string | null>(null);
  const [timeZone, setTimeZone] = useState(FALLBACK_TZ);
  const [from, setFrom] = useState("");
  const [days, setDays] = useState<1 | 7>(1);
  const [bookings, setBookings] = useState<AgendaBooking[]>([]);
  const [listReady, setListReady] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [offered, setOffered] = useState<Offered[]>([]);
  const [servicesReady, setServicesReady] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [moveAt, setMoveAt] = useState("");

  const loadIdentity = useCallback(async () => {
    setPhase("loading");
    setError(null);
    const meRes = await fetch("/api/me").catch(() => null);
    if (!meRes?.ok) {
      setError(await apiMessage(meRes, "No se pudo saber quién eres"));
      setPhase("error");
      return;
    }
    const me = parseMe(await meRes.json().catch(() => null));
    if (!me) {
      setError("No se pudo leer tu rol.");
      setPhase("error");
      return;
    }
    setRole(me.role);
    if (!me.staffId) {
      setStaffId(null);
      setPhase("missing");
      return;
    }
    setStaffId(me.staffId);
    const zone = await readTimeZone(me.role);
    setTimeZone(zone);
    setFrom((current) => current || safeToday(zone));
    setPhase("ready");
  }, []);

  const refresh = useCallback(async () => {
    if (!staffId || !from) return;
    const start = zonedWallClockToUtc(from, "00:00", timeZone);
    const end = zonedWallClockToUtc(addDaysISO(from, days), "00:00", timeZone);
    if (!start || !end) {
      setListReady(true);
      setListError("No se pudo calcular el rango de fechas.");
      setBookings([]);
      return;
    }
    const qs = new URLSearchParams({
      from: start.toISOString(),
      to: end.toISOString(),
    });
    const [listRes, servicesRes] = await Promise.all([
      fetch(`/api/bookings?${qs.toString()}`).catch(() => null),
      fetch(`/api/staff/${staffId}/services`).catch(() => null),
    ]);
    if (!listRes?.ok) {
      setListReady(true);
      setListError(await apiMessage(listRes, "No se pudieron cargar las citas"));
      return;
    }
    const listData = (await listRes.json().catch(() => null)) as { bookings?: unknown } | null;
    setBookings(
      parseBookings(listData?.bookings).filter(
        (booking) => booking.staff?.id === staffId || (booking.kind === "block" && !booking.staff)
      )
    );
    if (!servicesRes?.ok) {
      setOffered([]);
      setServicesReady(false);
      setListReady(true);
      setListError(await apiMessage(servicesRes, "No se pudieron cargar tus servicios"));
      return;
    }
    const servicesData = (await servicesRes.json().catch(() => null)) as {
      services?: unknown;
    } | null;
    setOffered(parseOffered(servicesData?.services));
    setServicesReady(true);
    setListReady(true);
    setListError(null);
  }, [staffId, from, days, timeZone]);

  useEffect(() => {
    void loadIdentity();
  }, [loadIdentity]);

  useEffect(() => {
    if (phase !== "ready") return;
    void refresh();
  }, [phase, refresh]);

  useEvents({
    onBookingUpdated: () => void refresh(),
    onReconnect: () => void refresh(),
  });

  async function act(id: string, body: unknown) {
    setBusy(id);
    setListError(null);
    const res = await fetch(`/api/bookings/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    setBusy(null);
    if (!res?.ok) {
      setListError(await apiMessage(res, "No se pudo completar la acción"));
      return;
    }
    setMoving(null);
    await refresh();
  }

  if (phase === "loading") return <p className="text-sm text-text-2">Cargando…</p>;
  if (phase === "error") {
    return (
      <div className="space-y-2">
        <p className="text-sm text-destructive">{error}</p>
        <Button type="button" variant="secondary" onClick={() => void loadIdentity()}>
          Reintentar
        </Button>
      </div>
    );
  }
  if (phase === "missing" || !staffId) {
    return (
      <div className="max-w-xl space-y-2">
        <p className="text-sm text-text-2">
          {role === "owner"
            ? "Esta cuenta no tiene un perfil de profesional, así que no hay una agenda propia. El calendario del local sigue en Calendario."
            : "Tu cuenta no está vinculada a un profesional. Pide al propietario que te cree el acceso desde Profesionales."}
        </p>
        {role === "owner" && (
          <Link href="/calendar" className="text-sm font-semibold text-brand-text hover:underline">
            Ir al calendario
          </Link>
        )}
      </div>
    );
  }

  const dates = Array.from({ length: days }, (_, index) => addDaysISO(from, index));

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={days === 1 ? "default" : "secondary"}
          onClick={() => setDays(1)}
        >
          Día
        </Button>
        <Button
          type="button"
          size="sm"
          variant={days === 7 ? "default" : "secondary"}
          onClick={() => setDays(7)}
        >
          Semana
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Periodo anterior"
          onClick={() => setFrom((current) => addDaysISO(current, -days))}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="Periodo siguiente"
          onClick={() => setFrom((current) => addDaysISO(current, days))}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setFrom(safeToday(timeZone))}>
          Hoy
        </Button>
        <span className="text-sm text-text-2">{dayHeading(from, timeZone)}</span>
      </div>

      {listError && <p className="text-sm text-destructive">{listError}</p>}

      {!listReady && !listError && (
        <p className="text-sm text-text-2">Cargando citas…</p>
      )}

      {servicesReady && (
        <CreateSession
          staffId={staffId}
          offered={offered}
          onCreated={() => void refresh()}
        />
      )}

      {listReady && dates.map((date) => {
        const rows = bookings
          .filter((booking) => dayOf(booking, timeZone) === date)
          .sort((a, b) => startOf(a).localeCompare(startOf(b)));
        return (
          <section key={date} className="space-y-2">
            <h3 className="text-sm font-semibold">{dayHeading(date, timeZone)}</h3>
            {rows.length === 0 ? (
              <p className="text-sm text-text-2">Sin citas ni bloqueos.</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {rows.map((booking) => {
                  const shop = booking.kind === "block" && !booking.staff;
                  const mine = booking.staff?.id === staffId;
                  const editable = mine && booking.status === "agendada";
                  const price = formatMoneyCents(booking.priceCents, booking.currency ?? "MXN");
                  return (
                    <li key={booking.id} className="space-y-2 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">
                          {timeInTz(startOf(booking), timeZone) || "—"}
                        </span>
                        <span className="text-xs text-text-2">{booking.durationMinutes} min</span>
                        <Badge variant={booking.status === "cancelada" ? "secondary" : "default"}>
                          {bookingStatusLabel(booking.status)}
                        </Badge>
                        {shop ? (
                          <Badge variant="secondary">Bloqueo del local</Badge>
                        ) : booking.kind === "block" ? (
                          <Badge variant="secondary">Bloqueo</Badge>
                        ) : (
                          <Badge variant="secondary">{booking.service?.name?.trim() || "Sin servicio"}</Badge>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-text-2">
                        {booking.contact?.name && <span>{booking.contact.name}</span>}
                        {booking.contact?.phone && <span>{booking.contact.phone}</span>}
                        {price && <span>{price}</span>}
                        {booking.notes && <span>{booking.notes}</span>}
                      </div>
                      {shop && (
                        <p className="text-sm text-text-2">
                          Los bloqueos del local no se editan desde aquí.
                        </p>
                      )}
                      {editable && (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            disabled={busy === booking.id}
                            onClick={() => {
                              setMoving((current) => (current === booking.id ? null : booking.id));
                              setMoveAt(toDatetimeLocal(startOf(booking)));
                            }}
                          >
                            Reprogramar
                          </Button>
                          {booking.kind === "session" && (
                            <>
                              <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                disabled={busy === booking.id}
                                onClick={() =>
                                  void act(booking.id, { action: "status", status: "realizada" })
                                }
                              >
                                Realizada
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                disabled={busy === booking.id}
                                onClick={() =>
                                  void act(booking.id, { action: "status", status: "no_show" })
                                }
                              >
                                No asistió
                              </Button>
                            </>
                          )}
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={busy === booking.id}
                            onClick={() => void act(booking.id, { action: "cancel" })}
                          >
                            {booking.kind === "block" ? "Quitar bloqueo" : "Cancelar"}
                          </Button>
                        </div>
                      )}
                      {editable && moving === booking.id && (
                        <div className="flex flex-wrap items-end gap-2 rounded-sm bg-subtle p-2">
                          <div className="space-y-1.5">
                            <Label htmlFor={`move-${booking.id}`}>Nuevo inicio</Label>
                            <Input
                              id={`move-${booking.id}`}
                              type="datetime-local"
                              value={moveAt}
                              onChange={(event) => setMoveAt(event.target.value)}
                              className="w-56"
                            />
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            disabled={busy === booking.id || !moveAt}
                            onClick={() => {
                              const instant = new Date(moveAt);
                              if (Number.isNaN(instant.getTime())) {
                                setListError("Indica fecha y hora.");
                                return;
                              }
                              void act(booking.id, {
                                action: "reschedule",
                                startUtc: instant.toISOString(),
                              });
                            }}
                          >
                            Mover
                          </Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function CreateSession({
  staffId,
  offered,
  onCreated,
}: {
  staffId: string;
  offered: Offered[];
  onCreated: () => void;
}) {
  const [serviceId, setServiceId] = useState("");
  const [when, setWhen] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alternatives, setAlternatives] = useState<SlotChoice[]>([]);

  async function create(startUtc: string) {
    if (!serviceId) {
      setError("Elige uno de tus servicios.");
      return;
    }
    if (!contactName.trim() || contactPhone.trim().length < 5) {
      setError("Indica el nombre y un teléfono del cliente.");
      return;
    }
    setSaving(true);
    setError(null);
    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "session",
        staffId,
        serviceId,
        contact: { name: contactName.trim(), phone: contactPhone.trim() },
        startUtc,
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      }),
    }).catch(() => null);
    setSaving(false);
    if (res?.status !== 201) {
      const data = (await res?.json().catch(() => null)) as {
        error?: { message?: string };
        slots?: unknown;
      } | null;
      setError(data?.error?.message?.trim() || "No se pudo agendar");
      setAlternatives(parseSlots(data?.slots));
      return;
    }
    setWhen("");
    setNotes("");
    setAlternatives([]);
    onCreated();
  }

  if (offered.length === 0) {
    return (
      <p className="text-sm text-text-2">
        Todavía no ofreces servicios. Márcalos en{" "}
        <Link href="/my-profile" className="font-semibold text-brand-text hover:underline">
          Mi perfil
        </Link>
        .
      </p>
    );
  }

  return (
    <section className="space-y-3 rounded-md border bg-subtle p-4">
      <h3 className="text-sm font-semibold">Agendar</h3>
      <p className="text-sm text-text-2">
        Solo para ti y solo con un servicio que ofreces. No se reasigna a otra persona.
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="agenda-service">Servicio</Label>
          <select
            id="agenda-service"
            className="h-9 w-full rounded-md border border-input bg-card px-2 text-sm"
            value={serviceId}
            onChange={(event) => setServiceId(event.target.value)}
          >
            <option value="">Elegir…</option>
            {offered.map((service) => (
              <option key={service.id} value={service.id}>
                {service.name} · {service.effectiveDurationMinutes} min ·{" "}
                {formatMoneyCents(service.priceCents, service.currency) ?? ""}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="agenda-when">Inicio</Label>
          <Input
            id="agenda-when"
            type="datetime-local"
            value={when}
            onChange={(event) => setWhen(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="agenda-contact">Cliente</Label>
          <Input
            id="agenda-contact"
            value={contactName}
            maxLength={120}
            onChange={(event) => setContactName(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="agenda-phone">Teléfono</Label>
          <Input
            id="agenda-phone"
            value={contactPhone}
            maxLength={40}
            onChange={(event) => setContactPhone(event.target.value)}
          />
        </div>
        <div className="space-y-1.5 md:col-span-2">
          <Label htmlFor="agenda-notes">Notas</Label>
          <Textarea
            id="agenda-notes"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </div>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {alternatives.length > 0 && (
        <div className="space-y-1">
          <p className="text-sm text-text-2">Horarios que sí se pueden usar:</p>
          {alternatives.map((slot) => (
            <button
              key={slot.startUtc}
              type="button"
              className="block w-full rounded-sm px-2 py-1 text-left text-sm hover:bg-accent"
              onClick={() => void create(slot.startUtc)}
            >
              {slot.label}
            </button>
          ))}
        </div>
      )}
      <Button
        type="button"
        disabled={saving || !serviceId || !when}
        onClick={() => {
          const instant = new Date(when);
          if (Number.isNaN(instant.getTime())) {
            setError("Indica fecha y hora.");
            return;
          }
          void create(instant.toISOString());
        }}
      >
        {saving ? "Agendando…" : "Agendar"}
      </Button>
    </section>
  );
}

async function readTimeZone(role: Role): Promise<string> {
  const browser = Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_TZ;
  // El staff recibe 403 en ajustes del calendario. No se llama al tablero.
  if (role === "staff") return browser;
  const res = await fetch("/api/calendar/settings").catch(() => null);
  if (!res?.ok) return browser;
  const data = (await res.json().catch(() => null)) as {
    settings?: { timezone?: unknown };
  } | null;
  return typeof data?.settings?.timezone === "string" && data.settings.timezone
    ? data.settings.timezone
    : browser;
}

function safeToday(timeZone: string): string {
  try {
    return todayInTz(new Date(), timeZone);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function dayHeading(date: string, timeZone: string): string {
  const noon = zonedWallClockToUtc(date, "12:00", timeZone);
  if (!noon) return date;
  const label = new Intl.DateTimeFormat("es-MX", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(noon);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function startOf(booking: AgendaBooking): string {
  return booking.scheduledAtUtc ?? booking.startUtc ?? "";
}

function dayOf(booking: AgendaBooking, timeZone: string): string {
  const iso = startOf(booking);
  if (!iso) return "";
  try {
    return dayIsoInTz(new Date(iso), timeZone);
  } catch {
    return "";
  }
}

function toDatetimeLocal(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseMe(value: unknown): { role: Role; staffId: string | null } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { role?: unknown; staffId?: unknown };
  if (record.role !== "owner" && record.role !== "reception" && record.role !== "staff") {
    return null;
  }
  return {
    role: record.role,
    staffId: typeof record.staffId === "string" && record.staffId ? record.staffId : null,
  };
}

function parseBookings(value: unknown): AgendaBooking[] {
  if (!Array.isArray(value)) return [];
  const out: AgendaBooking[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    if (typeof record.id !== "string") continue;
    if (record.kind !== "session" && record.kind !== "block") continue;
    out.push({
      id: record.id,
      kind: record.kind,
      status: typeof record.status === "string" ? record.status : "",
      scheduledAtUtc: typeof record.scheduledAtUtc === "string" ? record.scheduledAtUtc : undefined,
      startUtc: typeof record.startUtc === "string" ? record.startUtc : undefined,
      durationMinutes: typeof record.durationMinutes === "number" ? record.durationMinutes : 0,
      priceCents: typeof record.priceCents === "number" ? record.priceCents : null,
      currency: typeof record.currency === "string" ? record.currency : null,
      notes: typeof record.notes === "string" ? record.notes : null,
      contact: parseContact(record.contact),
      staff: parseRef(record.staff),
      service: parseRef(record.service),
    });
  }
  return out;
}

function parseContact(value: unknown): AgendaBooking["contact"] {
  if (!value || typeof value !== "object") return null;
  const record = value as { name?: unknown; phone?: unknown };
  if (typeof record.name !== "string") return null;
  return { name: record.name, phone: typeof record.phone === "string" ? record.phone : null };
}

function parseRef(value: unknown): { id: string; name: string } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { id?: unknown; name?: unknown };
  if (typeof record.id !== "string") return null;
  return { id: record.id, name: typeof record.name === "string" ? record.name : "" };
}

function parseOffered(value: unknown): Offered[] {
  if (!Array.isArray(value)) return [];
  const out: Offered[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const id = typeof record.serviceId === "string" ? record.serviceId : null;
    if (!id || typeof record.name !== "string") continue;
    out.push({
      id,
      name: record.name,
      effectiveDurationMinutes:
        typeof record.effectiveDurationMinutes === "number" ? record.effectiveDurationMinutes : 0,
      priceCents: typeof record.priceCents === "number" ? record.priceCents : 0,
      currency: typeof record.currency === "string" ? record.currency : "MXN",
    });
  }
  return out;
}

function parseSlots(value: unknown): SlotChoice[] {
  if (!Array.isArray(value)) return [];
  const out: SlotChoice[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const record = row as { startUtc?: unknown; label?: unknown; time?: unknown };
    if (typeof record.startUtc !== "string") continue;
    const label =
      typeof record.label === "string" && record.label.trim()
        ? record.label
        : typeof record.time === "string"
          ? record.time
          : record.startUtc;
    out.push({ startUtc: record.startUtc, label });
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
