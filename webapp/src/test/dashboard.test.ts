import { describe, it, expect } from "vitest";
import type { StreamWindowEvent } from "@streaming-insights/shared";
import {
  deriveDashboard,
  explainWindow,
  toSparkPoint,
  GATE_THRESHOLD,
} from "../lib/dashboard";

/** Build a window event for tests. `decision` and `gen` set the gate/tokens. */
function evt(
  seq: number,
  tStart: number,
  tEnd: number,
  decision: "silent" | "speak",
  gen: number,
  pSpeak: number,
  visual = 100,
  baselineDense = 400,
): StreamWindowEvent {
  return {
    sessionId: "s1",
    seq,
    tStart,
    tEnd,
    gate: { pSpeak, decision },
    tokens: {
      visual,
      baselineDense,
      generated: decision === "silent" ? 0 : gen,
      savedVsBaseline: Math.min(1 - visual / baselineDense, 1),
    },
  };
}

describe("toSparkPoint / sparkline series", () => {
  it("projects each window into a pSpeak point with its decision band", () => {
    const e = evt(3, 16, 24, "speak", 64, 0.551);
    const p = toSparkPoint(e);
    expect(p).toEqual({
      seq: 3,
      pSpeak: 0.551,
      decision: "speak",
      tStart: 16,
      tEnd: 24,
    });
  });
});

describe("explainWindow (why silent / why speak)", () => {
  it("explains a silent window as routine content below the threshold", () => {
    const x = explainWindow(evt(0, 0, 8, "silent", 0, 0.19));
    expect(x.decision).toBe("silent");
    expect(x.headline).toBe("routine content — gate silent");
    expect(x.detail).toContain("below");
    expect(x.detail).toContain(GATE_THRESHOLD.toFixed(2));
  });

  it("explains a speak window as noteworthy content at/above the threshold", () => {
    const x = explainWindow(evt(1, 8, 16, "speak", 64, 0.551));
    expect(x.decision).toBe("speak");
    expect(x.headline).toBe("noteworthy content — gate fired");
    expect(x.detail).toContain("at/above");
  });
});

describe("deriveDashboard", () => {
  it("computes stream-minutes vs tokens-avoided as two separate counters", () => {
    const events = [
      evt(0, 0, 8, "silent", 0, 0.19),
      evt(1, 8, 16, "speak", 64, 0.551),
      evt(2, 16, 24, "silent", 0, 0.25),
    ];
    const d = deriveDashboard(events);

    // stream-minutes: 3 x 8s = 24s = 0.4 min
    expect(d.streamSeconds).toBe(24);
    expect(d.streamMinutes).toBeCloseTo(0.4, 5);
    // tokens-avoided: saved = dense(400) - visual(100) = 300 per window
    expect(d.tokensAvoided).toBe(900);
    // sparkline in stream order
    expect(d.spark.map((p) => p.decision)).toEqual([
      "silent",
      "speak",
      "silent",
    ]);
    expect(d.spark.map((p) => p.pSpeak)).toEqual([0.19, 0.551, 0.25]);
    // latest window is the final event
    expect(d.latest?.seq).toBe(2);
    expect(d.metrics.windows).toBe(3);
    expect(d.metrics.silentWindows).toBe(2);
    expect(d.metrics.speakWindows).toBe(1);
  });

  it("returns zeroed dashboard for an empty session", () => {
    const d = deriveDashboard([]);
    expect(d.streamMinutes).toBe(0);
    expect(d.tokensAvoided).toBe(0);
    expect(d.spark).toEqual([]);
    expect(d.latest).toBeNull();
    expect(d.metrics.windows).toBe(0);
  });
});

describe("acceptance: static vs eventful stream", () => {
  // A mostly-static/eventful stream of 8s windows, 960x540 coded (dense=400).
  const staticStream = Array.from({ length: 30 }, (_, i) =>
    evt(i, i * 8, i * 8 + 8, "silent", 0, 0.1 + (i % 10) * 0.02),
  );
  const eventfulStream = Array.from({ length: 30 }, (_, i) =>
    evt(
      i,
      i * 8,
      i * 8 + 8,
      i % 5 === 0 ? "speak" : "silent",
      i % 5 === 0 ? 200 : 0,
      i % 5 === 0 ? 0.6 + (i % 3) * 0.1 : 0.2,
    ),
  );

  it("mostly-static: near-zero generated tokens + high savings % while live", () => {
    const d = deriveDashboard(staticStream);
    expect(d.metrics.tokensGeneratedTotal).toBe(0);
    expect(d.metrics.silentWindows).toBe(30);
    expect(d.metrics.speakWindows).toBe(0);
    expect(d.metrics.savedVsBaseline).toBeGreaterThan(0.7);
    expect(d.spark.every((p) => p.decision === "silent")).toBe(true);
  });

  it("eventful/moving: shows the VLM firing (substantial generated tokens)", () => {
    const d = deriveDashboard(eventfulStream);
    expect(d.metrics.speakWindows).toBe(6); // i % 5==0 over 30 windows
    expect(d.metrics.tokensGeneratedTotal).toBeGreaterThan(500);
    expect(d.spark.some((p) => p.decision === "speak")).toBe(true);
  });
});
