export type BookingContactInput = {
  id?: string;
  name: string;
  phone: string | null;
  conversationId?: string | null;
};

export type BookingDtoInput = {
  id: string;
  kind: "session" | "block";
  status: string;
  startUtc: Date | string;
  endUtc: Date | string;
  durationMinutes: number;
  priceCents: number | null;
  currency: string | null;
  notes: string | null;
  contact: BookingContactInput | null;
  staff: { id: string; name: string } | null;
  service: { id: string; name: string } | null;
};

export type BookingDTO = {
  id: string;
  kind: "session" | "block";
  status: string;
  startUtc: string;
  endUtc: string;
  durationMinutes: number;
  priceCents: number | null;
  currency: string | null;
  notes: string | null;
  contact: { name: string; phone: string | null } | null;
  staff: { id: string; name: string } | null;
  service: { id: string; name: string } | null;
};

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

/** Contact is only name and phone — never an id or a conversation. */
export function toBookingDTO(row: BookingDtoInput): BookingDTO {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    startUtc: iso(row.startUtc),
    endUtc: iso(row.endUtc),
    durationMinutes: row.durationMinutes,
    priceCents: row.priceCents,
    currency: row.currency,
    notes: row.notes,
    contact: row.contact ? { name: row.contact.name, phone: row.contact.phone } : null,
    staff: row.staff ? { id: row.staff.id, name: row.staff.name } : null,
    service: row.service ? { id: row.service.id, name: row.service.name } : null,
  };
}
