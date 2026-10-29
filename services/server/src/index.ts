import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { openPgDb, openPgliteDb, type Db } from "./db.js";
import { buildApp } from "./app.js";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { migrate as migratePg } from "drizzle-orm/postgres-js/migrator";

/** Absolute path to the generated Drizzle migrations folder (`packages/db/drizzle`). */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../packages/db/drizzle", import.meta.url));

async function main() {
  const cfg = loadConfig();
  let db: Db;

  if (cfg.databaseUrl) {
    // Production Postgres.
    const { db: pgDb, client } = openPgDb(cfg.databaseUrl);
    await migratePg(pgDb, { migrationsFolder: MIGRATIONS_DIR });
    db = pgDb;
    const close = () => void client.end();
    process.on("SIGINT", close);
    process.on("SIGTERM", close);
  } else {
    // Dev / test: in-process PGlite, migrations applied on boot.
    const { db: pgDb, pglite } = await openPgliteDb();
    await migratePglite(pgDb, { migrationsFolder: MIGRATIONS_DIR });
    db = pgDb;
    void pglite;
  }

  const app = buildApp({ db, cfg });
  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  // eslint-disable-next-line no-console
  console.log(
    `streaming-insights springboard on :${cfg.port} (db=${cfg.databaseUrl ? "postgres" : "pglite"})`
  );
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
