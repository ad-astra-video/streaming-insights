import { fileURLToPath } from "node:url";
import { loadConfig } from "./config";
import { openPgDb, openPgliteDb, type Db } from "./db";
import { buildApp } from "./app";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";

/** Absolute path to the generated Drizzle migrations folder (`services/server/drizzle`). */
const MIGRATIONS_DIR = fileURLToPath(new URL("../drizzle", import.meta.url));

async function main() {
  const cfg = loadConfig();
  let db: Db;

  if (cfg.databaseUrl) {
    // Production Postgres.
    const { db: pgDb, pool } = openPgDb(cfg.databaseUrl);
    await migratePg(pgDb, { migrationsFolder: MIGRATIONS_DIR });
    db = pgDb;
    const close = () => void pool.end();
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
    `streaming-insights control server on :${cfg.port} (db=${cfg.databaseUrl ? "postgres" : "pglite"}, ` +
      `runners=${cfg.runners}, streamsPerRunner=${cfg.streamsPerRunner}, maxStreams=${cfg.maxStreams})`
  );
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
