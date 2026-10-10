import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";

type LockTx = {
  execute: (query: SQL) => Promise<unknown>;
};

/**
 * Two stable int4 keys from the organization id.
 * `pg_advisory_xact_lock` is transaction-scoped and releases on commit/rollback.
 */
function advisoryKeys(organizationId: string): [number, number] {
  const digest = createHash("sha256").update(`vocero-agenda:${organizationId}`).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

/**
 * Shared lock taken by a session insert.
 *
 * `booking_staff_no_overlap` ignores rows whose `staff_id` is NULL, so it
 * cannot keep a session out of a shop-wide block. Sessions take this shared
 * lock; creating a shop block takes the exclusive twin and therefore waits
 * for in-flight sessions (and they wait for it).
 */
export async function withSessionLock(tx: LockTx, organizationId: string): Promise<void> {
  const [classId, objectId] = advisoryKeys(organizationId);
  await tx.execute(sql`select pg_advisory_xact_lock_shared(${classId}::int, ${objectId}::int)`);
}

/** Exclusive lock for a shop-wide block. See `withSessionLock`. */
export async function withBlockLock(tx: LockTx, organizationId: string): Promise<void> {
  const [classId, objectId] = advisoryKeys(organizationId);
  await tx.execute(sql`select pg_advisory_xact_lock(${classId}::int, ${objectId}::int)`);
}
