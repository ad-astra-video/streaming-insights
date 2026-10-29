import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/pglite/migrator";
import { openPgliteDb, type Db } from "../src/db";
import { buildApp } from "../src/app";
import type { ServerConfig } from "../src/config";
import { sessions } from "@streaming-insights/db";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../packages/db/drizzle", import.meta.url));

const cfg: ServerConfig = {
  port: 0,
  nodeEnv: "test",
  runners: 3,
  streamsPerRunner: 3,
  maxStreams: 9,
  runnerHeartbeatTtlMs: 15000,
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
});
