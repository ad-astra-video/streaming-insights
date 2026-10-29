import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { asc, desc, eq } from "drizzle-orm";
import type { Db } from "./db";
import type { ServerConfig } from "./config";
import {
  createStreamSession,
  endStreamSession,
  getStreamSession,
  getRunner,
  heartbeatRunner,
  listRunners,
  registerRunner,
  NoCapacityError,
  CustomError,
} from "./runners";
import { persistPrompt } from "./prompts";
import { recordWindow, listWindows, type RecordWindowInput } from "./ledger";
import { tokenSummary } from "./token-summary";
import { events, prompts, runners as runnersTable, streamSessions } from "./schema";

export interface AppDeps {
  db: Db;
  cfg: ServerConfig;
}

/**
 * Build the control-plane Fastify app for the Mage-VL streaming showcase.
 * Scaffolded to mirror highlights.live `services/server` (`buildApp`): a bare
 * Fastify instance, CORS on, and routes that talk to the Drizzle `Db`. No auth
 * for this greenfield phase — the goal is to persist stream sessions, prompts,
 * and runner slots, and to expose runner health/capacity and a token summary.
 */
export function buildApp(deps: AppDeps): FastifyInstance {
  const { db, cfg } = deps;
  const app = Fastify({ logger: false });
  app.register(cors, { origin: true });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof NoCapacityError) return reply.code(503).send({ error: err.message });
    if (err instanceof CustomError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    app.log.error(err);
    return reply.code(500).send({ error: "internal error" });
  });

  // --- Health ---
  app.get("/health", async () => {
    const runners = await db.select().from(runnersTable).orderBy(desc(runnersTable.gpuIndex));
    const streams = await db.select().from(streamSessions);
    return { status: "ok", runners, streamSessions: streams, maxStreams: cfg.maxStreams };
  });

  // --- Runners ---
  app.post<{ Body: { name: string; gpuIndex: number; host: string; capacity?: number } }>(
    "/runners",
    async (req, reply) => {
      const { name, gpuIndex, host, capacity } = req.body ?? {};
      if (!name || typeof gpuIndex !== "number" || !host) {
        return reply.code(422).send({ error: "name, gpuIndex and host are required" });
      }
      const runner = await registerRunner(db, cfg, { name, gpuIndex, host, capacity });
      return reply.code(201).send(runner);
    }
  );

  app.post<{ Params: { id: string }; Body: { slotsUsed?: number } }>(
    "/runners/:id/heartbeat",
    async (req, reply) => {
      const runner = await heartbeatRunner(db, req.params.id, { slotsUsed: req.body?.slotsUsed });
      if (!runner) return reply.code(404).send({ error: `Runner not found: ${req.params.id}` });
      return runner;
    }
  );

  app.get("/runners", async () => ({ runners: await listRunners(db, cfg) }));

  // --- Stream sessions ---
  app.post<{ Body: { source: string; runnerId?: string; sessionId?: string } }>(
    "/stream-sessions",
    async (req, reply) => {
      const { source, runnerId, sessionId } = req.body ?? {};
      if (!source) return reply.code(422).send({ error: "source is required" });
      const { session, runner } = await createStreamSession(db, cfg, { source, runnerId, sessionId });
      return reply.code(201).send({ session, runner });
    }
  );

  app.post<{ Params: { id: string } }>("/stream-sessions/:id/end", async (req, reply) => {
    const result = await endStreamSession(db, req.params.id);
    if (!result) return reply.code(404).send({ error: `Stream session not found: ${req.params.id}` });
    return result;
  });

  app.get<{ Params: { id: string } }>("/stream-sessions/:id", async (req, reply) => {
    const session = await getStreamSession(db, req.params.id);
    if (!session) return reply.code(404).send({ error: `Stream session not found: ${req.params.id}` });
    const runner = session.runnerId ? await getRunner(db, session.runnerId) : null;
    const [promptRow] = await db
      .select()
      .from(prompts)
      .where(eq(prompts.streamSessionId, session.id))
      .limit(1);
    return { session, runner, prompt: promptRow ?? null };
  });

  // --- Prompts ---
  app.post<{ Params: { id: string }; Body: { text: string } }>(
    "/stream-sessions/:id/prompts",
    async (req, reply) => {
      const text = req.body?.text;
      if (typeof text !== "string" || text.length === 0) {
        return reply.code(422).send({ error: "text is required" });
      }
      const prompt = await persistPrompt(db, req.params.id, text);
      return reply.code(201).send(prompt);
    }
  );

  // --- Token ledger / windows ---
  app.post<{ Params: { id: string }; Body: RecordWindowInput }>(
    "/stream-sessions/:id/windows",
    async (req, reply) => {
      const b = req.body ?? {};
      if (typeof b.seq !== "number" || typeof b.tStart !== "number" || typeof b.tEnd !== "number") {
        return reply.code(422).send({ error: "seq, tStart and tEnd are required" });
      }
      const row = await recordWindow(db, req.params.id, b);
      return reply.code(201).send(row);
    }
  );

  app.get<{ Params: { id: string } }>("/stream-sessions/:id/windows", async (req, reply) => ({
    windows: await listWindows(db, req.params.id),
  }));

  app.get<{ Params: { id: string } }>("/stream-sessions/:id/token-summary", async (req, reply) => {
    const session = await getStreamSession(db, req.params.id);
    if (!session) return reply.code(404).send({ error: `Stream session not found: ${req.params.id}` });
    const summary = await tokenSummary(db, req.params.id);
    return { streamSessionId: req.params.id, ...summary };
  });

  // --- Events (springboard data-out contract) ---
  app.get<{ Params: { id: string } }>("/stream-sessions/:id/events", async (req, reply) => {
    const rows = await db
      .select()
      .from(events)
      .where(eq(events.streamSessionId, req.params.id))
      .orderBy(asc(events.seq));
    return { events: rows };
  });

  return app;
}
