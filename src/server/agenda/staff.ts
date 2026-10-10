import { asc, count, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Actor, Role } from "@/lib/auth/actor";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { getAuth, runInternalSignup } from "@/lib/auth";
import {
  assertOwnStaff,
  listStaffServices,
  type StaffServiceDTO,
} from "@/server/agenda/catalog";
import { AgendaHttpError } from "@/server/agenda/http";
import { effectiveHours } from "@/server/agenda/hours";
import { staffPhotoUrl } from "@/server/agenda/photo";
import {
  getSettings,
  normalizeWeeklyHours,
  type WeeklyHours,
} from "@/server/agenda/settings";

/**
 * 018 — Perfiles de profesionales. Desactivar no borra; borrar exige cero
 * citas y cero cuenta. `memberId` no sale en el DTO.
 */

const jobTitleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(40)
  .nullable()
  .optional();

function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .transform((value): string | null => (value.length === 0 ? null : value))
    .nullable()
    .optional();
}

const weeklyHoursSchema = z
  .unknown()
  .optional()
  .transform((value): WeeklyHours | null | undefined => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const hours = normalizeWeeklyHours(value);
    return Object.keys(hours).length > 0 ? hours : null;
  });

const colorSchema = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/, "El color debe ser #RRGGBB");

export const staffInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    jobTitle: jobTitleSchema,
    bio: optionalText(500),
    phone: optionalText(40),
    color: colorSchema.optional(),
    position: z.number().int().optional(),
    weeklyHours: weeklyHoursSchema,
  })
  .strict();

export const staffPatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    jobTitle: jobTitleSchema,
    bio: optionalText(500),
    phone: optionalText(40),
    color: colorSchema.optional(),
    position: z.number().int().optional(),
    weeklyHours: weeklyHoursSchema,
    active: z.boolean().optional(),
  })
  .strict();

export const accountInputSchema = z
  .object({
    email: z
      .string()
      .trim()
      .email()
      .transform((value) => value.toLowerCase()),
    name: z.string().trim().min(1).max(120).optional(),
    password: z.string().min(8).max(128),
  })
  .strict();

export type StaffInput = z.infer<typeof staffInputSchema>;
export type StaffPatch = z.infer<typeof staffPatchSchema>;
export type AccountInput = z.infer<typeof accountInputSchema>;

export function parseStaffInput(
  body: unknown
): { ok: true; data: StaffInput } | { ok: false; code: "invalid_body" } {
  const parsed = staffInputSchema.safeParse(body);
  if (!parsed.success) return { ok: false, code: "invalid_body" };
  return { ok: true, data: parsed.data };
}

/** `activeCount` es el número de profesionales activos AHORA, incluido el que se apaga. */
export function canDeactivate(activeCount: number): "last_active_staff" | null {
  return activeCount <= 1 ? "last_active_staff" : null;
}

/** Inactivo y con sesiones futuras no canceladas. El booleano lo resuelve el llamador. */
export function needsReassignment(
  active: boolean,
  hasFutureBookings: boolean
): boolean {
  return !active && hasFutureBookings;
}

export type StaffProfile = {
  id: string;
  displayName: string;
  jobTitle: string | null;
  bio: string | null;
  phone: string | null;
  color: string;
  position: number;
  active: boolean;
  weeklyHours: WeeklyHours | null;
  memberId: string | null;
};

export type StaffDTO = {
  id: string;
  displayName: string;
  jobTitle: string | null;
  bio: string | null;
  phone: string | null;
  color: string;
  position: number;
  active: boolean;
  hasPhoto: boolean;
  photoUrl: string | null;
  weeklyHours: WeeklyHours | null;
  effectiveWeeklyHours: WeeklyHours | null;
  hasAccount: boolean;
  accountEmail?: string | null;
  needsReassignment?: true;
};

