import { describe, expect, it } from "vitest";
import { bookingErrorStatus, agendaErrorStatus } from "@/server/agenda/http";
import {
  canDeactivate,
  needsReassignment,
  parseStaffInput,
  staffInputSchema,
  toStaffDTO,
} from "@/server/agenda/staff";

const profile = {
  id: "st_ana",
  displayName: "Ana",
  jobTitle: "barbero",
  bio: null,
  phone: "555",
  color: "#112233",
  position: 0,
  active: true,
  weeklyHours: { mon: [{ start: "09:00", end: "18:00" }] },
  memberId: "mem_secret",
};

describe("staffInputSchema", () => {
  it("recorta el nombre, baja el oficio y normaliza el horario como upsertSettings", () => {
    const parsed = staffInputSchema.parse({
      displayName: "  Ana  ",
      jobTitle: "Barbero",
      color: "#112233",
      weeklyHours: {
        mon: [
          { start: "14:00", end: "18:00" },
          { start: "09:00", end: "13:00" },
          { start: "no", end: "pe" },
        ],
        sun: [{ start: "18:00", end: "09:00" }],
      },
    });
    expect(parsed.displayName).toBe("Ana");
    expect(parsed.jobTitle).toBe("barbero");
    expect(parsed.color).toBe("#112233");
    expect(parsed.weeklyHours).toEqual({
      mon: [
        { start: "09:00", end: "13:00" },
        { start: "14:00", end: "18:00" },
      ],
    });
  });

  it("rechaza nombre vacío, nombre de 81 y un color que no es #RRGGBB", () => {
    expect(staffInputSchema.safeParse({ displayName: "   " }).success).toBe(
      false
    );
    expect(
      staffInputSchema.safeParse({ displayName: "a".repeat(81) }).success
    ).toBe(false);
    expect(
      staffInputSchema.safeParse({ displayName: "Ana", color: "red" }).success
    ).toBe(false);
    expect(
      staffInputSchema.safeParse({ displayName: "Ana", color: "#fff" }).success
    ).toBe(false);
  });

  it("acepta el nombre de 1 y de 80 caracteres", () => {
    expect(staffInputSchema.parse({ displayName: "A" }).displayName).toBe("A");
    expect(
      staffInputSchema.parse({ displayName: "b".repeat(80) }).displayName
    ).toHaveLength(80);
  });

  it("un campo desconocido (memberId) es invalid_body", () => {
    expect(
      parseStaffInput({ displayName: "Ana", memberId: "mem_x" })
    ).toEqual({ ok: false, code: "invalid_body" });
  });
});

describe("canDeactivate", () => {
  it("deja desactivar cuando quedarían activos", () => {
    expect(canDeactivate(2)).toBeNull();
    expect(canDeactivate(3)).toBeNull();
  });

  it("responde last_active_staff si dejaría cero activos", () => {
    expect(canDeactivate(1)).toBe("last_active_staff");
    expect(canDeactivate(0)).toBe("last_active_staff");
  });
});

describe("needsReassignment", () => {
  it("es verdadero solo si está inactivo y tiene citas futuras", () => {
    expect(needsReassignment(false, true)).toBe(true);
  });

  it("es falso si sigue activo o si no hay citas futuras", () => {
    expect(needsReassignment(true, true)).toBe(false);
    expect(needsReassignment(false, false)).toBe(false);
  });
});

describe("toStaffDTO", () => {
  it("nunca expone memberId", () => {
    const dto = toStaffDTO({
      profile,
      viewer: "owner",
      accountEmail: "ana@vocero.test",
      hasFutureBookings: false,
    });
    expect(dto).not.toHaveProperty("memberId");
    expect(dto.id).toBe("st_ana");
    expect(dto.hasAccount).toBe(true);
    expect(dto.hasPhoto).toBe(false);
    expect(dto.photoUrl).toBeNull();
    expect(dto.weeklyHours).toEqual(profile.weeklyHours);
    expect(dto.effectiveWeeklyHours).toEqual(profile.weeklyHours);
  });

  it("el dueño ve accountEmail; recepción y staff no", () => {
    const owner = toStaffDTO({
      profile,
      viewer: "owner",
      accountEmail: "ana@vocero.test",
      hasFutureBookings: false,
    });
    expect(owner.accountEmail).toBe("ana@vocero.test");

    const ownerSinCuenta = toStaffDTO({
      profile: { ...profile, memberId: null },
      viewer: "owner",
      accountEmail: null,
      hasFutureBookings: false,
    });
    expect(ownerSinCuenta.accountEmail).toBeNull();
    expect(ownerSinCuenta.hasAccount).toBe(false);

    const reception = toStaffDTO({
      profile,
      viewer: "reception",
      accountEmail: "ana@vocero.test",
      hasFutureBookings: false,
    });
    expect(reception).not.toHaveProperty("accountEmail");
    expect(reception.phone).toBe("555");

    const staff = toStaffDTO({
      profile,
      viewer: "staff",
      accountEmail: "ana@vocero.test",
      hasFutureBookings: false,
    });
    expect(staff).not.toHaveProperty("accountEmail");
  });

  it("needsReassignment solo aparece si está inactivo con citas futuras", () => {
    const flagged = toStaffDTO({
      profile: { ...profile, active: false },
      viewer: "reception",
      hasFutureBookings: true,
    });
    expect(flagged.needsReassignment).toBe(true);

    const quiet = toStaffDTO({
      profile,
      viewer: "reception",
      hasFutureBookings: true,
    });
    expect(quiet).not.toHaveProperty("needsReassignment");
  });

  it("sin horario propio, effectiveWeeklyHours es null (aún no se hereda el local)", () => {
    const dto = toStaffDTO({
      profile: { ...profile, weeklyHours: null, memberId: null },
      viewer: "owner",
      accountEmail: null,
      hasFutureBookings: false,
    });
    expect(dto.weeklyHours).toBeNull();
    expect(dto.effectiveWeeklyHours).toBeNull();
  });
});

describe("agendaErrorStatus", () => {
  it("mapea los códigos nuevos sin mover el 409 de slot_taken", () => {
    expect(agendaErrorStatus("forbidden")).toBe(403);
    expect(agendaErrorStatus("account_disabled")).toBe(403);
    expect(agendaErrorStatus("last_active_staff")).toBe(409);
    expect(agendaErrorStatus("has_bookings")).toBe(409);
    expect(agendaErrorStatus("has_account")).toBe(409);
    expect(agendaErrorStatus("duplicate")).toBe(409);
    expect(agendaErrorStatus("service_required")).toBe(422);
    expect(agendaErrorStatus("service_not_offered")).toBe(422);
    expect(bookingErrorStatus("slot_taken")).toBe(409);
    expect(bookingErrorStatus("slot_not_offered")).toBe(409);
    expect(bookingErrorStatus("service_required")).toBe(422);
  });
});
