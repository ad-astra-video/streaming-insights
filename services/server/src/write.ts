// Control-plane WRITE path for the Mongo-VL streaming showcase (Phase 7).
//
// The media server (services/media) reserves a runner slot per ingest session
// and POSTs each per-window ledger row + springboard event + prompt back to the
// control server. This module registers those write routes against the deploy
// tree's `packages/db` schema so the springboard READ path (SSE / NDJSON /
// token-summary in app.ts) and the media WRITE path share the same tables.
import { and, asc, desc, eq, gte, isNull, lte } from "drizzle-orm";
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
/** Seed `cfg.runners` GPU runners when the table is empty.
 *
 *  A clean deploy starts with no runner rows, and until one exists every
 *  `POST /stream-sessions` fails the capacity check — the stack looks healthy
 *  while no browser can start a stream. Seeding here makes the committed compose
 *  self-sufficient instead of depending on a manual `POST /runners` bootstrap on
 *  the box. Idempotent: nothing is inserted once a runner row exists. */
export async function seedRunners(db: Db, cfg: ServerConfig): Promise<number> {
  const existing = await db.select().from(runners).limit(1);
  if (existing.length > 0) return 0;
  const capacity = Math.max(1, cfg.streamsPerRunner);
  for (let gpu = 0; gpu < Math.max(1, cfg.runners); gpu += 1) {
    await db
      .insert(runners)
      .values({ gpu, totalSlots: capacity, freeSlots: capacity, healthy: true });
  }
  return Math.max(1, cfg.runners);
}

/** Cutoff before which a session counts as dead (no window activity). */
function sessionCutoff(cfg: ServerConfig): Date {
  return new Date(Date.now() - cfg.sessionTtlMs);
}

/**
 * Sessions that still own a runner slot.
 *
 * A session is live while it was started recently or has produced a window
 * event within `cfg.sessionTtlMs`: the media server writes one event per closed
 * window, so silence means the ingest is gone (tab closed, media container
 * restarted) even though `/end` was never called.
 *
 * Slot capacity is DERIVED from this set, never trusted from the mutable
 * `runners.freeSlots` counter: a leaked counter permanently starved the pool
 * (three orphaned sessions => every new browser ingest 503'd on a healthy
 * stack).
 */
async function liveSessionRows(
  db: Db,
  cfg: ServerConfig
): Promise<Array<{ id: string; runnerId: string | null }>> {
  const cutoff = sessionCutoff(cfg);
  const open = await db
    .select({ id: sessions.id, runnerId: sessions.runnerId, startedAt: sessions.startedAt })
    .from(sessions)
    .where(isNull(sessions.endedAt));
  const live: Array<{ id: string; runnerId: string | null }> = [];
  for (const s of open) {
    if (s.startedAt.getTime() > cutoff.getTime()) {
      live.push({ id: s.id, runnerId: s.runnerId });
      continue;
    }
    const [recent] = await db
      .select({ ts: events.ts })
      .from(events)
      .where(and(eq(events.sessionId, s.id), gte(events.ts, cutoff)))
      .limit(1);
    if (recent) live.push({ id: s.id, runnerId: s.runnerId });
  }
  return live;
}

/** Slots held per runner id, derived from the live set. */
function usedSlots(live: Array<{ id: string; runnerId: string | null }>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of live) {
    if (!s.runnerId) continue;
    counts.set(s.runnerId, (counts.get(s.runnerId) ?? 0) + 1);
  }
  return counts;
}

/**
 * End orphaned sessions and reconcile every runner's `freeSlots` with the live
 * set. Safe to call at boot (a fresh control process owns no live media
 * sessions from a previous container generation) and from a timer.
 */
