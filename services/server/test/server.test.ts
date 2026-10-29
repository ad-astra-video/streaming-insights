import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { openPgliteDb } from "../src/db";
import { buildApp } from "../src/app";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { ServerConfig } from "../src/config";

const MIGRATIONS_DIR = fileURLToPath(new URL("../drizzle", import.meta.url));

const cfg: ServerConfig = {
  port: 0,
  nodeEnv: "test",
  runners: 3,
  streamsPerRunner: 3,
  maxStreams: 9,
  runnerHeartbeatTtlMs: 15000,
};

let app: FastifyInstance;

beforeAll(async () => {
  const { db } = await openPgliteDb();
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  app = buildApp({ db, cfg });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("control server (Phase 1)", () => {
  it("GET /health reports ok with empty runners/streams", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.runners).toEqual([]);
    expect(body.streamSessions).toEqual([]);
    expect(body.maxStreams).toBe(9);
  });

  it("registers a runner", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/runners",
      payload: { name: "runner-0", gpuIndex: 0, host: "box-151" },
    });
    expect(res.statusCode).toBe(201);
    const runner = res.json();
    expect(runner.id).toBeTruthy();
    expect(runner.capacity).toBe(3);
    expect(runner.slotsUsed).toBe(0);
    expect(runner.status).toBe("healthy");
  });

  it("creates a stream session, records a runner slot and persists a prompt, then returns an empty token-summary", async () => {
    // Register a runner that will absorb the dispatched stream.
    const runnerRes = await app.inject({
      method: "POST",
      url: "/runners",
      payload: { name: "runner-1", gpuIndex: 1, host: "box-151" },
    });
    expect(runnerRes.statusCode).toBe(201);
    const runnerId = runnerRes.json().id;

    // 1. Create a stream session -> reserves a runner slot. Pin the runner so the
    // slot accounting is deterministic.
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
    // Slot recorded: the runner now reports slotsUsed=1.
    expect(created.runner.slotsUsed).toBe(1);
    expect(created.runner.id).toBe(runnerId);

    const streamSessionId = created.session.id;

    // 2. Persist a prompt on the stream session.
    const promptRes = await app.inject({
      method: "POST",
      url: `/stream-sessions/${streamSessionId}/prompts`,
      payload: { text: "Describe what the presenter is doing." },
    });
    expect(promptRes.statusCode).toBe(201);
    const prompt = promptRes.json();
    expect(prompt.streamSessionId).toBe(streamSessionId);
    expect(prompt.text).toBe("Describe what the presenter is doing.");

    // 3. Return an (empty) token-summary — no windows recorded yet.
    const summaryRes = await app.inject({
      method: "GET",
      url: `/stream-sessions/${streamSessionId}/token-summary`,
    });
    expect(summaryRes.statusCode).toBe(200);
    expect(summaryRes.json()).toEqual({
      streamSessionId,
      windows: 0,
      silentWindows: 0,
      speakWindows: 0,
      tokensVisualTotal: 0,
      tokensBaselineDenseTotal: 0,
      tokensGeneratedTotal: 0,
      tokensSavedTotal: 0,
      savingsPct: 0,
    });

    // 4. Record a per-window ledger row -> summary becomes non-empty.
    const windowRes = await app.inject({
      method: "POST",
      url: `/stream-sessions/${streamSessionId}/windows`,
      payload: {
        seq: 0,
        tStart: 0,
        tEnd: 8,
        pSpeak: 0.19,
        decision: "silent",
        tokensVisual: 40,
        tokensBaselineDense: 312,
        tokensGenerated: 0,
      },
    });
    expect(windowRes.statusCode).toBe(201);

    const summary2 = await app.inject({
      method: "GET",
      url: `/stream-sessions/${streamSessionId}/token-summary`,
    });
    const s2 = summary2.json();
    expect(s2.windows).toBe(1);
    expect(s2.silentWindows).toBe(1);
    expect(s2.tokensVisualTotal).toBe(40);
    expect(s2.tokensBaselineDenseTotal).toBe(312);
    expect(s2.tokensGeneratedTotal).toBe(0);
    expect(s2.tokensSavedTotal).toBe(272);
    expect(s2.savingsPct).toBeCloseTo(272 / 312, 5);
  });

  it("returns 503 when a runner has no free slot (explicit pin)", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/runners",
      payload: { name: "full-runner", gpuIndex: 0, host: "box-151", capacity: 1 },
    });
    expect(r.statusCode).toBe(201);
    const fullRunnerId = r.json().id;

    const first = await app.inject({
      method: "POST",
      url: "/stream-sessions",
      payload: { source: "file", runnerId: fullRunnerId },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().runner.slotsUsed).toBe(1);

    // Second dispatch pinned to the now-full (capacity 1) runner -> 503.
    const second = await app.inject({
      method: "POST",
      url: "/stream-sessions",
      payload: { source: "file", runnerId: fullRunnerId },
    });
    expect(second.statusCode).toBe(503);
  });

  it("returns 404 for a missing stream session on prompt/token-summary", async () => {
    const fake = "00000000-0000-0000-0000-000000000000";
    const p = await app.inject({
      method: "POST",
      url: `/stream-sessions/${fake}/prompts`,
      payload: { text: "hi" },
    });
    expect(p.statusCode).toBe(404);
    const s = await app.inject({ method: "GET", url: `/stream-sessions/${fake}/token-summary` });
    expect(s.statusCode).toBe(404);
  });
});
