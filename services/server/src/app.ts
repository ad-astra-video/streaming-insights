import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { and, asc, eq, gt } from "drizzle-orm";
import { events, sessions, tokenLedger } from "@streaming-insights/db";
import { ROUTES, streamWindowEventJsonSchema, CONTRACT_VERSION } from "@streaming-insights/shared";
import type { Db } from "./db.js";
import type { ServerConfig } from "./config.js";
import { reclaimRunnerSlots, registerWriteRoutes, seedRunners } from "./write.js";

export interface AppDeps {
  db: Db;
  cfg: ServerConfig;
}

/** Normalized per-window event read from the event store. */
interface EventRow {
  seq: number;
  payload: Record<string, unknown>;
}

async function sessionExists(db: Db, sessionId: string): Promise<boolean> {
  const rows = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  return rows.length > 0;
}

async function listEvents(db: Db, sessionId: string): Promise<EventRow[]> {
  const rows = await db
    .select({ seq: events.seq, payload: events.payload })
    .from(events)
    .where(eq(events.sessionId, sessionId))
    .orderBy(asc(events.seq));
  return rows as EventRow[];
}

async function listEventsAfter(db: Db, sessionId: string, afterSeq: number): Promise<EventRow[]> {
  const rows = await db
    .select({ seq: events.seq, payload: events.payload })
    .from(events)
    .where(and(eq(events.sessionId, sessionId), gt(events.seq, afterSeq)))
    .orderBy(asc(events.seq));
  return rows as EventRow[];
}

/**
 * Build the control-plane Fastify app exposing the structured live data-out
 * ("springboard") API. Reads per-window events and the token ledger from the
 * Drizzle `Db` and serves them over SSE (live), NDJSON (batch), an aggregated
 * token summary, and the versioned JSON Schema contract.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const { db, cfg } = deps;
  const app = Fastify({ logger: false });
  app.register(cors, { origin: true });

  // Health — used by runners/ingress and on the deploy health probe.
  app.get(ROUTES.health, async () => ({ status: "ok" }));

  // JSON Schema for the versioned v1 event contract.
  app.get(ROUTES.schema, async () => ({
    version: CONTRACT_VERSION,
    schema: streamWindowEventJsonSchema,
  }));

  // Runtime wiring for the browser: the public media origin to ingest against.
  // Served from the COMMITTED compose env so the webapp never has to guess the
  // docker-internal media hostname (or a build-time constant baked per box).
  app.get(ROUTES.config, async () => ({
    version: CONTRACT_VERSION,
    mediaBaseUrl: cfg.mediaPublicBaseUrl ?? null,
    controlBaseUrl: cfg.publicBaseUrl ?? null,
  }));

  // Live SSE feed: catch up on persisted events, then stream new ones as they
  // are written to the event store.
  app.get(ROUTES.sessionEvents(":sessionId"), async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    if (!(await sessionExists(db, sessionId))) {
      return reply.code(404).send({ error: `Session not found: ${sessionId}` });
    }

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const writeFrame = (seq: number, payload: unknown) => {
      res.write(`id: ${seq}\n`);
      res.write(`event: window\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // Catch-up on already-persisted events.
    let lastSeq = -1;
    try {
      for (const e of await listEvents(db, sessionId)) {
        writeFrame(e.seq, e.payload);
        lastSeq = e.seq;
      }
    } catch (err) {
      // Log and continue polling; the SSE stream is best-effort.
      req.log.error(err, "springboard SSE catch-up failed");
    }

    // Poll for newly-inserted events so the feed is live even though the
    // runner/ingress process writes to the same DB.
    const timer = setInterval(async () => {
      try {
        for (const e of await listEventsAfter(db, sessionId, lastSeq)) {
          writeFrame(e.seq, e.payload);
          lastSeq = e.seq;
        }
      } catch (err) {
        req.log.error(err, "springboard SSE poll failed");
      }
    }, cfg.ssePollMs);

    req.raw.on("close", () => clearInterval(timer));
  });

  // NDJSON batch/offline feed: one event per line.
  app.get(ROUTES.sessionEventsNdjson(":sessionId"), async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    if (!(await sessionExists(db, sessionId))) {
      return reply.code(404).send({ error: `Session not found: ${sessionId}` });
    }
    const rows = await listEvents(db, sessionId);
    const body = rows.map((r) => JSON.stringify(r.payload)).join("\n") + (rows.length ? "\n" : "");
    return reply
      .code(200)
      .header("Content-Type", "application/x-ndjson")
      .send(body);
  });

  // Aggregated per-session token summary (drives the token-savings dashboard).
  app.get(ROUTES.sessionTokenSummary(":sessionId"), async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    if (!(await sessionExists(db, sessionId))) {
      return reply.code(404).send({ error: `Session not found: ${sessionId}` });
    }
    const rows = await db
      .select()
      .from(tokenLedger)
      .where(eq(tokenLedger.sessionId, sessionId));

    let silent = 0;
    let speak = 0;
    let visual = 0;
    let dense = 0;
    let generated = 0;
    for (const r of rows) {
      if (r.decision === "silent") silent += 1;
      else if (r.decision === "speak") speak += 1;
      visual += r.tokensVisual ?? 0;
      dense += r.tokensBaselineDense ?? 0;
      generated += r.decision === "silent" ? 0 : (r.tokensGenerated ?? 0);
    }
    const saved = Math.max(dense - visual, 0);
    return {
      sessionId,
      windows: rows.length,
      silentWindows: silent,
      speakWindows: speak,
      tokensVisualTotal: visual,
      tokensBaselineDenseTotal: dense,
      tokensGeneratedTotal: generated,
      tokensSavedTotal: saved,
      savedVsBaseline: dense > 0 ? Math.min(saved / dense, 1) : 0,
    };
  });

  // A clean deploy has no runner rows; seed the configured GPUs so capacity
  // exists before the first browser session reserves a slot.
  app.addHook("onReady", async () => {
    const seeded = await seedRunners(db, cfg);
    if (seeded > 0) app.log.info(`seeded ${seeded} runner(s) at ${cfg.streamsPerRunner} slots each`);
    // Slot counters persist in Postgres across container generations, so a
    // fresh control process inherits counters leaked by sessions whose browser
    // or media container died without calling `/end`. Reconcile them against
    // the (empty at boot) live set, otherwise the stack is healthy but every
    // new ingest answers 503 "No runner capacity available".
    const reclaimed = await reclaimRunnerSlots(db, cfg);
    if (reclaimed.ended > 0 || reclaimed.runners > 0) {
      app.log.info(
        `reclaimed ${reclaimed.ended} orphaned session(s), reconciled ${reclaimed.runners} runner slot counter(s)`
      );
    }
  });

  // Reclaim on a timer too: a session abandoned mid-stream (tab closed, media
  // killed) releases its slot once its window activity is older than
  // `sessionTtlMs`, without waiting for a restart.
  const reclaimTimer = setInterval(() => {
    reclaimRunnerSlots(db, cfg).catch((err) => app.log.warn({ err }, "session reclaim failed"));
  }, Math.max(5000, cfg.sessionTtlMs / 2));
  reclaimTimer.unref?.();
  app.addHook("onClose", async () => clearInterval(reclaimTimer));

  // Media -> control WRITE path (Phase 7): reserve runner slots, persist
  // windows/events/prompts. Shares the same sessions/tokenLedger/events tables
  // as the springboard READ paths above, so data-out reflects media ingest.
  registerWriteRoutes(app, db, cfg);

  return app;
}
