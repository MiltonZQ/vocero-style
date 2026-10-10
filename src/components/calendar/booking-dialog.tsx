"use client";

import { useEffect, useRef, useState } from "react";
import { formatMoneyCents } from "@/lib/money";
import { labelInTz } from "@/lib/time/slots";
import type { BoardBooking } from "@/server/agenda/board";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type ColumnHint = {
  staffId: string;
  displayName: string;
  active: boolean;
};

type OfferedService = {
  id: string;
  name: string;
  priceCents: number;
  currency: string;
  effectiveDurationMinutes: number;
};

type Quote = {
  durationMinutes: number | null;
  priceCents: number | null;
  currency: string | null;
};

type SlotChoice = { startUtc: string; label: string };

type ContactHit = { id: string; name: string; phone: string | null };

type BookingDetail = {
  id: string;
  kind: "session" | "block";
  status: string;
  durationMinutes: number;
  priceCents: number | null;
  currency: string | null;
  notes: string | null;
  contact: { name: string; phone: string | null } | null;
  staff: { id: string; name: string } | null;
  service: { id: string; name: string } | null;
};

type StaffChoice = { id: string; displayName: string };

const STATUS_LABEL: Record<string, string> = {
  agendada: "Agendada",
  realizada: "Realizada",
  no_show: "No asistió",
  cancelada: "Cancelada",
};

const selectClass = "h-9 w-full rounded-md border border-input bg-card px-2 text-sm";

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

function parseServices(payload: unknown): OfferedService[] {
  if (!payload || typeof payload !== "object") return [];
  const services = (payload as { services?: unknown }).services;
  if (!Array.isArray(services)) return [];
  const out: OfferedService[] = [];
  for (const row of services) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const id =
      typeof record.serviceId === "string"
        ? record.serviceId
        : typeof record.id === "string"
          ? record.id
          : null;
    if (!id || typeof record.name !== "string") continue;
    if (record.active === false) continue;
    out.push({
      id,
      name: record.name,
      priceCents: typeof record.priceCents === "number" ? record.priceCents : 0,
      currency: typeof record.currency === "string" ? record.currency : "MXN",
      effectiveDurationMinutes:
        typeof record.effectiveDurationMinutes === "number"
          ? record.effectiveDurationMinutes
          : 0,
    });
  }
  return out;
}

function parseSlots(payload: unknown): Array<{
  startUtc: string;
  label: string;
  durationMinutes: number | null;
  priceCents: number | null;
}> {
  if (!payload || typeof payload !== "object") return [];
  const slots = (payload as { slots?: unknown }).slots;
  if (!Array.isArray(slots)) return [];
  const out: Array<{
    startUtc: string;
    label: string;
    durationMinutes: number | null;
    priceCents: number | null;
  }> = [];
  for (const row of slots) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    if (typeof record.startUtc !== "string") continue;
    const label =
      typeof record.label === "string" && record.label.trim()
        ? record.label
        : typeof record.time === "string"
          ? record.time
          : record.startUtc;
    out.push({
      startUtc: record.startUtc,
      label,
      durationMinutes: typeof record.durationMinutes === "number" ? record.durationMinutes : null,
      priceCents: typeof record.priceCents === "number" ? record.priceCents : null,
    });
  }
  return out;
}

async function readFailure(res: Response | null): Promise<{
  message: string;
  code: string | null;
  slots: SlotChoice[];
}> {
  const data = (await res?.json().catch(() => null)) as {
    error?: { code?: string; message?: string };
    slots?: unknown;
  } | null;
  const slots = parseSlots({ slots: data?.slots }).map((slot) => ({
    startUtc: slot.startUtc,
    label: slot.label,
  }));
  return {
    code: data?.error?.code ?? null,
    message: data?.error?.message ?? "No se pudo completar la acción",
    slots,
  };
}

function isRecoverable(code: string | null): boolean {
  return code === "slot_taken" || code === "service_not_offered";
}

