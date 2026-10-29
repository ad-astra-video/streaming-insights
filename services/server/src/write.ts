// Control-plane WRITE path for the Mongo-VL streaming showcase (Phase 7).
//
// The media server (services/media) reserves a runner slot per ingest session
// and POSTs each per-window ledger row + springboard event + prompt back to the
// control server. This module registers those write routes against the deploy
// tree's `packages/db` schema so the springboard READ path (SSE / NDJSON /
// token-summary in app.ts) and the media WRITE path share the same tables.
import { and, asc, desc, eq, lte } from "drizzle-orm";
import { events, prompts, runners, sessions, tokenLedger } from "@streaming-insights/db";
import type { FastifyInstance } from "fastify";
import type { Db } from "./db.js";
import type { ServerConfig } from "./config.js";

/** Thrown when no runner has a free slot. Maps to 503. */
export class NoCapacityError extends Error {
  constructor(message = "No runner capacity available") {
    super(message);
    this.name = "NoCapacityError";
  }
}

interface ReservedResult {
  session: { id: string; status: string; source?: string };
  runner: { id: string | null; status: string; slotsUsed: number; capacity: number };
}

/**
 * Register the media -> control write routes. Contract (matches
 * services/media/src/control-client.ts ControlClient):
 *   POST /stream-sessions                        { source?, runnerId? } -> session + runner
 *   POST /stream-sessions/:id/end                -> release runner slot
 *   POST /stream-sessions/:id/windows            { seq,tStart,tEnd,... } -> token ledger row
 *   POST /stream-sessions/:id/events             { seq,tStart,tEnd,gate,tokens,prompt,event } -> event
 *   POST /stream-sessions/:id/prompts            { text } -> prompt
 *   GET  /runners                                -> list
 *   POST /runners                                { gpu, capacity? } -> register (test bootstrap)
 */
