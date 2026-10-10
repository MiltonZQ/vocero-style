import type { SseEvent } from "@/server/events/bus";

/** Payload de `booking.updated` a partir de la fila (sin datos del cliente). */
export function bookingUpdatedData(row: {
  id: string;
  staffId: string | null;
}): Extract<SseEvent, { type: "booking.updated" }>["data"] {
  return {
    bookingId: row.id,
    staffId: row.staffId,
    scope: row.staffId === null ? "shop" : "staff",
  };
}