export function BookingDialog({
  timeZone,
  day,
  columns,
  draft,
  onClose,
  onChanged,
}: {
  timeZone: string;
  day: string;
  columns: ColumnHint[];
  draft:
    | { mode: "create"; staffId: string; startUtc: string }
    | { mode: "existing"; booking: BoardBooking };
  onClose: () => void;
  onChanged: () => void;
}) {
  const [staffId, setStaffId] = useState(draft.mode === "create" ? draft.staffId : "");
  const [startUtc, setStartUtc] = useState(draft.mode === "create" ? draft.startUtc : "");
  const [serviceId, setServiceId] = useState("");
  const [services, setServices] = useState<OfferedService[]>([]);
  const [quote, setQuote] = useState<Quote>({
    durationMinutes: null,
    priceCents: null,
    currency: null,
  });
  const [staffChoices, setStaffChoices] = useState<StaffChoice[]>([]);
  const [contactQuery, setContactQuery] = useState("");
  const [contacts, setContacts] = useState<ContactHit[]>([]);
  const [contactId, setContactId] = useState<string | null>(null);
  const [contactName, setContactName] = useState<string | null>(null);
  const [quickName, setQuickName] = useState("");
  const [quickPhone, setQuickPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [detail, setDetail] = useState<BookingDetail | null>(null);
  const [detailFailed, setDetailFailed] = useState(false);
  const [reassignTo, setReassignTo] = useState("");
  const [reassignChoices, setReassignChoices] = useState<StaffChoice[]>([]);
  const [moveSlots, setMoveSlots] = useState<SlotChoice[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alternatives, setAlternatives] = useState<SlotChoice[]>([]);
  const [alternativeHint, setAlternativeHint] = useState<SlotChoice[]>([]);
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (draft.mode !== "create") return;
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/staff").catch(() => null);
      if (cancelled) return;
      if (!res?.ok) {
        setStaffChoices(
          columnsRef.current
            .filter((column) => column.active)
            .map((column) => ({ id: column.staffId, displayName: column.displayName }))
        );
        return;
      }
      const data = (await res.json()) as {
        staff?: Array<{ id: string; displayName: string; active: boolean }>;
      };
      const active = (data.staff ?? []).filter((person) => person.active);
      setStaffChoices(active.map((person) => ({ id: person.id, displayName: person.displayName })));
    })();
    return () => {
      cancelled = true;
    };
  }, [draft.mode]);

  useEffect(() => {
    if (draft.mode !== "create" || !staffId) return;
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/staff/${encodeURIComponent(staffId)}/services`).catch(
        () => null
      );
      const list = res?.ok ? parseServices(await res.json()) : [];
      if (cancelled) return;
      setServices(list);
      setServiceId((current) => {
        if (current && list.some((service) => service.id === current)) return current;
        return list.length === 1 ? (list[0]?.id ?? "") : "";
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [draft.mode, staffId]);

  useEffect(() => {
    if (draft.mode !== "create" || !staffId || !serviceId) {
      if (draft.mode === "create") {
        setQuote({ durationMinutes: null, priceCents: null, currency: null });
      }
      return;
    }
    const service = services.find((item) => item.id === serviceId);
    let cancelled = false;
    void (async () => {
      const params = new URLSearchParams({
        staffId,
        serviceId,
        from: day,
        to: day,
      });
      const res = await fetch(`/api/calendar/availability?${params}`).catch(() => null);
      if (cancelled) return;
      const slots = res?.ok ? parseSlots(await res.json()) : [];
      if (slots.length === 0) {
        setQuote(
          service
            ? {
                durationMinutes: service.effectiveDurationMinutes,
                priceCents: service.priceCents,
                currency: service.currency,
              }
            : { durationMinutes: null, priceCents: null, currency: null }
        );
        return;
      }
      const match = slots.find((slot) => slot.startUtc === startUtc) ?? slots[0];
      setQuote({
        durationMinutes: match?.durationMinutes ?? service?.effectiveDurationMinutes ?? null,
        priceCents: match?.priceCents ?? service?.priceCents ?? null,
        currency: service?.currency ?? null,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [day, draft.mode, serviceId, services, staffId, startUtc]);

  useEffect(() => {
    if (draft.mode !== "create") return;
    const q = contactQuery.trim();
    if (q.length < 2) {
      setContacts([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const res = await fetch(`/api/contacts?q=${encodeURIComponent(q)}`).catch(() => null);
        if (!res?.ok || cancelled) return;
        const data = (await res.json()) as { contacts?: ContactHit[] };
        if (!cancelled) setContacts(data.contacts ?? []);
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [contactQuery, draft.mode]);

  useEffect(() => {
    if (draft.mode !== "existing") return;
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/bookings/${encodeURIComponent(draft.booking.id)}`).catch(
        () => null
      );
      if (cancelled) return;
      if (!res?.ok) {
        setDetailFailed(true);
        return;
      }
      const data = (await res.json()) as { booking?: BookingDetail };
      if (!data.booking) {
        setDetailFailed(true);
        return;
      }
      setDetail(data.booking);
    })();
    return () => {
      cancelled = true;
    };
  }, [draft]);

  useEffect(() => {
    if (draft.mode !== "existing") return;
    if (draft.booking.kind !== "session") return;
    const service = detail?.service?.id;
    let cancelled = false;
    void (async () => {
      if (!service) {
        if (!detailFailed) return;
        const fallback = columnsRef.current
          .filter((column) => column.active && column.staffId !== draft.booking.staffId)
          .map((column) => ({ id: column.staffId, displayName: column.displayName }));
        if (!cancelled) setReassignChoices(fallback);
        return;
      }
      const res = await fetch("/api/staff").catch(() => null);
      if (!res?.ok || cancelled) return;
      const data = (await res.json()) as {
        staff?: Array<{ id: string; displayName: string; active: boolean }>;
      };
      const active = (data.staff ?? []).filter(
        (person) => person.active && person.id !== (detail?.staff?.id ?? draft.booking.staffId)
      );
      const checks = await Promise.all(
        active.map(async (person) => {
          const servicesRes = await fetch(
            `/api/staff/${encodeURIComponent(person.id)}/services`
          ).catch(() => null);
          if (!servicesRes?.ok) return null;
          const offered = parseServices(await servicesRes.json());
          return offered.some((item) => item.id === service)
            ? { id: person.id, displayName: person.displayName }
            : null;
        })
      );
      if (!cancelled) {
        setReassignChoices(checks.filter((person): person is StaffChoice => person !== null));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [detail, detailFailed, draft]);

  useEffect(() => {
    if (draft.mode !== "existing" || !detail?.service?.id || !detail.staff?.id) {
      setMoveSlots([]);
      return;
    }
    if (detail.kind !== "session") return;
    let cancelled = false;
    void (async () => {
      const params = new URLSearchParams({
        staffId: detail.staff?.id ?? "",
        serviceId: detail.service?.id ?? "",
        from: day,
        to: day,
      });
      const res = await fetch(`/api/calendar/availability?${params}`).catch(() => null);
      if (!res?.ok || cancelled) return;
      const slots = parseSlots(await res.json()).map((slot) => ({
        startUtc: slot.startUtc,
        label: slot.label,
      }));
      if (!cancelled) setMoveSlots(slots);
    })();
    return () => {
      cancelled = true;
    };
  }, [day, detail, draft.mode]);

  function showFailure(
    failure: { message: string; code: string | null; slots: SlotChoice[] },
    canRetryAt: boolean
  ) {
    if (isRecoverable(failure.code)) {
      setError(failure.message);
      setAlternatives(canRetryAt ? failure.slots : []);
      setAlternativeHint(canRetryAt ? [] : failure.slots);
      return;
    }
    setAlternatives([]);
    setAlternativeHint([]);
    setError(failure.message);
  }

  async function createContact(): Promise<string | null> {
    if (contactId) return contactId;
    const name = quickName.trim();
    const phone = quickPhone.replace(/\D/g, "");
    if (!name && !phone) {
      setError("Elige un cliente o da de alta uno con nombre y teléfono");
      return null;
    }
    if (!name) {
      setError("Escribe el nombre del cliente");
      return null;
    }
    if (!/^\d{7,15}$/.test(phone)) {
      setError("Teléfono en dígitos, con código de país (ej. 5215512345678)");
      return null;
    }
    const res = await fetch("/api/contacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, phone }),
    }).catch(() => null);
    if (!res?.ok) {
      const failure = await readFailure(res);
      setError(failure.message);
      return null;
    }
    const data = (await res.json()) as { contact?: { id?: string; name?: string } };
    const id = data.contact?.id;
    if (!id) {
      setError("No se pudo crear el contacto");
      return null;
    }
    setContactId(id);
    setContactName(data.contact?.name ?? name);
    return id;
  }

  async function book(nextStart: string) {
    setStartUtc(nextStart);
    if (!staffId || !serviceId) {
      setError("Elige profesional y servicio");
      return;
    }
    setBusy(true);
    setError(null);
    setAlternatives([]);
    setAlternativeHint([]);
    const nextContact = await createContact();
    if (!nextContact) {
      setBusy(false);
      return;
    }
    const body: {
      kind: "session";
      staffId: string;
      serviceId: string;
      contactId: string;
      startUtc: string;
      notes?: string;
    } = {
      kind: "session",
      staffId,
      serviceId,
      contactId: nextContact,
      startUtc: nextStart,
    };
    const trimmed = notes.trim();
    if (trimmed) body.notes = trimmed;
    const res = await fetch("/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    setBusy(false);
    if (res?.status !== 201) {
      showFailure(await readFailure(res), true);
      return;
    }
    onChanged();
    onClose();
  }

  async function patch(body: { action: string; staffId?: string; startUtc?: string }) {
    if (draft.mode !== "existing") return;
    setBusy(true);
    setError(null);
    setAlternatives([]);
    setAlternativeHint([]);
    const res = await fetch(`/api/bookings/${encodeURIComponent(draft.booking.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      showFailure(await readFailure(res), body.action === "reschedule");
      return;
    }
    onChanged();
    onClose();
  }

  const price =
    quote.priceCents != null && quote.currency
      ? formatMoneyCents(quote.priceCents, quote.currency)
      : null;
  const when = draft.mode === "create" ? labelInTz(startUtc, timeZone) : "";
  const existing = draft.mode === "existing" ? draft.booking : null;
  const canReassign = existing?.kind === "session" && existing.status !== "cancelada";
  const canMove = canReassign && (detail?.service?.id != null || moveSlots.length > 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-overlay p-4 sm:items-center"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={draft.mode === "create" ? "Nueva cita" : "Cita"}
        className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-lg border bg-card p-4 shadow-pop"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="text-base font-semibold">
          {draft.mode === "create" ? "Nueva cita" : "Cita"}
        </h3>

        {draft.mode === "create" ? (
          <form
            className="mt-4 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void book(startUtc);
            }}
          >
            <p className="text-sm text-text-2">{when}</p>
            <div className="space-y-1.5">
              <Label htmlFor="cal-staff">Profesional</Label>
              <select
                id="cal-staff"
                className={selectClass}
                value={staffId}
                onChange={(event) => setStaffId(event.target.value)}
              >
                {staffId && !staffChoices.some((person) => person.id === staffId) && (
                  <option value={staffId}>
                    {columns.find((column) => column.staffId === staffId)?.displayName ??
                      "Profesional"}
                  </option>
                )}
                {staffChoices.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.displayName}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cal-service">Servicio</Label>
              <select
                id="cal-service"
                className={selectClass}
                value={serviceId}
                onChange={(event) => setServiceId(event.target.value)}
              >
                <option value="">Elige un servicio</option>
                {services.map((service) => (
                  <option key={service.id} value={service.id}>
                    {service.name}
                  </option>
                ))}
              </select>
              {(quote.durationMinutes != null || price) && (
                <p className="text-xs text-text-3">
                  {quote.durationMinutes != null ? `${quote.durationMinutes} min` : null}
                  {quote.durationMinutes != null && price ? " · " : null}
                  {price}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cal-contact">Cliente</Label>
              {contactId ? (
                <div className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                  <span className="truncate">{contactName}</span>
                  <button
                    type="button"
                    className="text-xs text-text-3 hover:text-foreground"
                    onClick={() => {
                      setContactId(null);
                      setContactName(null);
                    }}
                  >
                    Quitar
                  </button>
                </div>
              ) : (
                <>
                  <Input
                    id="cal-contact"
                    value={contactQuery}
                    placeholder="Buscar por nombre o teléfono"
                    onChange={(event) => setContactQuery(event.target.value)}
                  />
                  {contacts.length > 0 && (
                    <ul className="max-h-32 overflow-y-auto rounded-md border">
                      {contacts.map((contact) => (
                        <li key={contact.id}>
                          <button
                            type="button"
                            className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                            onClick={() => {
                              setContactId(contact.id);
                              setContactName(contact.name);
                              setContacts([]);
                              setContactQuery("");
                            }}
                          >
                            <span className="truncate">{contact.name}</span>
                            {contact.phone && (
                              <span className="shrink-0 text-xs text-text-3">{contact.phone}</span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <Input
                      aria-label="Nombre del cliente nuevo"
                      placeholder="Nombre"
                      value={quickName}
                      onChange={(event) => setQuickName(event.target.value)}
                    />
                    <Input
                      aria-label="Teléfono con código de país"
                      placeholder="5215512345678"
                      value={quickPhone}
                      onChange={(event) => setQuickPhone(event.target.value)}
                    />
                  </div>
                </>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cal-notes">Notas</Label>
              <Textarea
                id="cal-notes"
                rows={2}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </div>
            <Failure message={error} slots={alternatives} onPick={(slot) => void book(slot)} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cerrar
              </Button>
              <Button type="submit" disabled={busy}>
                Agendar
              </Button>
            </div>
          </form>
        ) : (
          existing && (
            <div className="mt-4 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={existing.status === "cancelada" ? "secondary" : "default"}>
                  {statusLabel(detail?.status ?? existing.status)}
                </Badge>
                {existing.kind === "block" && <Badge variant="secondary">Bloqueo</Badge>}
              </div>
              <p className="text-sm">
                {labelInTz(existing.startUtc, timeZone)}
                {detail?.contact?.name ? ` · ${detail.contact.name}` : ""}
              </p>
              {detail?.service && (
                <p className="text-sm text-text-2">
                  {detail.service.name}
                  {detail.durationMinutes ? ` · ${detail.durationMinutes} min` : ""}
                  {detail.priceCents != null && detail.currency
                    ? ` · ${formatMoneyCents(detail.priceCents, detail.currency)}`
                    : ""}
                </p>
              )}
              {(detail?.notes ?? existing.notes) && (
                <p className="text-sm text-text-3">{detail?.notes ?? existing.notes}</p>
              )}
              {detailFailed && (
                <p className="text-xs text-text-3">
                  No se cargó el detalle. Igual puedes cancelar
                  {existing.kind === "session" ? " o reasignar" : ""}.
                </p>
              )}

              {canReassign && (
                <div className="space-y-1.5">
                  <Label htmlFor="cal-reassign">Reasignar</Label>
                  <div className="flex gap-2">
                    <select
                      id="cal-reassign"
                      className={selectClass}
                      value={reassignTo}
                      onChange={(event) => setReassignTo(event.target.value)}
                    >
                      <option value="">Elige un profesional</option>
                      {reassignChoices.map((person) => (
                        <option key={person.id} value={person.id}>
                          {person.displayName}
                        </option>
                      ))}
                    </select>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy || !reassignTo}
                      onClick={() => void patch({ action: "reassign", staffId: reassignTo })}
                    >
                      Reasignar
                    </Button>
                  </div>
                  {detail?.service && reassignChoices.length === 0 && (
                    <p className="text-xs text-text-3">
                      Nadie más activo ofrece este servicio.
                    </p>
                  )}
                </div>
              )}

              {canMove && moveSlots.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-sm font-medium">Mover</p>
                  <ul className="max-h-36 space-y-1 overflow-y-auto">
                    {moveSlots.map((slot) => (
                      <li key={slot.startUtc}>
                        <button
                          type="button"
                          className="w-full rounded-md border px-2 py-1.5 text-left text-sm hover:bg-accent"
                          disabled={busy}
                          onClick={() =>
                            void patch({ action: "reschedule", startUtc: slot.startUtc })
                          }
                        >
                          {slot.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <Failure
                message={error}
                slots={alternatives}
                onPick={(slot) => void patch({ action: "reschedule", startUtc: slot })}
              />
              {alternativeHint.length > 0 && (
                <div className="space-y-1 text-sm text-text-2">
                  <p>Horarios libres de ese profesional. Reasignar no cambia la hora.</p>
                  <ul>
                    {alternativeHint.map((slot) => (
                      <li key={slot.startUtc}>{slot.label}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={onClose}>
                  Cerrar
                </Button>
                {existing.status !== "cancelada" &&
                  (confirmCancel ? (
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => void patch({ action: "cancel" })}
                    >
                      Confirmar cancelación
                    </Button>
                  ) : (
                    <Button type="button" variant="outline" onClick={() => setConfirmCancel(true)}>
                      Cancelar cita
                    </Button>
                  ))}
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}

function Failure({
  message,
  slots,
  onPick,
}: {
  message: string | null;
  slots: SlotChoice[];
  onPick: (startUtc: string) => void;
}) {
  if (!message) return null;
  return (
    <div className="space-y-2 rounded-md border border-danger-soft bg-danger-tint px-3 py-2">
      <p className="text-sm text-danger-text">{message}</p>
      {slots.length > 0 && (
        <ul className="space-y-1">
          {slots.map((slot) => (
            <li key={slot.startUtc}>
              <button
                type="button"
                className="text-left text-sm font-medium text-foreground underline-offset-2 hover:underline"
                onClick={() => onPick(slot.startUtc)}
              >
                {slot.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
