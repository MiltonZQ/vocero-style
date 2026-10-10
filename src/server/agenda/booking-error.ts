import type { OfferedSlot } from "@/server/agenda/offers";

export type BookingErrorCode =
  | "slot_taken"
  | "slot_not_offered"
  | "not_found"
  | "invalid"
  | "service_required";

export class BookingError extends Error {
  code: BookingErrorCode;
  /**
   * Horarios para re-ofrecer. En `slot_taken` son alternativas frescas YA
   * registradas como la nueva oferta de la conversación; en `slot_not_offered`
   * es lo que sí se había ofrecido.
   */
  slots: OfferedSlot[];

  constructor(code: BookingErrorCode, message: string, slots: OfferedSlot[] = []) {
    super(message);
    this.name = "BookingError";
    this.code = code;
    this.slots = slots;
  }
}