export function toStaffDTO(input: {
  profile: StaffProfile;
  viewer: Role;
  accountEmail?: string | null;
  hasFutureBookings?: boolean;
  /** Ausente ⇒ sin foto. La fila `staff_photo` manda, no `photo_version`. */
  hasPhoto?: boolean;
  photoUrl?: string | null;
  /**
   * Ausente ⇒ el horario de la columna, sin heredar el local. Quien arma el
   * DTO (lista, ficha, alta) pasa el recorte ya calculado.
   */
  effectiveWeeklyHours?: WeeklyHours | null;
}): StaffDTO {
  const { profile } = input;
  const dto: StaffDTO = {
    id: profile.id,
    displayName: profile.displayName,
    jobTitle: profile.jobTitle,
    bio: profile.bio,
    phone: profile.phone,
    color: profile.color,
    position: profile.position,
    active: profile.active,
    hasPhoto: input.hasPhoto ?? false,
    photoUrl: input.photoUrl ?? null,
    weeklyHours: profile.weeklyHours,
    effectiveWeeklyHours:
      input.effectiveWeeklyHours !== undefined
        ? input.effectiveWeeklyHours
        : profile.weeklyHours,
    hasAccount: profile.memberId !== null,
  };
  if (input.viewer === "owner") {
    dto.accountEmail = input.accountEmail ?? null;
  }
  if (needsReassignment(profile.active, input.hasFutureBookings === true)) {
    dto.needsReassignment = true;
  }
  return dto;
}

type StaffRow = typeof schema.staff.$inferSelect;

function storedWeeklyHours(value: unknown): WeeklyHours | null {
  if (value == null) return null;
  const hours = normalizeWeeklyHours(value);
  return Object.keys(hours).length > 0 ? hours : null;
}

function rowToProfile(row: StaffRow): StaffProfile {
  return {
    id: row.id,
    displayName: row.displayName,
    jobTitle: row.jobTitle,
    bio: row.bio,
    phone: row.phone,
    color: row.color,
    position: row.position,
    active: row.active,
    weeklyHours: storedWeeklyHours(row.weeklyHours),
    memberId: row.memberId,
  };
}

function postgresCode(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

async function loadStaff(actor: Actor, staffId: string): Promise<StaffRow> {
  assertOwnStaff(actor, staffId);
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.staff)
    .where(
      scoped(
        schema.staff.organizationId,
        actor.organizationId,
        eq(schema.staff.id, staffId)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new AgendaHttpError("not_found", "No encontrado");
  return row;
}

async function emailsByMember(
  organizationId: string,
  memberIds: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (memberIds.length === 0) return map;
  const db = getDb();
  const rows = await db
    .select({ id: schema.member.id, email: schema.user.email })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.member.userId, schema.user.id))
    .where(
      scoped(
        schema.member.organizationId,
        organizationId,
        inArray(schema.member.id, memberIds)
      )
    );
  for (const row of rows) map.set(row.id, row.email);
  return map;
}

/** Sesiones futuras no canceladas y que no son del Laboratorio. */
async function futureSessionStaffIds(
  organizationId: string,
  staffIds: string[]
): Promise<Set<string>> {
  const set = new Set<string>();
  if (staffIds.length === 0) return set;
  const db = getDb();
  const rows = await db
    .select({ staffId: schema.booking.staffId })
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        organizationId,
        eq(schema.booking.kind, "session"),
        ne(schema.booking.status, "cancelada"),
        eq(schema.booking.isTest, false),
        gt(schema.booking.scheduledAt, new Date()),
        inArray(schema.booking.staffId, staffIds)
      )
    );
  for (const row of rows) {
    if (row.staffId) set.add(row.staffId);
  }
  return set;
}

async function photoStaffIds(
  organizationId: string,
  staffIds: string[]
): Promise<Set<string>> {
  const set = new Set<string>();
  if (staffIds.length === 0) return set;
  const db = getDb();
  const rows = await db
    .select({ staffId: schema.staffPhoto.staffId })
    .from(schema.staffPhoto)
    .where(
      scoped(
        schema.staffPhoto.organizationId,
        organizationId,
        inArray(schema.staffPhoto.staffId, staffIds)
      )
    );
  for (const row of rows) set.add(row.staffId);
  return set;
}

async function presentRows(
  actor: Actor,
  rows: StaffRow[],
  emails: Map<string, string>
): Promise<StaffDTO[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [settings, future, photos] = await Promise.all([
    getSettings(actor.organizationId),
    futureSessionStaffIds(actor.organizationId, ids),
    photoStaffIds(actor.organizationId, ids),
  ]);
  return rows.map((row) => {
    const profile = rowToProfile(row);
    const hasPhoto = photos.has(row.id);
    return toStaffDTO({
      profile,
      viewer: actor.role,
      accountEmail: row.memberId ? (emails.get(row.memberId) ?? null) : null,
      hasFutureBookings: future.has(row.id),
      hasPhoto,
      photoUrl: hasPhoto ? staffPhotoUrl(row.id, row.photoVersion) : null,
      effectiveWeeklyHours: effectiveHours(
        profile.weeklyHours,
        settings.weeklyHours
      ).weeklyHours,
    });
  });
}

