"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { BoardBooking, BoardColumn, CalendarBoard } from "@/server/agenda/board";
import { addDaysISO, timeInTz, todayInTz, zonedWallClockToUtc } from "@/lib/time/slots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useEvents } from "@/components/use-events";
import { BookingDialog } from "@/components/calendar/booking-dialog";
import { StaffFilter } from "@/components/calendar/staff-filter";
import {
  clipToWindow,
  closedGaps,
  containsMinute,
  formatMinute,
  eventFrame,
  gridWindow,
  minutesOnDay,
  offsetPx,
  parseHHMM,
  trackHeight,
  trackTop,
  placeSideBySide,
  snapMinutes,
  wallMinuteToUtc,
  type MinuteSpan,
} from "@/components/calendar/layout";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FALLBACK_TZ = "America/Mexico_City";
const STATUS_LABEL: Record<string, string> = {
  agendada: "Agendada",
  realizada: "Realizada",
  no_show: "No asistió",
  cancelada: "Cancelada",
};

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

function isBoard(value: unknown): value is CalendarBoard {
  if (!value || typeof value !== "object") return false;
  const board = value as CalendarBoard;
  return (
    typeof board.timeZone === "string" &&
    Array.isArray(board.columns) &&
    Array.isArray(board.days) &&
    Array.isArray(board.shopBlocks)
  );
}

async function readTimeZone(): Promise<{ timeZone: string; fallback: boolean }> {
  const res = await fetch("/api/calendar/settings").catch(() => null);
  if (!res?.ok) return { timeZone: FALLBACK_TZ, fallback: true };
  const data = (await res.json()) as { settings?: { timezone?: unknown } };
  const timeZone = data.settings?.timezone;
  if (typeof timeZone !== "string" || !timeZone) return { timeZone: FALLBACK_TZ, fallback: true };
  return { timeZone, fallback: false };
}

