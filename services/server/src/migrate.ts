import { fileURLToPath } from "node:url";
import { openPgDb } from "./db";
import { migrate } from "drizzle-orm/node-postgres/migrator";

/**
 * Apply Drizzle migrations to the configured Postgres database (DATABASE_URL
 * required). Used by `pnpm db:migrate` for the production path. Dev/tests boot
 * PGlite and apply the same migrations in-process (see index.ts / tests).
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../drizzle", import.meta.url));

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // eslint-disable-next-line no-console
    console.error("DATABASE_URL is required for migrate");
    process.exit(1);
  }
  const { db, pool } = openPgDb(databaseUrl);
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  // eslint-disable-next-line no-console
  console.log("migrations applied");
  await pool.end();
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