export function registerWriteRoutes(
  app: FastifyInstance,
  db: Db,
  cfg: ServerConfig
): void {
  // --- Runners ---
  app.get("/runners", async () => {
    // Expose occupied slots alongside free/total, mirroring the reservation
    // response the media server consumes (origin Phase 1 runner contract).
    const rows = await db.select().from(runners).orderBy(desc(runners.gpu));
    return {
      runners: rows.map((r) => ({
        ...r,
        slotsUsed: Math.max(r.totalSlots - r.freeSlots, 0),
      })),
    };
  });

  app.post<{ Body: { gpu: number; capacity?: number } }>("/runners", async (req, reply) => {
    const gpu = req.body?.gpu;
    if (typeof gpu !== "number") {
      return reply.code(422).send({ error: "gpu (number) is required" });
    }
    const capacity = req.body?.capacity ?? cfg.streamsPerRunner;
    const [created] = await db
      .insert(runners)
      .values({ gpu, totalSlots: capacity, freeSlots: capacity, healthy: true })
      .returning();
    return reply.code(201).send(created);
  });

  app.post<{ Params: { id: string }; Body: { slotsUsed?: number } }>(
    "/runners/:id/heartbeat",
    async (req, reply) => {
      const [updated] = await db
        .update(runners)
        .set({ healthy: true, lastHeartbeat: new Date() })
        .where(eq(runners.id, req.params.id))
        .returning();
      if (!updated) return reply.code(404).send({ error: `Runner not found: ${req.params.id}` });
      return updated;
    }
  );

  // --- Stream sessions (reserve a runner slot) ---
  app.post<{ Body: { source?: string; runnerId?: string } }>(
    "/stream-sessions",
    async (req, reply) => {
      const source = req.body?.source ?? "webrtc";

      // Prefer the requested runner, else the first with a free slot.
      let runner;
      if (req.body?.runnerId) {
        const [r] = await db.select().from(runners).where(eq(runners.id, req.body.runnerId)).limit(1);
        runner = r;
      } else {
        const candidates = await db
          .select()
          .from(runners)
          .where(eq(runners.healthy, true))
          .orderBy(desc(runners.freeSlots));
        runner = candidates.find((r) => r.freeSlots > 0);
      }

      if (runner && runner.freeSlots <= 0) {
        return reply.code(503).send({ error: "No runner capacity available" });
      }
      if (runner) {
        await db
          .update(runners)
          .set({ freeSlots: runner.freeSlots - 1 })
          .where(eq(runners.id, runner.id));
      }

      const [session] = await db
        .insert(sessions)
        .values({ status: "active", runnerId: runner?.id ?? null })
        .returning();

      const result: ReservedResult = {
        session: { id: session.id, status: session.status, source },
        runner: runner
          ? {
              id: runner.id,
              status: runner.healthy ? "healthy" : "down",
              slotsUsed: runner.totalSlots - (runner.freeSlots - 1),
              capacity: runner.totalSlots,
            }
          : { id: null, status: "none", slotsUsed: 0, capacity: 0 },
      };
      return reply.code(201).send(result);
    }
  );

  app.post<{ Params: { id: string } }>("/stream-sessions/:id/end", async (req, reply) => {
    const [session] = await db
      .update(sessions)
      .set({ status: "ended", endedAt: new Date() })
      .where(eq(sessions.id, req.params.id))
      .returning();
    if (!session) return reply.code(404).send({ error: `Stream session not found: ${req.params.id}` });
    if (session.runnerId) {
      const [r] = await db.select().from(runners).where(eq(runners.id, session.runnerId)).limit(1);
      if (r && r.freeSlots < r.totalSlots) {
        await db.update(runners).set({ freeSlots: r.freeSlots + 1 }).where(eq(runners.id, r.id));
      }
    }
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/stream-sessions/:id", async (req, reply) => {
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, req.params.id))
      .limit(1);
    if (!session) return reply.code(404).send({ error: `Stream session not found: ${req.params.id}` });
    return { session };
  });

  // --- Prompts ---
  app.post<{ Params: { id: string }; Body: { text: string } }>(
    "/stream-sessions/:id/prompts",
    async (req, reply) => {
      const text = req.body?.text;
      if (typeof text !== "string" || text.length === 0) {
        return reply.code(422).send({ error: "text is required" });
      }
      const session = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, req.params.id)).limit(1);
      if (session.length === 0) {
        return reply.code(404).send({ error: `Stream session not found: ${req.params.id}` });
      }
      const [prompt] = await db
        .insert(prompts)
        .values({ sessionId: req.params.id, body: text })
        .returning();
      return reply.code(201).send(prompt);
    }
  );

  // --- Token ledger / windows ---
  app.post<{
    Params: { id: string };
    Body: {
      seq: number;
      tStart: number;
      tEnd: number;
      pSpeak?: number;
      decision?: "silent" | "speak";
      tokensVisual?: number;
      tokensBaselineDense?: number;
      tokensGenerated?: number;
      prompt?: string;
      responseText?: string;
    };
  }>("/stream-sessions/:id/windows", async (req, reply) => {
    const b = req.body ?? {};
    if (typeof b.seq !== "number" || typeof b.tStart !== "number" || typeof b.tEnd !== "number") {
      return reply.code(422).send({ error: "seq, tStart and tEnd are required" });
    }
    const [row] = await db
      .insert(tokenLedger)
      .values({
        sessionId: req.params.id,
        seq: b.seq,
        tStart: b.tStart,
        tEnd: b.tEnd,
        pSpeak: b.pSpeak ?? 0,
        decision: b.decision ?? "silent",
        tokensVisual: b.tokensVisual ?? 0,
        tokensBaselineDense: b.tokensBaselineDense ?? 0,
        tokensGenerated: b.tokensGenerated ?? 0,
        prompt: b.prompt ?? null,
        responseText: b.responseText ?? null,
      })
      .returning();
    return reply.code(201).send(row);
  });

  // --- Token ledger read path (media/ingest inspection, origin Phase 1 API) ---
  app.get<{ Params: { id: string } }>("/stream-sessions/:id/windows", async (req, reply) => {
    const session = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, req.params.id))
      .limit(1);
    if (session.length === 0) {
      return reply.code(404).send({ error: `Stream session not found: ${req.params.id}` });
    }
    const rows = await db
      .select()
      .from(tokenLedger)
      .where(eq(tokenLedger.sessionId, req.params.id))
      .orderBy(asc(tokenLedger.seq));
    return { windows: rows };
  });

  // --- Springboard events (data-out) ---
  app.post<{
    Params: { id: string };
    Body: {
      seq: number;
      tStart: number;
      tEnd: number;
      gate?: unknown;
      tokens?: unknown;
      prompt?: string;
      event?: unknown;
    };
  }>("/stream-sessions/:id/events", async (req, reply) => {
    const b = req.body ?? {};
    if (typeof b.seq !== "number" || typeof b.tStart !== "number" || typeof b.tEnd !== "number") {
      return reply.code(422).send({ error: "seq, tStart and tEnd are required" });
    }
    const session = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, req.params.id)).limit(1);
    if (session.length === 0) {
      return reply.code(404).send({ error: `Stream session not found: ${req.params.id}` });
    }
    const [row] = await db
      .insert(events)
      .values({
        sessionId: req.params.id,
        seq: b.seq,
        payload: {
          sessionId: req.params.id,
          seq: b.seq,
          tStart: b.tStart,
          tEnd: b.tEnd,
          gate: b.gate ?? null,
          tokens: b.tokens ?? null,
          prompt: b.prompt ?? null,
          event: b.event ?? null,
        },
      })
      .returning();
    return reply.code(201).send(row);
  });

  // --- Event read path: the persisted per-window springboard event, flattened
  // from the `events.payload` jsonb back to the media/ingest POST body shape so
  // an ingest can be inspected end-to-end (gate + tokens + text).
  app.get<{ Params: { id: string } }>("/stream-sessions/:id/events", async (req, reply) => {
    const session = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, req.params.id))
      .limit(1);
    if (session.length === 0) {
      return reply.code(404).send({ error: `Stream session not found: ${req.params.id}` });
    }
    const rows = await db
      .select()
      .from(events)
      .where(eq(events.sessionId, req.params.id))
      .orderBy(asc(events.seq));
    return {
      events: rows.map((r) => ({
        ...(r.payload as Record<string, unknown>),
        id: r.id,
        createdAt: r.ts,
      })),
    };
  });

  // --- Stale runner reclaim (mark down + release sessions) ---
  app.post("/runners/reap", async () => {
    const cutoff = new Date(Date.now() - cfg.runnerHeartbeatTtlMs);
    const stale = await db
      .select()
      .from(runners)
      .where(and(eq(runners.healthy, true), lte(runners.lastHeartbeat, cutoff)));
    let released = 0;
    for (const r of stale) {
      // Reclaim this runner by resetting its free slots after marking it down;
      // any sessions pinned to it are ended by their owner's /end path.
      await db.update(runners).set({ healthy: false, freeSlots: r.totalSlots }).where(eq(runners.id, r.id));
      released += 1;
    }
    return { released };
  });
}