function safeToday(timeZone: string): string | null {
  try {
    const day = todayInTz(new Date(), timeZone);
    return ISO_DATE.test(day) ? day : null;
  } catch {
    return null;
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

function dayChip(date: string, timeZone: string): string {
  const noon = zonedWallClockToUtc(date, "12:00", timeZone);
  if (!noon) return date;
  return new Intl.DateTimeFormat("es-MX", {
    timeZone,
    weekday: "short",
    day: "numeric",
  }).format(noon);
}

function openIntervals(hours: Array<{ start: string; end: string }>): MinuteSpan[] {
  const open: MinuteSpan[] = [];
  for (const hour of hours) {
    const start = parseHHMM(hour.start);
    const end = parseHHMM(hour.end);
    if (start == null || end == null || end <= start) continue;
    open.push({ start, end });
  }
  return open;
}

export function CalendarBoard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fromParam = searchParams.get("from") ?? "";
  const daysParam = searchParams.get("days") === "7" ? 7 : 1;
  const staffId = searchParams.get("staffId") ?? "";
  const jobTitle = (searchParams.get("jobTitle") ?? "").trim().toLowerCase();
  const fromOk = ISO_DATE.test(fromParam);
  const daysOk = searchParams.get("days") === "1" || searchParams.get("days") === "7";

  const [board, setBoard] = useState<CalendarBoard | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [picked, setPicked] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    | { mode: "create"; staffId: string; startUtc: string }
    | { mode: "existing"; booking: BoardBooking }
    | null
  >(null);
  const guessedFromFallback = useRef(false);
  const requestId = useRef(0);

  const query = fromOk
    ? (() => {
        const qs = new URLSearchParams({ from: fromParam, days: String(daysParam) });
        if (staffId) qs.set("staffId", staffId);
        if (jobTitle) qs.set("jobTitle", jobTitle);
        return qs.toString();
      })()
    : null;
  const queryRef = useRef(query);
  queryRef.current = query;

  function patchQuery(patch: Record<string, string | null>, mode: "push" | "replace") {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (!value) next.delete(key);
      else next.set(key, value);
    }
    const href = next.toString() ? `/calendar?${next.toString()}` : "/calendar";
    if (mode === "push") router.push(href, { scroll: false });
    else router.replace(href, { scroll: false });
  }

  const load = useCallback(async (silent: boolean) => {
    const current = queryRef.current;
    if (!current) return;
    const id = ++requestId.current;
    if (!silent) setPhase("loading");
    const res = await fetch(`/api/calendar/board?${current}`).catch(() => null);
    if (id !== requestId.current) return;
    if (!res?.ok) {
      if (!silent) setPhase("error");
      return;
    }
    const data: unknown = await res.json().catch(() => null);
    if (id !== requestId.current) return;
    if (!isBoard(data)) {
      if (!silent) setPhase("error");
      return;
    }
    if (guessedFromFallback.current && data.timeZone !== FALLBACK_TZ) {
      guessedFromFallback.current = false;
      const corrected = safeToday(data.timeZone);
      const requested = new URLSearchParams(current).get("from");
      if (corrected && requested && corrected !== requested) {
        const next = new URLSearchParams(current);
        next.set("from", corrected);
        router.replace(`/calendar?${next.toString()}`, { scroll: false });
        return;
      }
    }
    guessedFromFallback.current = false;
    setBoard(data);
    setPhase("ready");
  }, [router]);

  useEffect(() => {
    if (fromOk && daysOk) return;
    let cancelled = false;
    void (async () => {
      // Lee la URL al volver: un clic en Semana durante la espera no debe
      // volver a Día con los params que había al montar.
      const zone = fromOk ? null : await readTimeZone();
      if (cancelled) return;
      const next = new URLSearchParams(window.location.search);
      if (next.get("days") !== "1" && next.get("days") !== "7") next.set("days", "1");
      if (!ISO_DATE.test(next.get("from") ?? "")) {
        if (zone) guessedFromFallback.current = zone.fallback;
        const today = safeToday(zone?.timeZone ?? FALLBACK_TZ) ?? safeToday(FALLBACK_TZ);
        if (!today) return;
        next.set("from", today);
      }
      const href = `/calendar?${next.toString()}`;
      if (`${window.location.pathname}${window.location.search}` === href) return;
      router.replace(href, { scroll: false });
    })();
    return () => {
      cancelled = true;
    };
  }, [daysOk, fromOk, router]);

  useEffect(() => {
    if (!query) return;
    void load(false);
  }, [load, query]);

  useEvents({
    onBookingUpdated: () => void load(true),
    onReconnect: () => void load(true),
  });

  const visibleDate =
    board?.days.find((day) => day.date === picked)?.date ?? board?.days[0]?.date ?? null;

  const columnHours = (column: BoardColumn) =>
    column.days.find((day) => day.date === visibleDate)?.hours ?? [];

  const occupied: MinuteSpan[] = [];
  if (board && visibleDate) {
    for (const column of board.columns) {
      for (const booking of column.days.find((day) => day.date === visibleDate)?.bookings ?? []) {
        const start = minutesOnDay(booking.startUtc, visibleDate, board.timeZone);
        const end = minutesOnDay(booking.endUtc, visibleDate, board.timeZone);
        if (start == null || end == null) continue;
        occupied.push({ start, end });
      }
    }
    for (const block of board.shopBlocks) {
      const start = minutesOnDay(block.startUtc, visibleDate, board.timeZone);
      const end = minutesOnDay(block.endUtc, visibleDate, board.timeZone);
      if (start == null || end == null) continue;
      occupied.push({ start, end });
    }
  }

  const hourSource = board?.columns.flatMap((column) => columnHours(column)) ?? [];
  const grid = board && visibleDate ? gridWindow(hourSource, occupied) : null;
  const gridHeight = grid ? trackHeight(grid.start, grid.end) : 0;

  function shift(direction: -1 | 1) {
    if (!fromOk) return;
    patchQuery({ from: addDaysISO(fromParam, direction * daysParam) }, "push");
  }

  function openCreate(column: BoardColumn, event: React.MouseEvent<HTMLDivElement>) {
    if (!board || !visibleDate || !grid || !column.active) return;
    const open = openIntervals(columnHours(column));
    if (open.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.height <= 0) return;
    const ratio = (event.clientY - rect.top) / rect.height;
    const minute = snapMinutes(grid.start + ratio * (grid.end - grid.start), 15);
    if (!containsMinute(open, minute)) return;
    const blocked = board.shopBlocks.some((block) => {
      const start = minutesOnDay(block.startUtc, visibleDate, board.timeZone);
      const end = minutesOnDay(block.endUtc, visibleDate, board.timeZone);
      return start != null && end != null && minute >= start && minute < end;
    });
    if (blocked) return;
    const startUtc = wallMinuteToUtc(visibleDate, minute, board.timeZone);
    if (!startUtc) return;
    setDialog({ mode: "create", staffId: column.staffId, startUtc });
  }

  const hints =
    board?.columns.map((column) => ({
      staffId: column.staffId,
      displayName: column.displayName,
      active: column.active,
    })) ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3 sm:px-6">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="icon"
            variant="outline"
            aria-label={daysParam === 7 ? "Semana anterior" : "Día anterior"}
            onClick={() => shift(-1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="outline"
            aria-label={daysParam === 7 ? "Semana siguiente" : "Día siguiente"}
            onClick={() => shift(1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <p className="min-w-0 flex-1 truncate text-sm font-semibold">
          {board && visibleDate ? dayHeading(visibleDate, board.timeZone) : "Calendario"}
        </p>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant={daysParam === 1 ? "default" : "outline"}
            onClick={() => patchQuery({ days: "1" }, "push")}
          >
            Día
          </Button>
          <Button
            type="button"
            size="sm"
            variant={daysParam === 7 ? "default" : "outline"}
            onClick={() => patchQuery({ days: "7" }, "push")}
          >
            Semana
          </Button>
        </div>
        <StaffFilter />
      </div>

      {board && daysParam === 7 && (
        <div className="flex gap-1 overflow-x-auto border-b px-4 py-2 sm:px-6">
          {board.days.map((day) => (
            <button
              key={day.date}
              type="button"
              className={
                day.date === visibleDate
                  ? "shrink-0 rounded-full bg-brand-tint px-3 py-1 text-xs font-semibold text-brand-text"
                  : "shrink-0 rounded-full px-3 py-1 text-xs font-semibold text-text-2 hover:bg-accent"
              }
              onClick={() => setPicked(day.date)}
            >
              {dayChip(day.date, board.timeZone)}
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {phase === "loading" && !board && (
          <p className="px-4 py-6 text-sm text-text-3 sm:px-6">Cargando el calendario…</p>
        )}
        {phase === "error" && !board && (
          <p className="px-4 py-6 text-sm text-danger-text sm:px-6">
            No se pudo cargar el calendario.
          </p>
        )}
        {board && board.columns.length === 0 && phase !== "loading" && (
          <p className="px-4 py-6 text-sm text-text-3 sm:px-6">
            No hay profesionales para este filtro.
          </p>
        )}
        {board && grid && visibleDate && board.columns.length > 0 && (
          <div style={{ minWidth: 56 + board.columns.length * 148 }}>
            <div className="sticky top-0 z-20 flex border-b bg-background">
              <div className="w-14 shrink-0" />
              {board.columns.map((column) => (
                <div key={column.staffId} className="min-w-[9.25rem] flex-1 basis-[9.25rem] px-2 py-2">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ background: column.color ?? "var(--brand)" }}
                    />
                    <span className="truncate text-sm font-semibold">{column.displayName}</span>
                  </div>
                  {column.jobTitle && (
                    <p className="truncate text-[11px] text-text-3">{column.jobTitle}</p>
                  )}
                  {column.needsReassignment && (
                    <Badge variant="warning" className="mt-1">
                      Por reasignar
                    </Badge>
                  )}
                </div>
              ))}
            </div>

            <div className="relative flex">
              <div className="relative w-14 shrink-0" style={{ height: gridHeight }}>
                {hourMarks(grid.start, grid.end).map((minute) => (
                  <span
                    key={minute}
                    className={
                      minute === grid.start
                        ? "absolute right-1 font-mono text-[10px] leading-none text-text-3"
                        : "absolute right-1 -translate-y-1/2 font-mono text-[10px] leading-none text-text-3"
                    }
                    style={{ top: trackTop(minute, grid.start) }}
                  >
                    {formatMinute(minute)}
                  </span>
                ))}
              </div>
              <div className="relative flex flex-1">
                {hourMarks(grid.start, grid.end).map((minute) => (
                  <div
                    key={minute}
                    className="pointer-events-none absolute inset-x-0 z-0 border-t border-border"
                    style={{ top: trackTop(minute, grid.start) }}
                  />
                ))}
                {board.columns.map((column, columnIndex) => {
                  const hours = columnHours(column);
                  const open = openIntervals(hours);
                  const gaps = closedGaps(open, grid.start, grid.end);
                  const bookings = (column.days.find((day) => day.date === visibleDate)?.bookings ??
                    [])
                    .flatMap((booking) => {
                      const start = minutesOnDay(booking.startUtc, visibleDate, board.timeZone);
                      const end = minutesOnDay(booking.endUtc, visibleDate, board.timeZone);
                      if (start == null || end == null) return [];
                      const clipped = clipToWindow(start, end, grid.start, grid.end);
                      if (!clipped) return [];
                      return [{ ...booking, start: clipped.start, end: clipped.end }];
                    });
                  const placed = placeSideBySide(bookings);
                  return (
                    <div
                      key={column.staffId}
                      className="relative min-w-[9.25rem] flex-1 basis-[9.25rem] border-l"
                      style={{ height: gridHeight }}
                      onClick={(event) => openCreate(column, event)}
                    >
                      {gaps.map((gap) => (
                        <div
                          key={`${gap.start}-${gap.end}`}
                          className="pointer-events-none absolute inset-x-0 bg-subtle"
                          style={{
                            top: trackTop(gap.start, grid.start),
                            height: offsetPx(gap.end, gap.start),
                          }}
                        />
                      ))}
                      {open.length === 0 && (
                        <p className="pointer-events-none absolute left-2 top-2 z-10 text-[11px] text-text-3">
                          Cerrado
                        </p>
                      )}
                      {board.shopBlocks.map((block) => {
                        const start = minutesOnDay(block.startUtc, visibleDate, board.timeZone);
                        const end = minutesOnDay(block.endUtc, visibleDate, board.timeZone);
                        if (start == null || end == null) return null;
                        const clipped = clipToWindow(start, end, grid.start, grid.end);
                        if (!clipped) return null;
                        const frame = eventFrame(clipped.start, clipped.end, grid.start);
                        return (
                          <div key={block.id}>
                            <div
                              className="pointer-events-none absolute inset-x-0 z-10 border-y border-warning-soft bg-warning-tint"
                              style={frame}
                            />
                            {columnIndex === 0 && (
                              <button
                                type="button"
                                className="absolute z-30 truncate px-1 text-left text-[11px] text-warning-text"
                                style={{ top: frame.top, height: Math.min(frame.height, 18), left: 2, right: 2 }}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setDialog({ mode: "existing", booking: block });
                                }}
                              >
                                {block.notes?.trim() || "Bloqueo del local"}
                              </button>
                            )}
                          </div>
                        );
                      })}
                      {placed.map((booking) => {
                        const frame = eventFrame(booking.start, booking.end, grid.start);
                        const range = bookingRange(booking, board.timeZone);
                        const roomy = frame.height >= 32;
                        const detail = booking.kind === "block" ? "Bloqueo" : statusLabel(booking.status);
                        return (
                          <button
                            key={booking.id}
                            type="button"
                            className={
                              booking.kind === "block"
                                ? "absolute z-20 overflow-hidden rounded-sm border border-dashed bg-subtle px-1.5 pt-1 text-left text-[11px] leading-tight"
                                : "absolute z-20 overflow-hidden rounded-sm border bg-card px-1.5 pt-1 text-left text-[11px] leading-tight shadow-sm"
                            }
                            style={{
                              top: frame.top,
                              height: frame.height,
                              left: `calc(${(booking.lane / booking.laneCount) * 100}% + 2px)`,
                              width: `calc(${100 / booking.laneCount}% - 4px)`,
                              borderColor: column.color ?? undefined,
                              opacity: booking.status === "cancelada" ? 0.55 : 1,
                            }}
                            onClick={(event) => {
                              event.stopPropagation();
                              setDialog({ mode: "existing", booking });
                            }}
                          >
                            <span className="block truncate">
                              <span className="font-semibold">{range}</span>
                              {roomy ? null : <span className="text-text-3"> · {detail}</span>}
                            </span>
                            {roomy ? (
                              <span className="mt-0.5 block truncate text-text-3">{detail}</span>
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {dialog && board && visibleDate && (
        <BookingDialog
          timeZone={board.timeZone}
          day={visibleDate}
          columns={hints}
          draft={dialog}
          onClose={() => setDialog(null)}
          onChanged={() => void load(true)}
        />
      )}
    </div>
  );
}

function bookingRange(
  booking: { startUtc: string; endUtc: string; kind: string },
  timeZone: string
): string {
  const start = timeInTz(booking.startUtc, timeZone);
  const end = timeInTz(booking.endUtc, timeZone);
  if (!end || end === start) return start;
  return `${start}–${end}`;
}

function hourMarks(start: number, end: number): number[] {
  const marks: number[] = [];
  const first = Math.ceil(start / 60) * 60;
  for (let minute = first; minute < end; minute += 60) marks.push(minute);
  if (marks.length === 0) marks.push(start);
  return marks;
}
