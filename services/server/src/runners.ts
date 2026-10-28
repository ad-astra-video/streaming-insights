import { and, desc, eq, lte, sql } from "drizzle-orm";
import type { ServerConfig } from "./config";
import type { Db } from "./db";
import { runners, streamSessions, type Runner } from "./schema";

/** Thrown when no runner has a free slot to accept a new stream session. Maps to 503. */
export class NoCapacityError extends Error {
  constructor(public message = "No runner capacity available") {
    super(message);
    this.name = "NoCapacityError";
  }
}

export function now(): Date {
  return new Date();
}

export interface RegisterRunnerInput {
  name: string;
  gpuIndex: number;
  host: string;
  capacity?: number;
}

/**
 * Register (or idempotently refresh) a runner. Keyed by `(host, gpuIndex)` so a
 * runner re-registering after a restart keeps its identity and slot accounting.
 */
export async function registerRunner(
  db: Db,
  cfg: ServerConfig,
  input: RegisterRunnerInput
): Promise<Runner> {
  const capacity = input.capacity ?? cfg.streamsPerRunner;
  const existing = await db
    .select()
    .from(runners)
    .where(and(eq(runners.host, input.host), eq(runners.gpuIndex, input.gpuIndex)))
    .limit(1);

  if (existing[0]) {
    const [updated] = await db
      .update(runners)
      .set({
        name: input.name,
        capacity,
        status: "healthy",
        updatedAt: now(),
      })
      .where(eq(runners.id, existing[0].id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(runners)
    .values({
      name: input.name,
      gpuIndex: input.gpuIndex,
      host: input.host,
      capacity,
      status: "healthy",
      slotsUsed: 0,
    })
    .returning();
  return created;
}

/** Update a runner's heartbeat (marks it healthy) and optionally its slot usage. */
export async function heartbeatRunner(
  db: Db,
  runnerId: string,
  opts?: { slotsUsed?: number }
): Promise<Runner | null> {
  const [updated] = await db
    .update(runners)
    .set({
      lastHeartbeatAt: now(),
      status: "healthy",
      ...(opts?.slotsUsed !== undefined ? { slotsUsed: Math.max(0, opts.slotsUsed) } : {}),
      updatedAt: now(),
    })
    .where(eq(runners.id, runnerId))
    .returning();
  return updated ?? null;
}

/** Mark runners down when they have not heartbeated within `ttlMs`. Returns the
 * number of runners transitioned to `down`. */
export async function markStaleRunnersDown(db: Db, ttlMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - ttlMs);
  const stale = await db
    .select({ id: runners.id })
    .from(runners)
    .where(and(eq(runners.status, "healthy"), lte(runners.lastHeartbeatAt, cutoff)));
  if (stale.length === 0) return 0;
  for (const r of stale) {
    await db.update(runners).set({ status: "down", updatedAt: now() }).where(eq(runners.id, r.id));
  }
  return stale.length;
}

export async function listRunners(db: Db, cfg: ServerConfig): Promise<Runner[]> {
  await markStaleRunnersDown(db, cfg.runnerHeartbeatTtlMs);
  return db.select().from(runners).orderBy(desc(runners.gpuIndex));
}

export async function getRunner(db: Db, runnerId: string): Promise<Runner | null> {
  const rows = await db.select().from(runners).where(eq(runners.id, runnerId)).limit(1);
  return rows[0] ?? null;
}

export interface ResolveRunnerResult {
  runner: Runner;
  session: typeof streamSessions.$inferSelect;
}

/**
 * Create a stream session and reserve a runner slot for it. Picks the given
 * runner, or the least-loaded healthy runner with a free slot. Throws
 * NoCapacityError when no runner has capacity.
 */
export async function createStreamSession(
  db: Db,
  cfg: ServerConfig,
  input: { source: string; runnerId?: string; sessionId?: string }
): Promise<{ session: typeof streamSessions.$inferSelect; runner: Runner }> {
  await markStaleRunnersDown(db, cfg.runnerHeartbeatTtlMs);

  return db.transaction(async (tx) => {
    let runner: Runner | undefined;
    if (input.runnerId) {
      const rows = await tx.select().from(runners).where(eq(runners.id, input.runnerId)).limit(1);
      runner = rows[0];
      if (!runner) throw new CustomError(404, `Runner not found: ${input.runnerId}`);
      if (runner.status !== "healthy" || runner.slotsUsed >= runner.capacity) {
        throw new NoCapacityError();
      }
    } else {
      const rows = await tx
        .select()
        .from(runners)
        .where(and(eq(runners.status, "healthy"), sql`${runners.slotsUsed} < ${runners.capacity}`))
        .orderBy(sql`${runners.slotsUsed} asc, ${runners.capacity} desc`)
        .limit(1);
      runner = rows[0];
      if (!runner) throw new NoCapacityError();
    }

    const [session] = await tx
      .insert(streamSessions)
      .values({
        source: input.source,
        runnerId: runner.id,
        sessionId: input.sessionId ?? null,
        status: "active",
      })
      .returning();

    await tx
      .update(runners)
      .set({ slotsUsed: runner.slotsUsed + 1, updatedAt: now() })
      .where(eq(runners.id, runner.id));

    return { session, runner };
  });
}

/** End a stream session and release its runner slot (idempotent). */
export async function endStreamSession(
  db: Db,
  streamSessionId: string
): Promise<{ session: typeof streamSessions.$inferSelect; freedRunnerId: string | null } | null> {
  const rows = await db.select().from(streamSessions).where(eq(streamSessions.id, streamSessionId)).limit(1);
  const session = rows[0];
  if (!session) return null;
  if (session.status === "ended") return { session, freedRunnerId: null };

  const [ended] = await db
    .update(streamSessions)
    .set({ status: "ended", endedAt: now(), updatedAt: now() })
    .where(eq(streamSessions.id, streamSessionId))
    .returning();

  let freedRunnerId: string | null = null;
  if (session.runnerId) {
    const r = await db.select().from(runners).where(eq(runners.id, session.runnerId)).limit(1);
    if (r[0]) {
      await db
        .update(runners)
        .set({ slotsUsed: Math.max(0, r[0].slotsUsed - 1), updatedAt: now() })
        .where(eq(runners.id, r[0].id));
      freedRunnerId = r[0].id;
    }
  }
  return { session: ended, freedRunnerId };
}

export async function getStreamSession(
  db: Db,
  streamSessionId: string
): Promise<typeof streamSessions.$inferSelect | null> {
  const rows = await db.select().from(streamSessions).where(eq(streamSessions.id, streamSessionId)).limit(1);
  return rows[0] ?? null;
}

/** Small helper so route handlers can signal HTTP-mappable errors. */
export class CustomError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = "CustomError";
  }
}
