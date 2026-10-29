import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { events, sessions, tokenLedger } from "@streaming-insights/db";
import type { StreamWindowEvent } from "@streaming-insights/shared";
import { openPgliteDb, type Db } from "../src/db.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../packages/db/drizzle", import.meta.url));

function makeEvent(seq: number, structured: Record<string, unknown>): StreamWindowEvent {
  return {
    sessionId: "unused",
    seq,
    tStart: seq * 5,
    tEnd: seq * 5 + 5,
    gate: { pSpeak: seq % 2 === 0 ? 0.9 : 0.1, decision: seq % 2 === 0 ? "speak" : "silent" },
    tokens: {
      visual: 100 + seq,
      baselineDense: 400,
      generated: seq % 2 === 0 ? 50 : 0,
      savedVsBaseline: 0.75,
    },
    event: {
      type: "response",
      text: `window ${seq}`,
      structured,
    },
  };
}

describe("springboard API", () => {
  let db: Db;
  let app: ReturnType<typeof buildApp>;
  let sessionId: string;

  beforeAll(async () => {
    const p = await openPgliteDb();
    db = p.db;
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

    // A session, three windows (with structured payloads), and ledger rows.
    const [session] = await db
      .insert(sessions)
      .values({ status: "streaming" })
      .returning();
    sessionId = session.id;
    await db.insert(events).values([
      { sessionId, seq: 0, payload: makeEvent(0, { tile: "person", topScore: 0.99 }), ts: new Date() },
      { sessionId, seq: 1, payload: makeEvent(1, { tile: "empty", topScore: 0.01 }), ts: new Date() },
      { sessionId, seq: 2, payload: makeEvent(2, { tile: "car", topScore: 0.88 }), ts: new Date() },
    ]);
    await db.insert(tokenLedger).values([
      { sessionId, seq: 0, tStart: 0, tEnd: 5, pSpeak: 0.9, decision: "speak", tokensVisual: 100, tokensBaselineDense: 400, tokensGenerated: 50 },
      { sessionId, seq: 1, tStart: 5, tEnd: 10, pSpeak: 0.1, decision: "silent", tokensVisual: 101, tokensBaselineDense: 400, tokensGenerated: 0 },
      { sessionId, seq: 2, tStart: 10, tEnd: 15, pSpeak: 0.9, decision: "speak", tokensVisual: 102, tokensBaselineDense: 400, tokensGenerated: 60 },
    ]);

    app = buildApp({ db, cfg: loadConfig({ SSE_POLL_MS: "100" }) });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /api/schema returns the versioned v1 JSON Schema", async () => {
    const res = await app.inject({ method: "GET", url: "/api/schema" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.version).toBe("v1");
    expect(body.schema.type).toBe("object");
    expect(body.schema.required).toContain("event");
    expect(body.schema.properties.event.properties.structured).toBeDefined();
  });

  it("GET /events.ndjson returns the batch feed an external consumer can filter on event.structured.*", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/events.ndjson` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/x-ndjson");

    const lines = res.body.trim().split("\n").map((l) => JSON.parse(l) as StreamWindowEvent);
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.seq)).toEqual([0, 1, 2]);

    // The acceptance criterion: an external consumer filters on event.structured.*.
    const speakWindows = lines.filter(
      (w) => w.event?.structured && (w.event.structured as { decision?: string }).decision !== "skip"
    );
    const tiles = lines
      .map((w) => (w.event?.structured as { tile?: string } | undefined)?.tile)
      .filter((t): t is string => !!t);
    expect(tiles).toEqual(["person", "empty", "car"]);
    expect(speakWindows.length).toBeGreaterThanOrEqual(3);

    // Every line validates against the v1 contract shape.
    for (const line of lines) {
      expect(line.gate.decision).toMatch(/^(silent|speak)$/);
      expect(line.tokens.savedVsBaseline).toBeGreaterThan(0);
    }
  });

  it("GET /token-summary aggregates the token ledger", async () => {
    const res = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}/token-summary` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sessionId).toBe(sessionId);
    expect(body.windows).toBe(3);
    expect(body.silentWindows).toBe(1);
    expect(body.speakWindows).toBe(2);
    expect(body.tokensVisualTotal).toBe(303);
    expect(body.tokensBaselineDenseTotal).toBe(1200);
    expect(body.tokensGeneratedTotal).toBe(110); // silent window contributes 0
    expect(body.savedVsBaseline).toBeCloseTo((1200 - 303) / 1200, 5);
  });

  it("returns 404 for an unknown session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/00000000-0000-0000-0000-000000000000/events.ndjson" });
    expect(res.statusCode).toBe(404);
  });

  it("GET /events (SSE) streams persisted events live", async () => {
    // Use a real listening server so the SSE stream can be read incrementally.
    const server = await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const base = `http://127.0.0.1:${port}`;

    const ctrl = new AbortController();
    const response = await fetch(`${base}/api/sessions/${sessionId}/events`, {
      signal: ctrl.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const collected: string[] = [];
    const readToTime = new Promise<void>((resolve) => {
      const read = async () => {
        const { value, done } = await reader.read();
        if (done) return resolve();
        collected.push(decoder.decode(value, { stream: true }));
        await read();
      };
      void read();
    });

    // Wait until catch-up frames for the 3 persisted events arrive.
    await new Promise((r) => setTimeout(r, 600));
    ctrl.abort();
    await readToTime.catch(() => {});

    const frames = collected.join("").split("\n\n").filter((f) => f.includes("data:"));
    const payloads = frames
      .map((f) => {
        const m = f.match(/^data: (.+)$/m);
        return m ? (JSON.parse(m[1]) as StreamWindowEvent) : null;
      })
      .filter((p): p is StreamWindowEvent => p !== null);

    expect(payloads.length).toBeGreaterThanOrEqual(3);
    expect(payloads.map((p) => p.seq)).toContain(0);
    expect(payloads[0].event?.structured).toBeDefined();
    void server;
  });
});
