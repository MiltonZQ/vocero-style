"use client";

import { useCallback, useEffect, useState } from "react";
import { WEEKDAYS, type WeekdayKey } from "@/lib/time/slots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Horario semanal del profesional.
 *
 * La respuesta real es `inheritsShopHours`, no `inherits`. El recorte al
 * local llega en `effectiveWeeklyHours`, así el staff no necesita
 * GET /api/calendar/settings (ahí recibe 403).
 */

type Interval = { start: string; end: string };
type WeeklyHours = Partial<Record<WeekdayKey, Interval[]>>;

type HoursView = {
  weeklyHours: WeeklyHours | null;
  effectiveWeeklyHours: WeeklyHours;
  inheritsShopHours: boolean;
};

const DAY_LABEL: Record<WeekdayKey, string> = {
  mon: "Lunes",
  tue: "Martes",
  wed: "Miércoles",
  thu: "Jueves",
  fri: "Viernes",
  sat: "Sábado",
  sun: "Domingo",
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function HoursEditor({
  staffId,
  canEdit,
  canReadShopHours,
}: {
  staffId: string;
  canEdit: boolean;
  /** Dueño y recepción pueden leer la apertura. El staff no: es 403. */
  canReadShopHours: boolean;
}) {
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<HoursView | null>(null);
  const [draft, setDraft] = useState<WeeklyHours | null>(null);
  const [customizing, setCustomizing] = useState(false);
  const [shopHours, setShopHours] = useState<WeeklyHours | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setPhase("loading");
    setError(null);
    const res = await fetch(`/api/staff/${staffId}/hours`).catch(() => null);
    if (!res?.ok) {
      setError(await apiMessage(res, "No se pudo cargar el horario"));
      setPhase("error");
      return;
    }
    const parsed = parseHours(await res.json().catch(() => null));
    if (!parsed) {
      setError("El horario llegó en un formato inesperado");
      setPhase("error");
      return;
    }
    setView(parsed);
    setDraft(parsed.inheritsShopHours ? null : cloneHours(parsed.weeklyHours));
    setCustomizing(false);
    setPhase("ready");
  }, [staffId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!canReadShopHours) {
      setShopHours(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/calendar/settings").catch(() => null);
      if (!res?.ok || cancelled) return;
      const data = (await res.json().catch(() => null)) as {
        settings?: { weeklyHours?: unknown };
      } | null;
      if (cancelled) return;
      setShopHours(parseWeekly(data?.settings?.weeklyHours));
    })();
    return () => {
      cancelled = true;
    };
  }, [canReadShopHours, staffId]);

  async function save(weeklyHours: WeeklyHours | null) {
    if (!canEdit) return;
    if (weeklyHours) {
      const invalid = validate(weeklyHours);
      if (invalid) {
        setError(invalid);
        return;
      }
    }
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/staff/${staffId}/hours`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ weeklyHours }),
    }).catch(() => null);
    setSaving(false);
    if (!res?.ok) {
      setError(await apiMessage(res, "No se pudo guardar el horario"));
      return;
    }
    const parsed = parseHours(await res.json().catch(() => null));
    if (!parsed) {
      await load();
      return;
    }
    setView(parsed);
    setDraft(parsed.inheritsShopHours ? null : cloneHours(parsed.weeklyHours));
    setCustomizing(false);
  }

  function startCustom() {
    if (!view) return;
    setDraft(cloneHours(view.effectiveWeeklyHours));
    setCustomizing(true);
    setError(null);
  }

  if (phase === "loading") return <p className="text-sm text-text-2">Cargando horario…</p>;
  if (phase === "error" || !view) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-destructive">{error ?? "No se pudo cargar el horario"}</p>
        <Button type="button" variant="secondary" onClick={() => void load()}>
          Reintentar
        </Button>
      </div>
    );
  }

  const editing = canEdit && (customizing || draft !== null);
  const shown = editing && draft ? draft : null;

  return (
    <section className="space-y-3 rounded-md border bg-subtle p-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Horario</h3>
        <p className="text-sm text-text-2">
          {view.inheritsShopHours && !customizing
            ? "Usa el horario del local."
            : "El horario propio se recorta a la apertura del local. Lo que queda fuera no se ofrece."}
        </p>
      </div>

      {shopHours && (
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-2">
            Apertura del local
          </p>
          <HoursList hours={shopHours} />
        </div>
      )}

      <div className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-text-2">
          Horario que aplica
        </p>
        <HoursList hours={view.effectiveWeeklyHours} />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {canEdit && (
        <div className="flex flex-wrap gap-2">
          {!view.inheritsShopHours || customizing ? (
            <Button
              type="button"
              variant="secondary"
              disabled={saving}
              onClick={() => void save(null)}
            >
              Usar el horario del local
            </Button>
          ) : (
            <Button type="button" variant="secondary" onClick={startCustom}>
              Definir un horario propio
            </Button>
          )}
        </div>
      )}

      {editing && shown && (
        <div className="space-y-3">
          {WEEKDAYS.map((day) => {
            const intervals = shown[day] ?? [];
            const open = intervals.length > 0;
            const applied = view.effectiveWeeklyHours[day] ?? [];
            const outside = open && applied.length === 0;
            return (
              <div key={day} className="flex items-start gap-3">
                <button
                  type="button"
                  onClick={() => setDraft((current) => toggleDay(current ?? shown, day))}
                  className={cn(
                    "mt-1 w-24 shrink-0 rounded-sm px-2 py-1 text-left text-sm font-medium transition-colors",
                    open ? "bg-brand-tint text-brand-text" : "text-text-2 hover:bg-accent"
                  )}
                >
                  {DAY_LABEL[day]}
                </button>
                <div className="flex-1 space-y-1.5">
                  {!open && <span className="text-sm text-text-2">Cerrado</span>}
                  {intervals.map((interval, index) => (
                    <div key={index} className="flex flex-wrap items-center gap-2">
                      <Input
                        type="time"
                        value={interval.start}
                        aria-label={`${DAY_LABEL[day]} inicio`}
                        onChange={(event) =>
                          setDraft((current) =>
                            patchInterval(current ?? shown, day, index, {
                              start: event.target.value,
                            })
                          )
                        }
                        className="w-32"
                      />
                      <span className="text-sm text-text-2">a</span>
                      <Input
                        type="time"
                        value={interval.end}
                        aria-label={`${DAY_LABEL[day]} fin`}
                        onChange={(event) =>
                          setDraft((current) =>
                            patchInterval(current ?? shown, day, index, {
                              end: event.target.value,
                            })
                          )
                        }
                        className="w-32"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setDraft((current) => removeInterval(current ?? shown, day, index))
                        }
                      >
                        Quitar
                      </Button>
                    </div>
                  ))}
                  {open && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setDraft((current) => addInterval(current ?? shown, day))}
                    >
                      Añadir franja
                    </Button>
                  )}
                  {open && applied.length > 0 && (
                    <p className="text-xs text-text-2">Aplica {formatRanges(applied)}</p>
                  )}
                  {outside && (
                    <p className="text-xs text-text-2">
                      Ese día queda fuera de la apertura del local.
                    </p>
                  )}
                </div>
              </div>
            );
          })}
          <Button type="button" disabled={saving} onClick={() => void save(shown)}>
            {saving ? "Guardando…" : "Guardar horario"}
          </Button>
        </div>
      )}
    </section>
  );
}

function HoursList({ hours }: { hours: WeeklyHours }) {
  const openDays = WEEKDAYS.filter((day) => (hours[day]?.length ?? 0) > 0);
  if (openDays.length === 0) {
    return <p className="text-sm text-text-2">Sin franjas.</p>;
  }
  return (
    <ul className="space-y-1 text-sm text-text-2">
      {openDays.map((day) => (
        <li key={day}>
          <span className="font-medium text-foreground">{DAY_LABEL[day]}.</span>{" "}
          {formatRanges(hours[day] ?? [])}
        </li>
      ))}
    </ul>
  );
}

function formatRanges(intervals: Interval[]): string {
  if (intervals.length === 0) return "Cerrado";
  return intervals.map((interval) => `${interval.start}–${interval.end}`).join(", ");
}

function cloneHours(hours: WeeklyHours | null): WeeklyHours {
  const out: WeeklyHours = {};
  if (!hours) return out;
  for (const day of WEEKDAYS) {
    const rows = hours[day];
    if (rows && rows.length > 0) out[day] = rows.map((row) => ({ ...row }));
  }
  return out;
}

function toggleDay(hours: WeeklyHours, day: WeekdayKey): WeeklyHours {
  const next = { ...hours };
  if ((next[day]?.length ?? 0) > 0) delete next[day];
  else next[day] = [{ start: "09:00", end: "18:00" }];
  return next;
}

function patchInterval(
  hours: WeeklyHours,
  day: WeekdayKey,
  index: number,
  patch: Partial<Interval>
): WeeklyHours {
  const rows = [...(hours[day] ?? [])];
  const current = rows[index];
  if (!current) return hours;
  rows[index] = { ...current, ...patch };
  return { ...hours, [day]: rows };
}

function addInterval(hours: WeeklyHours, day: WeekdayKey): WeeklyHours {
  return {
    ...hours,
    [day]: [...(hours[day] ?? []), { start: "16:00", end: "18:00" }],
  };
}

function removeInterval(hours: WeeklyHours, day: WeekdayKey, index: number): WeeklyHours {
  const rows = (hours[day] ?? []).filter((_, i) => i !== index);
  const next = { ...hours };
  if (rows.length === 0) delete next[day];
  else next[day] = rows;
  return next;
}

function validate(hours: WeeklyHours): string | null {
  let count = 0;
  for (const day of WEEKDAYS) {
    for (const interval of hours[day] ?? []) {
      count += 1;
      if (!HHMM.test(interval.start) || !HHMM.test(interval.end) || interval.start >= interval.end) {
        return `${DAY_LABEL[day]}: la franja tiene que ir de una hora a otra posterior.`;
      }
    }
  }
  if (count === 0) {
    return "Deja al menos una franja, o usa el horario del local.";
  }
  return null;
}

function parseHours(value: unknown): HoursView | null {
  if (!value || typeof value !== "object") return null;
  const record = value as {
    weeklyHours?: unknown;
    effectiveWeeklyHours?: unknown;
    inheritsShopHours?: unknown;
    inherits?: unknown;
  };
  if (record.effectiveWeeklyHours == null || typeof record.effectiveWeeklyHours !== "object") {
    return null;
  }
  return {
    weeklyHours: record.weeklyHours == null ? null : parseWeekly(record.weeklyHours),
    effectiveWeeklyHours: parseWeekly(record.effectiveWeeklyHours),
    inheritsShopHours: record.inheritsShopHours === true || record.inherits === true,
  };
}

function parseWeekly(value: unknown): WeeklyHours {
  const out: WeeklyHours = {};
  if (!value || typeof value !== "object") return out;
  const source = value as Record<string, unknown>;
  for (const day of WEEKDAYS) {
    const rows = source[day];
    if (!Array.isArray(rows)) continue;
    const intervals: Interval[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const start = (row as { start?: unknown }).start;
      const end = (row as { end?: unknown }).end;
      if (typeof start === "string" && typeof end === "string") {
        intervals.push({ start, end });
      }
    }
    if (intervals.length > 0) out[day] = intervals;
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
