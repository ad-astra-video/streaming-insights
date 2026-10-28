import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { Pool } from "pg";
import { schema } from "./schema";

/** Union of the Postgres-backed and in-process (PGlite) drizzle clients. Both
 * expose the same query-builder surface for the schema-typed operations the
 * control-plane services use. */
export type Db = NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>;

export interface OpenedPgDb {
  db: NodePgDatabase<typeof schema>;
  pool: Pool;
}

/** Open the production Postgres connection (DATABASE_URL required). */
export function openPgDb(databaseUrl: string): OpenedPgDb {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzlePg(pool, { schema });
  return { db, pool };
}

/** Open an in-process PGlite database. Used for dev (DATABASE_URL unset) and
 * integration tests; no external Postgres server required. */
export async function openPgliteDb(dataDir?: string): Promise<{
  db: PgliteDatabase<typeof schema>;
  pglite: PGlite;
}> {
  const pglite = new PGlite(dataDir ? `file:${dataDir}` : undefined);
  const db = drizzlePglite(pglite, { schema });
  return { db, pglite };
}
