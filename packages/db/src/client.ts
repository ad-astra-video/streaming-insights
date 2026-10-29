import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export * from "./schema.js";

/**
 * Create a Postgres client backed by `DATABASE_URL`. In dev, leave
 * `DATABASE_URL` unset to use the embedded PGlite path (see server bootstrap).
 */
export function createDb(connectionString: string) {
  const client = postgres(connectionString, { max: 10 });
  return { db: drizzle(client, { schema }), client };
}

export type Db = ReturnType<typeof createDb>["db"];
