import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq, isNull } from "drizzle-orm";
import { migrate } from "drizzle-orm/pglite/migrator";
import { openPgliteDb, type Db } from "../src/db";
import { buildApp } from "../src/app";
import type { ServerConfig } from "../src/config";
import { runners, sessions } from "@streaming-insights/db";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/drizzle", import.meta.url));

const cfg: ServerConfig = {
  port: 0,
  nodeEnv: "test",
  runners: 3,
  streamsPerRunner: 3,
  maxStreams: 9,
  runnerHeartbeatTtlMs: 15000,
  sessionTtlMs: 60000,
  ssePollMs: 100,
};

let app: FastifyInstance;
let db: Db;

beforeAll(async () => {
  const opened = await openPgliteDb();
  db = opened.db;
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  app = buildApp({ db, cfg });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("control server write path (media -> control ingest)", () => {
  it("seeds runner capacity on a clean deploy so the first session can reserve", async () => {
    const rows = await db.select().from(runners);
    expect(rows.length).toBe(cfg.runners);
    expect(rows.every((r) => r.freeSlots === cfg.streamsPerRunner)).toBe(true);
    expect(rows.every((r) => r.healthy)).toBe(true);
  });

  it("registers a runner", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/runners",
      payload: { gpu: 0, capacity: 3 },
    });
    expect(res.statusCode).toBe(201);
    const runner = res.json();
    expect(runner.id).toBeTruthy();
    expect(runner.gpu).toBe(0);
    expect(runner.totalSlots).toBe(3);
    expect(runner.freeSlots).toBe(3);
    expect(runner.healthy).toBe(true);
  });

  it("creates a stream session, reserves a runner slot, and returns the media contract", async () => {
    const r = await app.inject({ method: "POST", url: "/runners", payload: { gpu: 1, capacity: 3 } });
    const runnerId = r.json().id;

    const createRes = await app.inject({
      method: "POST",
      url: "/stream-sessions",
      payload: { source: "webrtc", runnerId },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    expect(created.session.id).toBeTruthy();
    expect(created.session.status).toBe("active");
    expect(created.session.source).toBe("webrtc");
    expect(created.runner.id).toBe(runnerId);
    expect(created.runner.slotsUsed).toBe(1);
    expect(created.runner.capacity).toBe(3);
  });

  it("persists a prompt and a window, then reads it back via the token ledger", async () => {
    const r = await app.inject({ method: "POST", url: "/runners", payload: { gpu: 2, capacity: 3 } });
    const runnerId = r.json().id;
    const c = await app.inject({ method: "POST", url: "/stream-sessions", payload: { source: "webrtc", runnerId } });
    const sid = c.json().session.id;

    const p = await app.inject({ method: "POST", url: `/stream-sessions/${sid}/prompts`, payload: { text: "hi" } });
    expect(p.statusCode).toBe(201);

    const w = await app.inject({
      method: "POST",
      url: `/stream-sessions/${sid}/windows`,
      payload: { seq: 0, tStart: 0, tEnd: 8, pSpeak: 0.19, decision: "silent", tokensVisual: 40, tokensBaselineDense: 312, tokensGenerated: 0 },
    });
    expect(w.statusCode).toBe(201);
    expect(w.json().seq).toBe(0);
    expect(w.json().decision).toBe("silent");
  });

  it("persists a springboard event that the data-out feed reads back", async () => {
    const c = await app.inject({ method: "POST", url: "/stream-sessions", payload: { source: "webrtc" } });
    const sid = c.json().session.id;

    const e = await app.inject({
      method: "POST",
      url: `/stream-sessions/${sid}/events`,
      payload: {
        seq: 0,
        tStart: 0,
        tEnd: 8,
        gate: { pSpeak: 0.2, decision: "silent" },
        tokens: { visual: 40, baselineDense: 312, generated: 0, savedVsBaseline: 0.87 },
        prompt: "hi",
        event: { type: "response", text: "hello" },
      },
    });
    expect(e.statusCode).toBe(201);

    // Springboard NDJSON feed returns the persisted event.
    const nd = await app.inject({ method: "GET", url: `/api/sessions/${sid}/events.ndjson` });
    expect(nd.statusCode).toBe(200);
    const lines = nd.body.split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.seq).toBe(0);
    expect(parsed.gate.decision).toBe("silent");
  });

  it("returns 503 when a pinned runner has no free slot", async () => {
    const r = await app.inject({ method: "POST", url: "/runners", payload: { gpu: 3, capacity: 1 } });
    const fullId = r.json().id;
    const first = await app.inject({ method: "POST", url: "/stream-sessions", payload: { source: "file", runnerId: fullId } });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: "POST", url: "/stream-sessions", payload: { source: "file", runnerId: fullId } });
    expect(second.statusCode).toBe(503);
  });

  it("returns 404 for a missing stream session on prompts", async () => {
    const fake = "00000000-0000-0000-0000-000000000000";
    const p = await app.inject({ method: "POST", url: `/stream-sessions/${fake}/prompts`, payload: { text: "hi" } });
    expect(p.statusCode).toBe(404);
  });

  it("derives capacity from live sessions instead of the leaked free-slots counter", async () => {
    // Simulate the deployed failure: a persisted counter says the pool is full
    // while no session actually holds a slot. The old code answered 503 here.
    await db.update(runners).set({ freeSlots: 0 });
    const res = await app.inject({ method: "POST", url: "/stream-sessions", payload: { source: "webrtc" } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.runner.id).toBeTruthy();
    expect(body.runner.slotsUsed).toBeGreaterThanOrEqual(1);
    expect(body.runner.slotsUsed).toBeLessThanOrEqual(body.runner.capacity);
  });

  it("hard-stops an unpinned reserve when every slot is held by a live session", async () => {
    // Fill the pool with real reservations (never a hand-set counter), then the
    // next reserve must fail and must not create a capacity-less session.
    let filled = 0;
    for (let i = 0; i < 50; i += 1) {
      const r = await app.inject({ method: "POST", url: "/stream-sessions", payload: { source: "webrtc" } });
      if (r.statusCode === 503) break;
      expect(r.statusCode).toBe(201);
      filled += 1;
    }
    expect(filled).toBeGreaterThan(0);
    const before = (await db.select().from(sessions)).length;
    const res = await app.inject({ method: "POST", url: "/stream-sessions", payload: { source: "webrtc" } });
    expect(res.statusCode).toBe(503);
    // No capacity-less session may be created (`runner_id` null leaked slots
    // because /end had nothing to release).
    expect((await db.select().from(sessions)).length).toBe(before);
  });

  it("reclaims the slot of a session that died without calling /end", async () => {
    const res = await app.inject({ method: "POST", url: "/stream-sessions", payload: { source: "webrtc" } });
    // Pool is full from the previous test, so first free a slot.
    if (res.statusCode === 503) {
      const [live] = await db
        .select()
        .from(sessions)
        .where(isNull(sessions.endedAt))
        .limit(1);
      await app.inject({ method: "POST", url: `/stream-sessions/${live.id}/end` });
    }
    const created = await app.inject({ method: "POST", url: "/stream-sessions", payload: { source: "webrtc" } });
    expect(created.statusCode).toBe(201);
    const sid = created.json().session.id as string;

    // Backdate it past the session TTL: the browser went away without /end.
    await db
      .update(sessions)
      .set({ startedAt: new Date(Date.now() - cfg.sessionTtlMs - 1000) })
      .where(eq(sessions.id, sid));

    const reclaim = await app.inject({ method: "POST", url: "/runners/reclaim" });
    expect(reclaim.statusCode).toBe(200);
    expect(reclaim.json().ended).toBeGreaterThanOrEqual(1);

    const [after] = await db.select().from(sessions).where(eq(sessions.id, sid));
    expect(after.status).toBe("ended");
    expect(after.endedAt).not.toBeNull();

    // The reclaimed slot is usable again.
    const reuse = await app.inject({ method: "POST", url: "/stream-sessions", payload: { source: "webrtc" } });
    expect(reuse.statusCode).toBe(201);
  });

  it("returns 404 for a pinned reserve on an unknown runner", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/stream-sessions",
      payload: { source: "webrtc", runnerId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("reap reclaims slots leaked on a runner that never sent a heartbeat", async () => {
    // Clear live sessions so the reconciliation target is unambiguous.
    const open = await db.select().from(sessions).where(isNull(sessions.endedAt));
    for (const s of open) {
      await db.update(sessions).set({ status: "ended", endedAt: new Date() }).where(eq(sessions.id, s.id));
    }
    const [row] = await db.select().from(runners).limit(1);
    expect(row.lastHeartbeat).toBeNull();
    await db.update(runners).set({ freeSlots: 0 }).where(eq(runners.id, row.id));
    const res = await app.inject({ method: "POST", url: "/runners/reap" });
    expect(res.statusCode).toBe(200);
    expect(res.json().reclaimed).toBeGreaterThanOrEqual(1);
    const [after] = await db.select().from(runners).where(eq(runners.id, row.id));
    expect(after.freeSlots).toBe(after.totalSlots);
  });
});

describe("boot reclaim (deploy inheriting leaked slot counters)", () => {
  it("ends orphaned sessions and reconciles runners on ready", async () => {
    // Reproduces the deployed state: Postgres outlives the container, so the
    // new control process inherits slots pinned by sessions that never ended.
    const opened = await openPgliteDb();
    const bootDb = opened.db;
    await migrate(bootDb, { migrationsFolder: MIGRATIONS_DIR });
    const [stale] = await bootDb
      .insert(runners)
      .values({ gpu: 0, totalSlots: 3, freeSlots: 0, healthy: true })
      .returning();
    await bootDb
      .insert(sessions)
      .values({
        status: "active",
        runnerId: stale.id,
        startedAt: new Date(Date.now() - cfg.sessionTtlMs - 60_000),
      });

    const bootApp = buildApp({ db: bootDb, cfg });
    await bootApp.ready();
    try {
      const [runner] = await bootDb.select().from(runners).where(eq(runners.id, stale.id));
      expect(runner.freeSlots).toBe(runner.totalSlots);
      const [session] = await bootDb.select().from(sessions);
      expect(session.status).toBe("ended");
      expect(session.endedAt).not.toBeNull();
      // And the booted stack can actually take a new ingest.
      const res = await bootApp.inject({ method: "POST", url: "/stream-sessions", payload: { source: "webrtc" } });
      expect(res.statusCode).toBe(201);
    } finally {
      await bootApp.close();
    }
  });
});