export async function reclaimRunnerSlots(
  db: Db,
  cfg: ServerConfig
): Promise<{ ended: number; runners: number }> {
  const live = await liveSessionRows(db, cfg);
  const liveIds = new Set(live.map((s) => s.id));
  const open = await db.select({ id: sessions.id }).from(sessions).where(isNull(sessions.endedAt));
  let ended = 0;
  for (const s of open) {
    if (liveIds.has(s.id)) continue;
    await db
      .update(sessions)
      .set({ status: "ended", endedAt: new Date() })
      .where(eq(sessions.id, s.id));
    ended += 1;
  }
  const counts = usedSlots(live);
  const rows = await db.select().from(runners);
  let runnersReconciled = 0;
  for (const r of rows) {
    const free = Math.max(r.totalSlots - (counts.get(r.id) ?? 0), 0);
    if (free === r.freeSlots) continue;
    await db.update(runners).set({ freeSlots: free }).where(eq(runners.id, r.id));
    runnersReconciled += 1;
  }
  return { ended, runners: runnersReconciled };
}

export function registerWriteRoutes(
  app: FastifyInstance,
  db: Db,
  cfg: ServerConfig
): void {
  /** Reclaim orphaned sessions + reconcile slot counters for this deploy. */
  const reclaim = () => reclaimRunnerSlots(db, cfg);

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

      // Capacity is derived from the live session set, never from the mutable
      // `freeSlots` counter (see liveSessionRows): a leaked counter used to
      // starve a healthy pool permanently.
      const live = await liveSessionRows(db, cfg);
      const used = usedSlots(live);
      const freeFor = (r: { id: string; totalSlots: number }) =>
        Math.max(r.totalSlots - (used.get(r.id) ?? 0), 0);

      // Prefer the requested runner, else the first with a free slot.
      let runner;
      if (req.body?.runnerId) {
        const [r] = await db.select().from(runners).where(eq(runners.id, req.body.runnerId)).limit(1);
        if (!r) return reply.code(404).send({ error: `Runner not found: ${req.body.runnerId}` });
        runner = r;
      } else {
        const candidates = await db
          .select()
          .from(runners)
          .where(eq(runners.healthy, true))
          .orderBy(desc(runners.freeSlots));
        runner = candidates.find((r) => freeFor(r) > 0);
      }

      // Capacity is a HARD limit: a session must own a slot on a healthy runner.
      // The unpinned path used to fall through with `runner === undefined` and
      // still create a capacity-less session (`runner_id` null), which both
      // bypassed MAX_STREAMS and leaked slots (nothing to release on /end).
      if (!runner) {
        return reply.code(503).send({ error: "No runner capacity available" });
      }
      if (!runner.healthy) {
        return reply.code(503).send({ error: `Runner ${runner.id} is not healthy` });
      }
      const free = freeFor(runner);
      if (free <= 0) {
        return reply.code(503).send({ error: "No runner capacity available" });
      }
      await db
        .update(runners)
        .set({ freeSlots: free - 1 })
        .where(eq(runners.id, runner.id));

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
              slotsUsed: runner.totalSlots - free + 1,
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
      // Recompute from the live set instead of `+1`: an unconditional increment
      // could push freeSlots above totalSlots and hand out slots the runner
      // does not have.
      const counts = usedSlots(await liveSessionRows(db, cfg));
      const [r] = await db.select().from(runners).where(eq(runners.id, session.runnerId)).limit(1);
      if (r) {
        const free = Math.max(r.totalSlots - (counts.get(r.id) ?? 0), 0);
        await db.update(runners).set({ freeSlots: free }).where(eq(runners.id, r.id));
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
      // A runner that stopped heartbeating is down: no session may stay pinned
      // to it, and its slots must not be counted as capacity.
      await db.update(runners).set({ healthy: false }).where(eq(runners.id, r.id));
      released += 1;
    }
    // Reconcile counters with the real live set (this also reclaims slots held
    // by sessions that died without calling `/end`).
    const reconciled = await reclaim();
    return { released, reclaimed: reconciled.runners, ended: reconciled.ended };
  });

  /** Orphaned-session reclaim, callable at boot and from a timer. */
  app.post("/runners/reclaim", async () => reclaim());
}
