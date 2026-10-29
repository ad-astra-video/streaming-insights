import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { openPgDb, openPgliteDb, type Db } from "./db.js";
import { buildApp } from "./app.js";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { migrate as migratePg } from "drizzle-orm/postgres-js/migrator";

/** Absolute path to the generated Drizzle migrations folder (`packages/db/drizzle`). */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/drizzle", import.meta.url));

/** Absolute path to the built webapp bundle (`webapp/dist`) served as the dashboard at `/`. */
const WEBAPP_DIST = resolve(fileURLToPath(new URL("../../../webapp/dist", import.meta.url)));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

/**
 * Serve the built webapp bundle (dashboard) at `/` on the control server. The
 * webapp is a Vite SPA built into the server image (`webapp/dist`), so unknown
 * non-API GET paths fall back to `index.html` (client-side routing). All
 * `/api/*` request are left to the springboard routes; this is the not-found
 * handler, so it only sees GETs no registered route claimed.
 */
function registerWebapp(app: Awaited<ReturnType<typeof buildApp>>) {
  app.setNotFoundHandler(async (req, reply) => {
    if (req.method !== "GET") {
      return reply.code(404).send({ error: "not found" });
    }
    const pathname = new URL(req.url, "http://x").pathname;
    if (pathname.startsWith("/api/")) {
      return reply.code(404).send({ error: "not found" });
    }
    const rel = pathname.replace(/^\/+/, "") || "index.html";
    const file = join(WEBAPP_DIST, rel);
    // Guard against path traversal.
    if (!file.startsWith(WEBAPP_DIST)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    try {
      const data = await readFile(file);
      return reply.type(MIME[extname(file)] ?? "application/octet-stream").send(data);
    } catch {
      // SPA fallback: unknown client-side route -> serve the app shell.
      try {
        const indexHtml = await readFile(join(WEBAPP_DIST, "index.html"));
        return reply.type("text/html; charset=utf-8").send(indexHtml);
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
    }
  });
}

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
  registerWebapp(app);
  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  // eslint-disable-next-line no-console
  console.log(
    `streaming-insights springboard on :${cfg.port} (db=${cfg.databaseUrl ? "postgres" : "pglite"})` +
      ` (webapp dist=${WEBAPP_DIST})`
  );
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