export async function listStaff(
  actor: Actor,
  options: { includeInactive: boolean }
): Promise<StaffDTO[]> {
  const db = getDb();
  const where =
    actor.role === "staff"
      ? actor.staffId
        ? scoped(
            schema.staff.organizationId,
            actor.organizationId,
            eq(schema.staff.id, actor.staffId)
          )
        : null
      : scoped(
          schema.staff.organizationId,
          actor.organizationId,
          options.includeInactive ? undefined : eq(schema.staff.active, true)
        );
  if (!where) return [];

  const rows = await db
    .select()
    .from(schema.staff)
    .where(where)
    .orderBy(asc(schema.staff.position), asc(schema.staff.displayName));
  const emails =
    actor.role === "owner"
      ? await emailsByMember(
          actor.organizationId,
          rows.flatMap((row) => (row.memberId ? [row.memberId] : []))
        )
      : new Map<string, string>();
  return presentRows(actor, rows, emails);
}

export async function getStaff(
  actor: Actor,
  staffId: string
): Promise<{ staff: StaffDTO; services: StaffServiceDTO[] }> {
  const row = await loadStaff(actor, staffId);
  const emails =
    actor.role === "owner" && row.memberId
      ? await emailsByMember(actor.organizationId, [row.memberId])
      : new Map<string, string>();
  const services = await listStaffServices(actor, staffId);
  const presented = await presentRows(actor, [row], emails);
  const staff = presented[0];
  if (!staff) throw new AgendaHttpError("not_found", "No encontrado");
  return { staff, services };
}

