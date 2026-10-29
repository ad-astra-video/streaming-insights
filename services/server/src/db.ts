import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { drizzle as drizzlePg, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  createDb,
  sessions,
  prompts,
  tokenLedger,
  events,
  streamSessions,
  runners,
} from "@streaming-insights/db";

const schema = { sessions, prompts, tokenLedger, events, streamSessions, runners };

/** Union of the Postgres-backed and in-process (PGlite) drizzle clients. Both
 * expose the same query-builder surface for the schema-typed operations the
 * springboard services use. */
export type Db = PostgresJsDatabase<typeof schema> | PgliteDatabase<typeof schema>;

export interface OpenedPgDb {
  db: PostgresJsDatabase<typeof schema>;
  client: ReturnType<typeof createDb>["client"];
}

/** Open the production Postgres connection (DATABASE_URL required). */
export function openPgDb(databaseUrl: string): OpenedPgDb {
  const { db, client } = createDb(databaseUrl);
  return { db, client };
}

/** Open an in-process PGlite database (dev/test; no external Postgres needed). */
export async function openPgliteDb(dataDir?: string): Promise<{
  db: PgliteDatabase<typeof schema>;
  pglite: PGlite;
}> {
  const pglite = new PGlite(dataDir ? `file:${dataDir}` : undefined);
  const db = drizzlePglite(pglite, { schema });
  return { db, pglite };
}
