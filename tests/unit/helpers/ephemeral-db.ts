import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { describe } from "vitest";

/**
 * 018 — BD efímera para los tests que de verdad necesitan Postgres (el
 * `EXCLUDE` y el backfill no se pueden probar con mocks).
 *
 * La URL sale SOLO de `TEST_DATABASE_URL`: jamás de `DATABASE_URL`, para que un
 * `.env` apuntando a una BD real no pueda ser tocado por un test. Sin la
 * variable los tests de BD se omiten (el resto del repo no usa BD en unit).
 *
 * Cada corrida vive en su propio esquema (`t_<rand>`) y `dropAll()` lo borra.
 */

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

/** `describe` que se omite sin `TEST_DATABASE_URL`. */
export const describeDb = describe.skipIf(!TEST_DATABASE_URL);

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../../drizzle");

/** Nombres de migración (sin `.sql`) en orden de aplicación. */
export function migrationTags(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .map((f) => f.replace(/\.sql$/, ""))
    .sort();
}

export type EphemeralDb = {
  sql: postgres.Sql;
  schema: string;
  /** Ejecuta SQL libre (un solo statement o varios sin parámetros). */
  run: (statement: string) => Promise<postgres.RowList<postgres.Row[]>>;
  /** Aplica migraciones en orden: las que están en `[from, until)` por tag. */
  applyMigrations: (opts?: { from?: string; until?: string }) => Promise<void>;
  /** Aplica una sola migración por tag. */
  applyOne: (tag: string) => Promise<void>;
  dropAll: () => Promise<void>;
};

export async function openEphemeralDb(): Promise<EphemeralDb> {
  if (!TEST_DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL no está definida");
  }
  const schema = `t_${Math.random().toString(36).slice(2, 10)}`;
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  // btree_gist (0014) se instala UNA vez en `public`. Si la creara la migración,
  // caería en el primer esquema del search_path —el de esta corrida— y el
  // `DROP SCHEMA ... CASCADE` de un archivo se la quitaría a los demás (y dos
  // creaciones simultáneas chocaban con `pg_extension_name_index`).
  await admin.begin(async (tx) => {
    await tx.unsafe("SELECT pg_advisory_xact_lock(190001)");
    await tx.unsafe("CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public");
  });
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  await admin.end();

  // `public` detrás: si btree_gist ya está instalada allí, sus operadores
  // resuelven; si no, la migración la crea (y cae con el esquema).
  const sql = postgres(TEST_DATABASE_URL, {
    max: 1,
    onnotice: () => {},
    connection: { search_path: `${schema},public` },
  });

  async function applyOne(tag: string) {
    // drizzle-kit califica las FKs con "public": se redirigen al esquema de la corrida.
    const body = readFileSync(
      path.join(MIGRATIONS_DIR, `${tag}.sql`),
      "utf8"
    ).replaceAll('"public".', `"${schema}".`);
    // Una transacción por archivo, como el migrador de drizzle (0001 usa una
    // tabla temporal ON COMMIT DROP).
    await sql.begin(async (tx) => {
      for (const stmt of body.split("--> statement-breakpoint")) {
        if (stmt.trim()) await tx.unsafe(stmt);
      }
    });
  }

  return {
    sql,
    schema,
    run: (statement) => sql.unsafe(statement),
    applyOne,
    async applyMigrations(opts) {
      for (const tag of migrationTags()) {
        if (opts?.from && tag < opts.from) continue;
        if (opts?.until && tag >= opts.until) continue;
        await applyOne(tag);
      }
    },
    async dropAll() {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    },
  };
}
