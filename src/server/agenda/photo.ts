import { eq, sql } from "drizzle-orm";
import type { Actor } from "@/lib/auth/actor";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import {
  MAX_STAFF_PHOTO_BYTES,
  sniffImage,
  type StaffPhotoMime,
} from "@/lib/image-sniff";
import { assertOwnStaff } from "@/server/agenda/catalog";
import { AgendaHttpError } from "@/server/agenda/http";

/**
 * Foto del profesional, en `staff_photo` (bytea). Sin S3: Constitución II.
 * `photo_version` solo sube. Borrar la fila no la baja: si volviera a 0, la
 * URL `?v=` repetiría la de una foto anterior y el navegador la conservaría.
 */

export function staffPhotoUrl(staffId: string, version: number): string {
  return `/api/staff/${staffId}/photo?v=${version}`;
}

function assertPhotoWriter(actor: Actor, staffId: string): void {
  if (actor.role === "reception") {
    throw new AgendaHttpError("forbidden", "Sin acceso");
  }
  assertOwnStaff(actor, staffId);
}

async function requireStaff(actor: Actor, staffId: string): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ id: schema.staff.id })
    .from(schema.staff)
    .where(
      scoped(
        schema.staff.organizationId,
        actor.organizationId,
        eq(schema.staff.id, staffId)
      )
    )
    .limit(1);
  if (!rows[0]) throw new AgendaHttpError("not_found", "No encontrado");
}

export async function saveStaffPhoto(
  actor: Actor,
  staffId: string,
  bytes: Uint8Array
): Promise<{ photoUrl: string; version: number }> {
  assertPhotoWriter(actor, staffId);
  if (bytes.byteLength === 0) {
    throw new AgendaHttpError("empty", "No llegó ningún archivo");
  }
  if (bytes.byteLength > MAX_STAFF_PHOTO_BYTES) {
    throw new AgendaHttpError("too_large", "La foto no puede pasar de 512 KB");
  }
  const mime = sniffImage(bytes);
  if (!mime) {
    throw new AgendaHttpError(
      "unsupported",
      "Formato no reconocido. Usa JPEG, PNG o WebP."
    );
  }

  const db = getDb();
  const version = await db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.staff)
      .set({
        photoVersion: sql`${schema.staff.photoVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(
        scoped(
          schema.staff.organizationId,
          actor.organizationId,
          eq(schema.staff.id, staffId)
        )
      )
      .returning({ version: schema.staff.photoVersion });
    const next = updated[0];
    if (!next) throw new AgendaHttpError("not_found", "No encontrado");

    await tx
      .insert(schema.staffPhoto)
      .values({
        staffId,
        organizationId: actor.organizationId,
        mime,
        sizeBytes: bytes.byteLength,
        data: Buffer.from(bytes),
      })
      .onConflictDoUpdate({
        target: schema.staffPhoto.staffId,
        set: {
          mime,
          sizeBytes: bytes.byteLength,
          data: Buffer.from(bytes),
          updatedAt: new Date(),
        },
      });
    return next.version;
  });

  return { photoUrl: staffPhotoUrl(staffId, version), version };
}

export async function readStaffPhoto(
  actor: Actor,
  staffId: string
): Promise<{ mime: StaffPhotoMime; bytes: Uint8Array }> {
  assertOwnStaff(actor, staffId);
  const db = getDb();
  const rows = await db
    .select({
      mime: schema.staffPhoto.mime,
      data: schema.staffPhoto.data,
    })
    .from(schema.staffPhoto)
    .where(
      scoped(
        schema.staffPhoto.organizationId,
        actor.organizationId,
        eq(schema.staffPhoto.staffId, staffId)
      )
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new AgendaHttpError("not_found", "No encontrado");
  return { mime: row.mime, bytes: Uint8Array.from(row.data) };
}

export async function deleteStaffPhoto(actor: Actor, staffId: string): Promise<void> {
  assertPhotoWriter(actor, staffId);
  await requireStaff(actor, staffId);
  const db = getDb();
  await db
    .delete(schema.staffPhoto)
    .where(
      scoped(
        schema.staffPhoto.organizationId,
        actor.organizationId,
        eq(schema.staffPhoto.staffId, staffId)
      )
    );
}