export async function createStaff(
  actor: Actor,
  input: StaffInput
): Promise<StaffDTO> {
  const db = getDb();
  const inserted = await db
    .insert(schema.staff)
    .values({
      id: newId("staff"),
      organizationId: actor.organizationId,
      displayName: input.displayName,
      jobTitle: input.jobTitle ?? null,
      bio: input.bio ?? null,
      phone: input.phone ?? null,
      color: input.color ?? "#0d5bff",
      position: input.position ?? 0,
      active: true,
      weeklyHours: input.weeklyHours ?? null,
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new AgendaHttpError("invalid_body", "No se pudo crear el profesional");
  const settings = await getSettings(actor.organizationId);
  const profile = rowToProfile(row);
  return toStaffDTO({
    profile,
    viewer: "owner",
    accountEmail: null,
    hasFutureBookings: false,
    hasPhoto: false,
    photoUrl: null,
    effectiveWeeklyHours: effectiveHours(profile.weeklyHours, settings.weeklyHours)
      .weeklyHours,
  });
}

async function activeCount(organizationId: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({ n: count() })
    .from(schema.staff)
    .where(
      scoped(
        schema.staff.organizationId,
        organizationId,
        eq(schema.staff.active, true)
      )
    );
  return Number(rows[0]?.n ?? 0);
}

export async function updateStaff(
  actor: Actor,
  staffId: string,
  patch: StaffPatch
): Promise<StaffDTO> {
  const row = await loadStaff(actor, staffId);
  if (patch.active === false && row.active) {
    const code = canDeactivate(await activeCount(actor.organizationId));
    if (code) {
      throw new AgendaHttpError(
        code,
        "No se puede desactivar al último profesional activo"
      );
    }
  }

  const set: Partial<typeof schema.staff.$inferInsert> = {};
  if (patch.displayName !== undefined) set.displayName = patch.displayName;
  if (patch.jobTitle !== undefined) set.jobTitle = patch.jobTitle;
  if (patch.bio !== undefined) set.bio = patch.bio;
  if (patch.phone !== undefined) set.phone = patch.phone;
  if (patch.color !== undefined) set.color = patch.color;
  if (patch.position !== undefined) set.position = patch.position;
  if (patch.weeklyHours !== undefined) set.weeklyHours = patch.weeklyHours;
  if (patch.active !== undefined) set.active = patch.active;

  if (Object.keys(set).length > 0) {
    const db = getDb();
    await db
      .update(schema.staff)
      .set({ ...set, updatedAt: new Date() })
      .where(
        scoped(
          schema.staff.organizationId,
          actor.organizationId,
          eq(schema.staff.id, staffId)
        )
      );
  }
  return (await getStaff(actor, staffId)).staff;
}

const HAS_BOOKINGS = "Tiene citas: desactívalo en vez de borrarlo";

export async function deleteStaff(actor: Actor, staffId: string): Promise<void> {
  const row = await loadStaff(actor, staffId);
  const db = getDb();
  const bookings = await db
    .select({ id: schema.booking.id })
    .from(schema.booking)
    .where(
      scoped(
        schema.booking.organizationId,
        actor.organizationId,
        eq(schema.booking.staffId, staffId)
      )
    )
    .limit(1);
  if (bookings[0]) throw new AgendaHttpError("has_bookings", HAS_BOOKINGS);
  if (row.memberId) {
    throw new AgendaHttpError("has_account", "Tiene una cuenta vinculada");
  }

  try {
    await db
      .delete(schema.staff)
      .where(
        scoped(
          schema.staff.organizationId,
          actor.organizationId,
          eq(schema.staff.id, staffId)
        )
      );
  } catch (err) {
    if (postgresCode(err) === "23503") {
      throw new AgendaHttpError("has_bookings", HAS_BOOKINGS);
    }
    throw err;
  }
}

export async function linkAccount(
  actor: Actor,
  staffId: string,
  input: AccountInput
): Promise<void> {
  const row = await loadStaff(actor, staffId);
  if (row.memberId) {
    throw new AgendaHttpError("duplicate", "Este perfil ya tiene una cuenta");
  }

  const db = getDb();
  const existing = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(sql`lower(${schema.user.email}) = ${input.email}`)
    .limit(1);
  if (existing[0]) {
    throw new AgendaHttpError("duplicate", "Ya existe una cuenta con ese correo");
  }

  const auth = getAuth();
  let userId: string;
  try {
    const result = await runInternalSignup(() =>
      auth.api.signUpEmail({
        body: {
          name: input.name ?? row.displayName,
          email: input.email,
          password: input.password,
        },
      })
    );
    userId = result.user.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : "No se pudo crear la cuenta";
    if (/exist/i.test(message)) {
      throw new AgendaHttpError("duplicate", "Ya existe una cuenta con ese correo");
    }
    throw new AgendaHttpError("invalid_body", message);
  }

  const memberId = newId("member");
  try {
    await db.transaction(async (tx) => {
      await tx.insert(schema.member).values({
        id: memberId,
        organizationId: actor.organizationId,
        userId,
        role: "staff",
      });
      const linked = await tx
        .update(schema.staff)
        .set({ memberId, updatedAt: new Date() })
        .where(
          scoped(
            schema.staff.organizationId,
            actor.organizationId,
            eq(schema.staff.id, staffId),
            sql`${schema.staff.memberId} is null`
          )
        )
        .returning({ id: schema.staff.id });
      if (!linked[0]) {
        throw new AgendaHttpError("duplicate", "Este perfil ya tiene una cuenta");
      }
    });
  } catch (err) {
    if (err instanceof AgendaHttpError) throw err;
    if (postgresCode(err) === "23505") {
      throw new AgendaHttpError("duplicate", "Ya existe una cuenta con ese correo");
    }
    throw err;
  }
}

export async function unlinkAccount(actor: Actor, staffId: string): Promise<void> {
  const row = await loadStaff(actor, staffId);
  if (!row.memberId) return;
  const memberId = row.memberId;
  const db = getDb();
  await db.transaction(async (tx) => {
    await tx
      .update(schema.staff)
      .set({ memberId: null, updatedAt: new Date() })
      .where(
        scoped(
          schema.staff.organizationId,
          actor.organizationId,
          eq(schema.staff.id, staffId)
        )
      );
    await tx
      .delete(schema.member)
      .where(
        scoped(
          schema.member.organizationId,
          actor.organizationId,
          eq(schema.member.id, memberId),
          ne(schema.member.role, "owner")
        )
      );
  });
}
